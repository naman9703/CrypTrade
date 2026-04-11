#!/usr/bin/env python3
"""
Train SurfPulse ML (8-feature XGBoost / HistGradientBoosting) for /predict/surfpulse.

Uses the guide's labeling when Binance 1m data is available; otherwise sklearn synthetic data
so the pipeline always produces ai-service/data/model/surfpulse_xgb.pkl (or MODEL_DIR).

Saves with stdlib pickle (no joblib required). The AI service loads via joblib or pickle.

Requires: numpy, pandas, scikit-learn; xgboost recommended (matches strategy guide).
The script uses XGBClassifier when `import xgboost` succeeds; otherwise HistGradientBoostingClassifier.
Install (SurfPulse + XGBoost): python3 -m pip install --no-cache-dir -r requirements-train-surfpulse.txt
Install (minimal, no XGBoost wheel): python3 -m pip install --no-cache-dir -r requirements-train-surfpulse-minimal.txt
Full AI service: python3 -m pip install --no-cache-dir -r requirements.txt
If you see "No space left on device": free disk space, `pip3 cache purge`, retry with --no-cache-dir.
"""
from __future__ import annotations

import json
import os
import pickle
import sys
import urllib.request
from pathlib import Path

try:
    import numpy as np
    import pandas as pd
except ImportError as e:
    print(
        "Missing numpy/pandas. Run:\n"
        "  cd ai-service && python3 -m pip install --no-cache-dir -r requirements-train-surfpulse.txt",
        file=sys.stderr,
    )
    raise SystemExit(1) from e

ROOT = Path(__file__).resolve().parents[1]

# Keep in sync with ai-service/app/main.py SURF_PULSE_FEATURE_COLUMNS
SURF_PULSE_FEATURE_COLUMNS = [
    "ema20",
    "ema50",
    "adx",
    "rsi",
    "atr",
    "vol_ratio",
    "body_size",
    "ema_diff",
]


def get_model_dir() -> Path:
    return Path(os.getenv("MODEL_DIR", str(ROOT / "data" / "model"))).resolve()


def save_surfpulse_pickle(model: object) -> Path:
    d = get_model_dir()
    d.mkdir(parents=True, exist_ok=True)
    out_p = d / "surfpulse_xgb.pkl"
    with open(out_p, "wb") as f:
        pickle.dump(model, f, protocol=pickle.HIGHEST_PROTOCOL)
    return out_p

_XGB_IMPORT_ERROR: str | None = None
try:
    from xgboost import XGBClassifier  # type: ignore

    _HAS_XGB = True
except Exception as _e:
    XGBClassifier = None  # type: ignore
    _HAS_XGB = False
    _XGB_IMPORT_ERROR = f"{type(_e).__name__}: {_e}"

try:
    from sklearn.datasets import make_classification
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.metrics import classification_report
except ImportError as e:
    exe = sys.executable
    print(
        "Missing scikit-learn for this Python interpreter:\n"
        f"  {exe}\n\n"
        "Install into the *same* interpreter (not plain `pip` if that points elsewhere):\n"
        f"  {exe} -m pip install --no-cache-dir -r requirements-train-surfpulse.txt\n\n"
        "Verify:\n"
        f'  "{exe}" -c "import sklearn; print(sklearn.__version__)"\n',
        file=sys.stderr,
    )
    raise SystemExit(1) from e


BINANCE_FUTURES = "https://fapi.binance.com"


def _ema(s: pd.Series, span: int) -> pd.Series:
    return s.ewm(span=span, adjust=False).mean()


