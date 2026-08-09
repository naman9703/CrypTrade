#!/usr/bin/env python3
"""
Offline Supertrend XGB train + score for research harness.

Reads JSON: { rows: [...], flips: [{idx, ts, features, side}], ... }
Writes: { threshold, oos, val, train, probs_by_idx, meta }

Optimize threshold for OOS PF >= 1 with keep_frac >= min_keep and kept >= min_kept.
Falls back to best OOS PF under constraints if none reach PF>=1.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

COLS = [
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


def feat_vec(feats: dict) -> list[float]:
    out = []
    for k in COLS:
        try:
            v = float(feats.get(k, 0.0))
        except (TypeError, ValueError):
            v = 0.0
        if not np.isfinite(v):
            v = 0.0
        out.append(v)
    return out


def make_model(scale_pos_weight: float = 1.0):
    try:
        from xgboost import XGBClassifier

        return XGBClassifier(
            n_estimators=250,
            max_depth=3,
            learning_rate=0.05,
            subsample=0.85,
            colsample_bytree=0.85,
            reg_lambda=2.0,
            min_child_weight=5,
            scale_pos_weight=scale_pos_weight,
            objective="binary:logistic",
            eval_metric="logloss",
            random_state=42,
        ), "XGBClassifier"
    except Exception:
        from sklearn.ensemble import HistGradientBoostingClassifier

        return (
            HistGradientBoostingClassifier(
                max_depth=3,
                learning_rate=0.05,
                max_iter=250,
                l2_regularization=1.0,
                random_state=42,
            ),
            "HistGradientBoostingClassifier",
        )


def metrics(y, p, r, thr):
    keep = p >= thr
    ky = y[keep]
    n = int(ky.size)
    if n == 0:
        return {"kept": 0, "keep_frac": 0.0, "wr": None, "mean_r": None, "pf": None, "sum_r": 0.0}
    wr = float(np.mean(ky))
    kr = r[keep]
    pos = float(np.sum(kr[kr > 0]))
    neg = float(np.sum(kr[kr < 0]))
    pf = (pos / -neg) if neg < 0 else (99.0 if pos > 0 else 0.0)
    return {
        "kept": n,
        "keep_frac": float(n / y.size) if y.size else 0.0,
        "wr": wr,
        "mean_r": float(np.mean(kr)),
        "pf": pf,
        "sum_r": float(np.sum(kr)),
    }


def pick_threshold(y, p, r, *, min_keep=0.35, min_kept=25, prefer_pf=1.0):
    """Prefer thr with PF>=prefer_pf, max mean_r, among keep>=min_keep & kept>=min_kept."""
    cands = []
    for thr_i in range(5, 96):
        thr = thr_i / 100.0
        m = metrics(y, p, r, thr)
        if m["kept"] < min_kept or m["keep_frac"] < min_keep:
            continue
        cands.append((thr, m))
    if not cands:
        # relax
        for thr_i in range(5, 96):
            thr = thr_i / 100.0
            m = metrics(y, p, r, thr)
            if m["kept"] < 15:
                continue
            cands.append((thr, m))
    if not cands:
        return float(np.quantile(p, 0.5)), metrics(y, p, r, float(np.quantile(p, 0.5)))

    green = [(t, m) for t, m in cands if (m["pf"] or 0) >= prefer_pf and (m["mean_r"] or 0) > 0]
    pool = green if green else cands

    def score(item):
        t, m = item
        pf = m["pf"] or 0
        mr = m["mean_r"] or 0
        # prioritize PF then mean R then keep (avoid starve)
        return (pf, mr, m["keep_frac"])

    best = max(pool, key=score)
    return best[0], best[1]


def main():
    inp = Path(sys.argv[1])
    outp = Path(sys.argv[2])
    payload = json.loads(inp.read_text())
    rows = sorted(payload["rows"], key=lambda r: int(r["entry_ts"]))
    X, y, rr = [], [], []
    for row in rows:
        X.append(feat_vec(row["features"]))
        y.append(int(row["label"]))
        r = row.get("rr")
        try:
            rv = float(r)
        except (TypeError, ValueError):
            rv = 1.0 if int(row["label"]) == 1 else -1.0
        if not np.isfinite(rv):
            rv = 1.0 if int(row["label"]) == 1 else -1.0
        rr.append(rv)
    X = np.asarray(X, dtype=np.float64)
    y = np.asarray(y, dtype=int)
    rr = np.asarray(rr, dtype=np.float64)
    n = X.shape[0]
    i1 = max(1, int(n * 0.6))
    i2 = max(i1 + 1, int(n * 0.8))
    if i2 >= n:
        i2 = n - 1

    Xtr, ytr, rtr = X[:i1], y[:i1], rr[:i1]
    Xva, yva, rva = X[i1:i2], y[i1:i2], rr[i1:i2]
    Xoo, yoo, roo = X[i2:], y[i2:], rr[i2:]

    pos = max(1, int(np.sum(ytr == 1)))
    neg = max(1, int(np.sum(ytr == 0)))
    spw = neg / pos
    model, name = make_model(scale_pos_weight=spw)
    model.fit(Xtr, ytr)

    def proba(Xm):
        if hasattr(model, "predict_proba"):
            return model.predict_proba(Xm)[:, 1]
        # decision_function fallback
        raw = model.decision_function(Xm)
        return 1.0 / (1.0 + np.exp(-raw))

    ptr, pva, poo = proba(Xtr), proba(Xva), proba(Xoo)

    # pick on VAL for honesty; report OOS
    thr, val_m = pick_threshold(yva, pva, rva, min_keep=0.35, min_kept=20, prefer_pf=1.0)
    # also search thr that max OOS PF under constraints (diagnostic only — primary is val-picked)
    thr_oos_oracle, oos_oracle_m = pick_threshold(yoo, poo, roo, min_keep=0.35, min_kept=15, prefer_pf=1.0)

    oos_m = metrics(yoo, poo, roo, thr)
    tr_m = metrics(ytr, ptr, rtr, thr)

    # Score all flip candidates for full-window re-sim
    flips = payload.get("flips") or []
    probs_by_idx = {}
    if flips:
        XF = np.asarray([feat_vec(f["features"]) for f in flips], dtype=np.float64)
        pf = proba(XF)
        for f, p in zip(flips, pf):
            probs_by_idx[str(int(f["idx"]))] = float(p)

    # Also try a grid of thresholds for full trade-set harvest PF (diagnostic)
    grid = []
    for thr_i in range(10, 91, 2):
        t = thr_i / 100.0
        grid.append({"thr": t, "oos": metrics(yoo, poo, roo, t), "val": metrics(yva, pva, rva, t)})

    out = {
        "model": name,
        "n": n,
        "splits": {"train": int(i1), "val": int(i2 - i1), "oos": int(n - i2)},
        "scale_pos_weight": spw,
        "threshold_val_picked": thr,
        "threshold_oos_oracle": thr_oos_oracle,
        "train": tr_m,
        "val": val_m,
        "oos": oos_m,
        "oos_oracle": oos_oracle_m,
        "grid": grid,
        "probs_by_idx": probs_by_idx,
        "train_end_ts": int(rows[i2 - 1]["entry_ts"]) if i2 > 0 else None,
        "feature_importance": [],
    }
    imp = getattr(model, "feature_importances_", None)
    if imp is not None:
        pairs = [{"feature": COLS[i], "importance": float(imp[i])} for i in range(len(COLS))]
        pairs.sort(key=lambda x: -x["importance"])
        out["feature_importance"] = pairs[:12]

    outp.write_text(json.dumps(out))
    print(json.dumps({k: out[k] for k in ("model", "n", "splits", "threshold_val_picked", "val", "oos", "oos_oracle")}, indent=2))


if __name__ == "__main__":
    main()
