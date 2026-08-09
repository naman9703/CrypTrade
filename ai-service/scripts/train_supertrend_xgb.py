"""
Train Supertrend XGBoost from labeled backtest trade feature rows.

Feature keys must match backend/src/strategy/supertrendXgbFeatures.js.
"""
from __future__ import annotations

import json
import os
import pickle
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np

SUPERTREND_XGB_FEATURE_COLUMNS = [
    "atr14_pct",
    "atr_percentile",
    "adx14",
    "rsi14",
    "dist_ema20_pct",
    "dist_ema50_pct",
    "dist_ema200_pct",
    "ema_stack",
    "vol_vs_avg20",
    "body_pct",
    "upper_wick_pct",
    "lower_wick_pct",
    "dist_swing_high_pct",
    "dist_swing_low_pct",
    "entry_hour_utc",
    "entry_weekday",
    "session",
    "side",
]

ROOT = Path(__file__).resolve().parents[1]


def get_model_dir() -> Path:
    return Path(os.getenv("MODEL_DIR", str(ROOT / "data" / "model"))).resolve()


def model_path() -> Path:
    return get_model_dir() / "supertrend_xgb.pkl"


def meta_path() -> Path:
    return get_model_dir() / "supertrend_xgb_meta.json"


def _make_classifier():
    try:
        from xgboost import XGBClassifier  # type: ignore

        return XGBClassifier(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.9,
            colsample_bytree=0.9,
            reg_lambda=1.0,
            objective="binary:logistic",
            eval_metric="logloss",
            random_state=42,
        ), "XGBClassifier"
    except Exception:
        from sklearn.ensemble import HistGradientBoostingClassifier

        return (
            HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, random_state=42),
            "HistGradientBoostingClassifier",
        )


def _rows_to_xy(rows: list[dict[str, Any]]) -> tuple[np.ndarray, np.ndarray, list[int]]:
    xs: list[list[float]] = []
    ys: list[int] = []
    keep_idx: list[int] = []
    for i, row in enumerate(rows):
        feats = row.get("features") or {}
        y = row.get("label")
        if y is None:
            continue
        try:
            yi = int(y)
        except (TypeError, ValueError):
            continue
        if yi not in (0, 1):
            continue
        vec = []
        ok = True
        for k in SUPERTREND_XGB_FEATURE_COLUMNS:
            try:
                v = float(feats.get(k, 0.0))
            except (TypeError, ValueError):
                v = 0.0
            if not np.isfinite(v):
                ok = False
                break
            vec.append(v)
        if not ok:
            continue
        xs.append(vec)
        ys.append(yi)
        keep_idx.append(i)
    if not xs:
        return np.zeros((0, len(SUPERTREND_XGB_FEATURE_COLUMNS))), np.zeros((0,), dtype=int), []
    return np.asarray(xs, dtype=np.float64), np.asarray(ys, dtype=int), keep_idx


def _split_time(n: int) -> tuple[slice, slice, slice]:
    """60 / 20 / 20 by index order (caller must sort by entry_ts)."""
    if n < 10:
        # tiny: all train, empty val/oos handled by caller
        return slice(0, n), slice(0, 0), slice(0, 0)
    i1 = max(1, int(n * 0.6))
    i2 = max(i1 + 1, int(n * 0.8))
    if i2 >= n:
        i2 = n - 1
    return slice(0, i1), slice(i1, i2), slice(i2, n)


def _metrics(y_true: np.ndarray, y_prob: np.ndarray, rs: np.ndarray | None, thr: float) -> dict[str, Any]:
    if y_true.size == 0:
        return {"n": 0, "wr": None, "mean_r": None, "pf": None, "kept": 0, "keep_frac": None}
    keep = y_prob >= thr
    kept_y = y_true[keep]
    kept_n = int(kept_y.size)
    wr = float(np.mean(kept_y)) if kept_n else None
    mean_r = None
    pf = None
    if rs is not None and kept_n:
        kr = rs[keep]
        mean_r = float(np.mean(kr))
        pos = float(np.sum(kr[kr > 0]))
        neg = float(np.sum(kr[kr < 0]))
        pf = (pos / -neg) if neg < 0 else (99.0 if pos > 0 else 0.0)
    return {
        "n": int(y_true.size),
        "kept": kept_n,
        "keep_frac": float(kept_n / y_true.size) if y_true.size else None,
        "wr": wr,
        "mean_r": mean_r,
        "pf": pf,
    }


def _pick_threshold(y_val: np.ndarray, p_val: np.ndarray, r_val: np.ndarray | None) -> float:
    """Max mean R on kept trades with keep_frac >= 0.5 (anti N-crush)."""
    if y_val.size == 0:
        return 0.55
    best_thr = None
    best_score = -1e18
    for thr_i in range(5, 95):
        thr = thr_i / 100.0
        m = _metrics(y_val, p_val, r_val, thr)
        if m["keep_frac"] is None or m["keep_frac"] < 0.5:
            continue
        score = m["mean_r"] if m["mean_r"] is not None else (m["wr"] or 0.0)
        if score > best_score:
            best_score = score
            best_thr = thr
    if best_thr is not None:
        return float(best_thr)
    # No grid thr kept ≥50% (poorly calibrated probs) — lock to top-50% by score quantile
    return float(np.quantile(p_val, 0.5))


