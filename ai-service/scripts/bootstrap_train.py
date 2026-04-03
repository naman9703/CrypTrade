from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.main import FEATURE_COLUMNS, build_features, save_model


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", type=int, default=3000)
    ap.add_argument("--horizon", type=int, default=10)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--start-price", type=float, default=60_000.0)
    args = ap.parse_args()

    rng = np.random.default_rng(args.seed)
    n = int(args.rows)
    horizon = int(args.horizon)

    close = np.empty(n, dtype=float)
    close[0] = float(args.start_price)
    vol = 1.0
    for i in range(1, n):
        vol = 0.95 * vol + 0.05 * (0.5 + rng.random() * 2.0)
        step = rng.normal(0, 40 * vol)
        close[i] = max(50.0, close[i - 1] + step)

    open_ = np.roll(close, 1)
    open_[0] = close[0]
    high = np.maximum(open_, close) + rng.random(n) * 20
    low = np.minimum(open_, close) - rng.random(n) * 20
    volume = 10 + rng.random(n) * 50

    candles = pd.DataFrame(
        {"ts": np.arange(n, dtype=int), "open": open_, "high": high, "low": low, "close": close, "volume": volume}
    )
    future_close = candles["close"].shift(-horizon)
    y = (future_close > candles["close"]).astype(int).fillna(0).to_numpy(dtype=int)
    X = build_features(candles)[FEATURE_COLUMNS].to_numpy()

    try:
        from xgboost import XGBClassifier  # type: ignore

        model = XGBClassifier(
            n_estimators=350,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.9,
            colsample_bytree=0.9,
            reg_lambda=1.0,
            objective="binary:logistic",
            eval_metric="logloss",
            random_state=42,
        )
    except Exception:
        model = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, random_state=42)
    model.fit(X, y)
    save_model(model)

    print(
        {
            "trained_rows": int(X.shape[0]),
            "horizon": horizon,
            "positive_rate": float(np.mean(y)) if len(y) else 0.0,
        }
    )


if __name__ == "__main__":
    main()