def _rsi(s: pd.Series, period: int = 14) -> pd.Series:
    delta = s.diff()
    gain = (delta.where(delta > 0, 0)).rolling(period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(period).mean()
    rs = gain / (loss.replace(0, np.nan))
    out = 100 - (100 / (1 + rs))
    return out.fillna(50.0)


def _atr(h: pd.Series, l: pd.Series, c: pd.Series, period: int = 14) -> pd.Series:
    prev = c.shift(1)
    tr = pd.concat([(h - l), (h - prev).abs(), (l - prev).abs()], axis=1).max(axis=1)
    return tr.rolling(period).mean().bfill().fillna(0.0)


def _adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    h, low, c = df["high"], df["low"], df["close"]
    up = h.diff()
    dn = -low.diff()
    plus_dm = np.where((up > dn) & (up > 0), up, 0.0)
    minus_dm = np.where((dn > up) & (dn > 0), dn, 0.0)
    tr = _atr(h, low, c, period)
    sm_tr = tr.rolling(period).sum()
    sm_plus = pd.Series(plus_dm, index=df.index).rolling(period).sum()
    sm_minus = pd.Series(minus_dm, index=df.index).rolling(period).sum()
    dx = (100 * (sm_plus - sm_minus).abs() / (sm_plus + sm_minus + 1e-10)).fillna(0)
    return dx.rolling(period).mean().fillna(0.0)


def fetch_klines(symbol: str = "BTCUSDT", interval: str = "1m", limit: int = 1500) -> pd.DataFrame | None:
    try:
        url = f"{BINANCE_FUTURES}/fapi/v1/klines?symbol={symbol}&interval={interval}&limit={limit}"
        with urllib.request.urlopen(url, timeout=30) as r:
            raw = json.loads(r.read().decode())
        rows = []
        for o in raw:
            rows.append(
                {
                    "open": float(o[1]),
                    "high": float(o[2]),
                    "low": float(o[3]),
                    "close": float(o[4]),
                    "volume": float(o[5]),
                }
            )
        return pd.DataFrame(rows)
    except Exception:
        return None


def compute_surfpulse_frame(df: pd.DataFrame) -> pd.DataFrame:
    c = df["close"].astype(float)
    h = df["high"].astype(float)
    l = df["low"].astype(float)
    o = df["open"].astype(float)
    v = df["volume"].astype(float)
    out = pd.DataFrame(index=df.index)
    out["ema20"] = _ema(c, 20)
    out["ema50"] = _ema(c, 50)
    out["rsi"] = _rsi(c, 14)
    out["atr"] = _atr(h, l, c, 14)
    out["adx"] = _adx(df.assign(close=c, high=h, low=l), 14)
    vol_ma = v.rolling(20).mean()
    out["vol_ratio"] = (v / (vol_ma + 1e-10)).replace([np.inf, -np.inf], np.nan).fillna(1.0)
    out["body_size"] = (c - o).abs()
    out["ema_diff"] = out["ema20"] - out["ema50"]
    return out


def label_long_guide(df: pd.DataFrame, ind: pd.DataFrame) -> pd.DataFrame:
    """Replay long signals from guide; label win if TP (2 ATR) before SL (1.5 ATR) in 60 bars."""
    signals = []
    n = len(df)
    for i in range(100, n - 61):
        row = ind.iloc[i]
        prev = ind.iloc[i - 1]
        c = df["close"].iloc[i]
        ph = df["high"].iloc[i - 1]
        atrv = float(row["atr"]) or 1e-8
        trend_ok = row["ema20"] > row["ema50"] and row["adx"] > 25
        pullback_ok = abs(c - row["ema20"]) / atrv < 1.5
        atr_ma10 = ind["atr"].iloc[max(0, i - 9) : i + 1].mean()
        entry_ok = (
            c > ph
            and row["vol_ratio"] > 1.5
            and row["rsi"] > 50
            and row["atr"] > atr_ma10
        )
        if not (trend_ok and pullback_ok and entry_ok):
            continue
        entry = c
        sl = entry - 1.5 * atrv
        tp = entry + 2.0 * atrv
        label = -1
        for j in range(i + 1, min(i + 61, n)):
            hi = df["high"].iloc[j]
            lo = df["low"].iloc[j]
            if hi >= tp:
                label = 1
                break
            if lo <= sl:
                label = 0
                break
        if label < 0:
            continue
        signals.append({feat: float(row[feat]) for feat in SURF_PULSE_FEATURE_COLUMNS} | {"label": int(label)})
    return pd.DataFrame(signals)


def main() -> None:
    if _HAS_XGB:
        print("SurfPulse trainer: using XGBoost (XGBClassifier).", file=sys.stderr)
    else:
        print(
            "SurfPulse trainer: XGBoost not available — using sklearn HistGradientBoostingClassifier. "
            f"Reason: {_XGB_IMPORT_ERROR or 'import failed'}. "
            "Install with: pip install xgboost   (or requirements-train-surfpulse.txt)",
            file=sys.stderr,
        )

    df = fetch_klines()
    if df is None or len(df) < 400:
        print("Binance fetch failed or too few rows — using synthetic classification data.", file=sys.stderr)
        X, y = make_classification(
            n_samples=4000,
            n_features=8,
            n_informative=6,
            n_redundant=0,
            random_state=42,
        )
        sig = pd.DataFrame(X, columns=SURF_PULSE_FEATURE_COLUMNS)
        sig["label"] = y
    else:
        ind = compute_surfpulse_frame(df).dropna()
        df = df.loc[ind.index].reset_index(drop=True)
        ind = ind.reset_index(drop=True)
        sig = label_long_guide(df, ind)
        if len(sig) < 80:
            print("Too few guide-matched signals — blending synthetic rows.", file=sys.stderr)
            X, y = make_classification(n_samples=2000, n_features=8, n_informative=5, random_state=43)
            syn = pd.DataFrame(X, columns=SURF_PULSE_FEATURE_COLUMNS)
            syn["label"] = y
            sig = pd.concat([sig, syn], ignore_index=True)

    X = sig[SURF_PULSE_FEATURE_COLUMNS].to_numpy()
    y = sig["label"].to_numpy(dtype=int)
    split = int(len(X) * 0.8)
    X_train, X_test = X[:split], X[split:]
    y_train, y_test = y[:split], y[split:]

    if _HAS_XGB:
        model = XGBClassifier(
            n_estimators=300,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.7,
            eval_metric="logloss",
            random_state=42,
        )
        model.fit(X_train, y_train)
        kind = "XGBClassifier"
    else:
        model = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, random_state=42)
        model.fit(X_train, y_train)
        kind = "HistGradientBoostingClassifier"

    print(classification_report(y_test, model.predict(X_test)))
    out_p = save_surfpulse_pickle(model)
    print(f"Saved {kind} to {out_p} ({out_p.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