def _importance(model: Any, X: np.ndarray | None = None, y: np.ndarray | None = None) -> list[dict[str, Any]]:
    imp = getattr(model, "feature_importances_", None)
    if imp is None and X is not None and y is not None and X.size and y.size:
        try:
            from sklearn.inspection import permutation_importance

            n = min(X.shape[0], 400)
            r = permutation_importance(
                model, X[:n], y[:n], n_repeats=3, random_state=42, scoring="roc_auc"
            )
            imp = r.importances_mean
        except Exception:
            imp = None
    if imp is None:
        return []
    pairs = [
        {"feature": SUPERTREND_XGB_FEATURE_COLUMNS[i], "importance": float(imp[i])}
        for i in range(min(len(imp), len(SUPERTREND_XGB_FEATURE_COLUMNS)))
    ]
    pairs.sort(key=lambda x: -x["importance"])
    return pairs[:12]


def train_supertrend_from_trades(
    rows: list[dict[str, Any]],
    *,
    source_run_id: str | None = None,
    symbol: str | None = None,
    timeframe: str | None = None,
) -> dict[str, Any]:
    """
    rows: [{ entry_ts, features: {...}, label: 0|1, rr?: float }, ...] sorted by entry_ts.
    """
    sorted_rows = sorted(
        rows,
        key=lambda r: int(r.get("entry_ts") or 0),
    )
    X, y, keep_idx = _rows_to_xy(sorted_rows)
    if X.shape[0] < 40:
        raise ValueError(f"need_at_least_40_labeled_rows got={X.shape[0]}")

    rs = np.array(
        [
            float(sorted_rows[i].get("rr"))
            if sorted_rows[i].get("rr") is not None and np.isfinite(float(sorted_rows[i].get("rr")))
            else (1.0 if y[j] == 1 else -1.0)
            for j, i in enumerate(keep_idx)
        ],
        dtype=np.float64,
    )

    tr, va, oo = _split_time(X.shape[0])
    Xtr, ytr, rtr = X[tr], y[tr], rs[tr]
    Xva, yva, rva = X[va], y[va], rs[va]
    Xoo, yoo, roo = X[oo], y[oo], rs[oo]

    model, kind = _make_classifier()
    model.fit(Xtr, ytr)

    def proba(Xm: np.ndarray) -> np.ndarray:
        if Xm.size == 0:
            return np.zeros((0,), dtype=np.float64)
        return np.asarray(model.predict_proba(Xm)[:, 1], dtype=np.float64)

    p_tr, p_va, p_oo = proba(Xtr), proba(Xva), proba(Xoo)
    thr = _pick_threshold(yva, p_va, rva) if yva.size else 0.55

    train_end_ts = None
    if keep_idx and tr.stop > tr.start:
        last_tr = keep_idx[tr.stop - 1]
        train_end_ts = int(sorted_rows[last_tr].get("entry_ts") or 0) or None

    meta = {
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "model_kind": kind,
        "feature_columns": list(SUPERTREND_XGB_FEATURE_COLUMNS),
        "threshold": float(thr),
        "source_run_id": source_run_id,
        "symbol": symbol,
        "timeframe": timeframe,
        "train_end_ts": train_end_ts,
        "trained_rows": int(Xtr.shape[0]),
        "positive_rate_train": float(np.mean(ytr)) if ytr.size else None,
        "splits": {
            "train": _metrics(ytr, p_tr, rtr, thr),
            "validation": _metrics(yva, p_va, rva, thr),
            "oos": _metrics(yoo, p_oo, roo, thr),
        },
        "baseline_splits": {
            "train": _metrics(ytr, np.ones_like(p_tr), rtr, 0.0),
            "validation": _metrics(yva, np.ones_like(p_va), rva, 0.0),
            "oos": _metrics(yoo, np.ones_like(p_oo), roo, 0.0),
        },
        "feature_importance": _importance(model, Xtr, ytr),
        "freq_ok_val": bool(
            (_metrics(yva, p_va, rva, thr).get("keep_frac") or 0) >= 0.5
        )
        if yva.size
        else False,
        "oos_pf_ge_1": bool(((_metrics(yoo, p_oo, roo, thr).get("pf") or 0) >= 1) if yoo.size else False),
        "oos_mean_r_positive": bool(
            ((_metrics(yoo, p_oo, roo, thr).get("mean_r") or 0) > 0) if yoo.size else False
        ),
    }

    d = get_model_dir()
    d.mkdir(parents=True, exist_ok=True)
    with open(model_path(), "wb") as f:
        pickle.dump(model, f)
    with open(meta_path(), "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2)

    return meta
