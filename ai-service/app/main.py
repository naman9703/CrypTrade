from __future__ import annotations

import os
import json
import ssl
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal
from email.utils import parsedate_to_datetime
import math
import platform
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
import threading

import joblib
import numpy as np
import pandas as pd
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression

XGBOOST_IMPORT_ERROR: str | None = None
try:
    from xgboost import XGBClassifier  # type: ignore

    XGBOOST_AVAILABLE = True
except Exception as e:
    XGBClassifier = None  # type: ignore
    XGBOOST_AVAILABLE = False
    XGBOOST_IMPORT_ERROR = f"{type(e).__name__}: {e}"

if not XGBOOST_AVAILABLE and os.getenv("AI_SILENCE_XGBOOST_HINT", "").lower() not in ("1", "true", "yes"):
    sys_kind = platform.system()
    if sys_kind == "Darwin":
        fix = "brew install libomp   (then restart the AI service)"
    elif sys_kind == "Linux":
        fix = "sudo apt install libgomp1   (Debian/Ubuntu) or equivalent OpenMP runtime, then restart"
    else:
        fix = "install the OpenMP runtime for your OS (see XGBoost install docs), then restart"
    print(
        f"[ai-service] XGBoost unavailable — training uses HistGradientBoosting instead. "
        f"Reason: {XGBOOST_IMPORT_ERROR}. Fix: {fix}",
        file=sys.stderr,
    )

load_dotenv()

MODEL_DIR = Path(os.getenv("MODEL_DIR", "./data/model")).resolve()
FEEDBACK_CSV = Path(os.getenv("FEEDBACK_CSV", "./data/feedback/trades.csv")).resolve()
LABEL_HORIZON_MIN = int(os.getenv("LABEL_HORIZON_MIN", "10"))
FEEDBACK_HALF_LIFE_DAYS = float(os.getenv("FEEDBACK_HALF_LIFE_DAYS", "14"))
FEEDBACK_REQUIRE_NONZERO_PNL = os.getenv("FEEDBACK_REQUIRE_NONZERO_PNL", "1") != "0"


def _float_env(key: str, default: float) -> float:
    try:
        return float(os.getenv(key, str(default)))
    except ValueError:
        return default


# Production training: emphasize recent regimes (0 = uniform weights).
TRAIN_RECENCY_HALF_LIFE_DAYS = max(0.0, _float_env("TRAIN_RECENCY_HALF_LIFE_DAYS", 30.0))
# Per-ensemble bagging on train rows (0 = disabled, 0.85–0.92 typical for diversity).
TRAIN_ENSEMBLE_BAG_FRACTION = max(0.0, min(1.0, _float_env("TRAIN_ENSEMBLE_BAG_FRACTION", 0.88)))

# External dataset bases (public; no API keys required)
FEAR_GREED_BASE = os.getenv("FEAR_GREED_BASE", "https://api.alternative.me")
BINANCE_FUTURES_BASE = os.getenv("BINANCE_FUTURES_BASE", "https://fapi.binance.com")
EXTERNAL_CACHE_TTL_SEC = int(os.getenv("EXTERNAL_CACHE_TTL_SEC", "60"))
NEWS_RSS_URLS = [
    u.strip()
    for u in os.getenv(
        "NEWS_RSS_URLS",
        ",".join(
            [
                "https://cointelegraph.com/rss",
                "https://www.coindesk.com/arc/outboundfeeds/rss/",
                "https://decrypt.co/feed",
            ]
        ),
    ).split(",")
    if u.strip()
]

# ─── Feature columns (40 features) ───────────────────────────────────────────
FEATURE_COLUMNS = [
    # Price returns & momentum
    "returns_1m", "returns_5m", "returns_15m", "returns_1h",
    "momentum_10", "momentum_30",
    # Trend (EMA)
    "ema_fast", "ema_slow", "ema_slope",
    "ema_cross_dist",  # normalized distance between fast/slow EMA
    # Multi-timeframe trend context (aggregated from 1m candles)
    "mtf_ema_slope_5m", "mtf_rsi_5m", "mtf_atr_pct_5m",
    "mtf_ema_slope_15m", "mtf_rsi_15m", "mtf_bb_pos_15m",
    # Oscillators
    "rsi_14", "stoch_rsi",
    # MACD
    "macd_line", "macd_signal", "macd_hist", "macd_hist_slope",
    # Bollinger Bands
    "bb_width", "bb_pos",
    # Volatility
    "atr_14", "atr_pct", "hl_range_pct", "volatility_ratio",
    # Volume
    "volume", "volume_spike", "vol_momentum", "obv_slope",
    # Candlestick patterns
    "candle_body_ratio", "upper_wick_ratio", "lower_wick_ratio",
    "engulfing_signal", "pin_bar_signal",
    # Time features (hour of day encoded as sin/cos for cyclical nature)
    "hour_sin", "hour_cos",
    # External datasets (global context)
    "fear_greed",        # normalized [0, 1]
    "btc_funding_rate",  # raw funding rate (e.g. 0.0001)

    # External datasets (news/sentiment)
    "news_sentiment",    # normalized [-1, 1]
    "news_count_24h",    # count of items last 24h (capped)
]

_external_cache: dict[str, Any] = {
    "fear_greed": {"ts": 0.0, "value": 0.5},
    "btc_funding": {"ts": 0.0, "value": 0.0},
    "fear_greed_series": {"ts": 0.0, "df": None},
    "btc_funding_series": {"ts": 0.0, "df": None},
    "news_latest": {"ts": 0.0, "sent": 0.0, "count24h": 0},
    "news_series": {"ts": 0.0, "df": None},
}


def _ensure_dirs() -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    FEEDBACK_CSV.parent.mkdir(parents=True, exist_ok=True)


def _ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False).mean()


def _rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = (delta.where(delta > 0, 0)).rolling(period).mean()
    loss = (-delta.where(delta < 0, 0)).rolling(period).mean()
    rs = gain / (loss.replace(0, np.nan))
    out = 100 - (100 / (1 + rs))
    return out.fillna(50.0)


def _atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int = 14) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat([(high - low), (high - prev_close).abs(), (low - prev_close).abs()], axis=1).max(axis=1)
    return tr.rolling(period).mean().bfill().fillna(0.0)


def _resample_ohlcv(df: pd.DataFrame, n: int) -> pd.DataFrame:
    """Resample 1-minute OHLCV into n-minute bars using integer grouping."""
    idx = np.arange(len(df)) // n
    g = df.groupby(idx)
    return pd.DataFrame({
        "open": g["open"].first(),
        "high": g["high"].max(),
        "low": g["low"].min(),
        "close": g["close"].last(),
        "volume": g["volume"].sum(),
    }).reset_index(drop=True)


def build_features(candles: pd.DataFrame) -> pd.DataFrame:
    df = candles.copy()
    if "close" not in df.columns:
        raise ValueError("candles must include close")

    close = df["close"].astype(float)
    high = df.get("high", close).astype(float)
    low = df.get("low", close).astype(float)
    opn = df.get("open", close).astype(float)
    vol = df.get("volume", pd.Series(np.zeros(len(df)), dtype=float)).astype(float)

    # ── Price returns & momentum ──
    df["returns_1m"] = close.pct_change().fillna(0.0)
    df["returns_5m"] = close.pct_change(5).fillna(0.0)
    df["returns_15m"] = close.pct_change(15).fillna(0.0)
    df["returns_1h"] = close.pct_change(60).fillna(0.0)
    df["momentum_10"] = close.pct_change(10).fillna(0.0)
    df["momentum_30"] = close.pct_change(30).fillna(0.0)

    # ── Trend (EMA) ──
    ema_fast = _ema(close, span=12)
    ema_slow = _ema(close, span=26)
    df["ema_fast"] = ema_fast
    df["ema_slow"] = ema_slow
    df["ema_slope"] = (
        (ema_fast - ema_fast.shift(3)) / (ema_fast.shift(3).abs() + 1e-10)
    ).fillna(0.0)
    df["ema_cross_dist"] = ((ema_fast - ema_slow) / (close + 1e-10)).fillna(0.0)

    # ── Multi-timeframe context (built from 1m candles) ──
    if len(df) >= 30:
        bars_5m = _resample_ohlcv(df[["open", "high", "low", "close", "volume"]], 5)
        ema5m_fast = _ema(bars_5m["close"], span=12)
        df["mtf_ema_slope_5m"] = np.repeat(
            ((ema5m_fast - ema5m_fast.shift(2)) / (ema5m_fast.shift(2).abs() + 1e-10)).fillna(0.0).values,
            5,
        )[: len(df)]
        rsi_5m = _rsi(bars_5m["close"], 14)
        df["mtf_rsi_5m"] = np.repeat(rsi_5m.values, 5)[: len(df)]
        atr_5m = _atr(bars_5m["high"], bars_5m["low"], bars_5m["close"], 14)
        df["mtf_atr_pct_5m"] = np.repeat(
            (atr_5m / (bars_5m["close"] + 1e-10)).fillna(0.0).values, 5
        )[: len(df)]
    else:
        df["mtf_ema_slope_5m"] = 0.0
        df["mtf_rsi_5m"] = 50.0
        df["mtf_atr_pct_5m"] = 0.0

    if len(df) >= 60:
        bars_15m = _resample_ohlcv(df[["open", "high", "low", "close", "volume"]], 15)
        ema15m_fast = _ema(bars_15m["close"], span=12)
        ema15m_slow = _ema(bars_15m["close"], span=26)
        df["mtf_ema_slope_15m"] = np.repeat(
            ((ema15m_fast - ema15m_fast.shift(2)) / (ema15m_fast.shift(2).abs() + 1e-10)).fillna(0.0).values,
            15,
        )[: len(df)]
        rsi_15m = _rsi(bars_15m["close"], 14)
        df["mtf_rsi_15m"] = np.repeat(rsi_15m.values, 15)[: len(df)]
        sma20_15m = bars_15m["close"].rolling(20, min_periods=1).mean()
        std20_15m = bars_15m["close"].rolling(20, min_periods=1).std().fillna(0.0)
        bb_upper_15m = sma20_15m + 2 * std20_15m
        bb_lower_15m = sma20_15m - 2 * std20_15m
        bb_pos_15m = ((bars_15m["close"] - bb_lower_15m) / (bb_upper_15m - bb_lower_15m + 1e-10)).fillna(0.5)
        df["mtf_bb_pos_15m"] = np.repeat(bb_pos_15m.values, 15)[: len(df)]
    else:
        df["mtf_ema_slope_15m"] = 0.0
        df["mtf_rsi_15m"] = 50.0
        df["mtf_bb_pos_15m"] = 0.5

    # ── Oscillators ──
    rsi_14 = _rsi(close, period=14)
    df["rsi_14"] = rsi_14
    rsi_min = rsi_14.rolling(14, min_periods=1).min()
    rsi_max = rsi_14.rolling(14, min_periods=1).max()
    df["stoch_rsi"] = ((rsi_14 - rsi_min) / (rsi_max - rsi_min + 1e-10)).fillna(0.5)

    # ── MACD ──
    macd_line = ema_fast - ema_slow
    macd_signal = _ema(macd_line, span=9)
    macd_hist = macd_line - macd_signal
    df["macd_line"] = macd_line
    df["macd_signal"] = macd_signal
    df["macd_hist"] = macd_hist
    df["macd_hist_slope"] = (macd_hist - macd_hist.shift(3)).fillna(0.0)

    # ── Bollinger Bands ──
    sma20 = close.rolling(20, min_periods=1).mean()
    std20 = close.rolling(20, min_periods=1).std().fillna(0.0)
    bb_upper = sma20 + 2 * std20
    bb_lower = sma20 - 2 * std20
    df["bb_width"] = ((bb_upper - bb_lower) / (sma20 + 1e-10)).fillna(0.0)
    df["bb_pos"] = ((close - bb_lower) / (bb_upper - bb_lower + 1e-10)).fillna(0.5)

    # ── Volatility ──
    atr_14 = _atr(high=high, low=low, close=close, period=14)
    df["atr_14"] = atr_14
    df["atr_pct"] = (atr_14 / (close + 1e-10)).fillna(0.0)
    df["hl_range_pct"] = ((high - low) / (close + 1e-10)).fillna(0.0)
    # Short-term vs long-term volatility ratio
    atr_5 = _atr(high=high, low=low, close=close, period=5)
    atr_20 = _atr(high=high, low=low, close=close, period=20)
    df["volatility_ratio"] = (atr_5 / (atr_20 + 1e-10)).fillna(1.0)

    # ── Volume ──
    df["volume"] = vol
    vol_sma20 = vol.rolling(20, min_periods=1).mean()
    df["volume_spike"] = (vol / (vol_sma20 + 1e-10)).replace(
        [np.inf, -np.inf], np.nan
    ).fillna(1.0)
    vol_sma10_lag = vol.rolling(10, min_periods=1).mean().shift(5)
    df["vol_momentum"] = (vol / (vol_sma10_lag + 1e-10) - 1).replace(
        [np.inf, -np.inf], np.nan
    ).fillna(0.0)
    # On-balance volume slope (normalized)
    obv = (np.sign(close.diff().fillna(0)) * vol).cumsum()
    obv_slope = (obv - obv.shift(10)) / (close * 10 + 1e-10)
    df["obv_slope"] = obv_slope.fillna(0.0)

    # ── Candlestick patterns ──
    body = (close - opn).abs()
    full_range = (high - low).clip(lower=1e-10)
    df["candle_body_ratio"] = (body / full_range).fillna(0.5)
    df["upper_wick_ratio"] = ((high - pd.concat([close, opn], axis=1).max(axis=1)) / full_range).fillna(0.0)
    df["lower_wick_ratio"] = ((pd.concat([close, opn], axis=1).min(axis=1) - low) / full_range).fillna(0.0)

    # Engulfing: current body fully wraps previous body
    prev_body_high = pd.concat([close.shift(1), opn.shift(1)], axis=1).max(axis=1)
    prev_body_low = pd.concat([close.shift(1), opn.shift(1)], axis=1).min(axis=1)
    curr_body_high = pd.concat([close, opn], axis=1).max(axis=1)
    curr_body_low = pd.concat([close, opn], axis=1).min(axis=1)
    bullish_engulf = ((curr_body_high > prev_body_high) & (curr_body_low < prev_body_low) & (close > opn)).astype(float)
    bearish_engulf = ((curr_body_high > prev_body_high) & (curr_body_low < prev_body_low) & (close < opn)).astype(float)
    df["engulfing_signal"] = (bullish_engulf - bearish_engulf).fillna(0.0)

    # Pin bar: long lower wick (bullish) or long upper wick (bearish)
    bullish_pin = ((df["lower_wick_ratio"] > 0.6) & (df["candle_body_ratio"] < 0.3)).astype(float)
    bearish_pin = ((df["upper_wick_ratio"] > 0.6) & (df["candle_body_ratio"] < 0.3)).astype(float)
    df["pin_bar_signal"] = (bullish_pin - bearish_pin).fillna(0.0)

    # ── Time-of-day features ──
    ts_col = df.get("ts", None)
    if ts_col is not None:
        ts_numeric = pd.to_numeric(ts_col, errors="coerce")
        valid_ts = ts_numeric.notna() & (ts_numeric > 1e9)
        if valid_ts.any():
            # Convert ms timestamps to hours
            hours = (ts_numeric.where(valid_ts, np.nan) / 1000 / 3600) % 24
            df["hour_sin"] = np.sin(2 * np.pi * hours / 24).fillna(0.0)
            df["hour_cos"] = np.cos(2 * np.pi * hours / 24).fillna(0.0)
        else:
            df["hour_sin"] = 0.0
            df["hour_cos"] = 0.0
    else:
        df["hour_sin"] = 0.0
        df["hour_cos"] = 0.0

    # ── Order flow ──
    buy_vol = df.get("buy_volume", None)
    sell_vol = df.get("sell_volume", None)
    if buy_vol is not None and sell_vol is not None:
        df["delta"] = (buy_vol.astype(float) - sell_vol.astype(float)).fillna(0.0)
    else:
        df["delta"] = 0.0

    # ── External datasets (pass-through if provided, else fetch latest) ──
    if "fear_greed" not in df.columns:
        df["fear_greed"] = fetch_fear_greed_latest()
    df["fear_greed"] = pd.to_numeric(df["fear_greed"], errors="coerce").fillna(0.5).clip(0, 1)

    if "btc_funding_rate" not in df.columns:
        df["btc_funding_rate"] = fetch_btc_funding_latest()
    df["btc_funding_rate"] = pd.to_numeric(df["btc_funding_rate"], errors="coerce").fillna(0.0)

    if "news_sentiment" not in df.columns:
        df["news_sentiment"] = fetch_news_latest()[0]
    df["news_sentiment"] = pd.to_numeric(df["news_sentiment"], errors="coerce").fillna(0.0).clip(-1, 1)

    if "news_count_24h" not in df.columns:
        df["news_count_24h"] = fetch_news_latest()[1]
    df["news_count_24h"] = pd.to_numeric(df["news_count_24h"], errors="coerce").fillna(0.0).clip(0, 500)

    feat = df[FEATURE_COLUMNS].replace([np.inf, -np.inf], np.nan).fillna(0.0)
    return feat


# ─── SSL / Binance fetching ──────────────────────────────────────────────────

def _ssl_ctx() -> ssl.SSLContext:
    try:
        import certifi  # type: ignore
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx


def _http_json(url: str, timeout: int = 20) -> Any:
    ctx = _ssl_ctx()
    req = urllib.request.Request(url, headers={"User-Agent": "CryptoBot/1.0"})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return json.loads(resp.read().decode())


def _now_ts() -> float:
    return float(datetime.now(timezone.utc).timestamp())


def fetch_fear_greed_latest() -> float:
    """Alternative.me Fear & Greed Index. Returns normalized value in [0, 1]."""
    c = _external_cache["fear_greed"]
    if _now_ts() - float(c.get("ts", 0)) < EXTERNAL_CACHE_TTL_SEC:
        return float(c.get("value", 0.5))
    out = float(c.get("value", 0.5))
    try:
        data = _http_json(f"{FEAR_GREED_BASE}/fng/?limit=1&format=json")
        v = float((data.get("data") or [{}])[0].get("value"))
        out = max(0.0, min(1.0, v / 100.0))
    except Exception:
        pass
    _external_cache["fear_greed"] = {"ts": _now_ts(), "value": out}
    return out


def fetch_fear_greed_series(limit: int = 2500) -> pd.DataFrame:
    """Returns df with columns: ts_ms, fear_greed(0..1). Cached for training alignment."""
    c = _external_cache["fear_greed_series"]
    if c.get("df") is not None and _now_ts() - float(c.get("ts", 0)) < max(300, EXTERNAL_CACHE_TTL_SEC):
        return c["df"]
    rows = []
    try:
        data = _http_json(f"{FEAR_GREED_BASE}/fng/?limit={int(limit)}&format=json")
        for r in (data.get("data") or []):
            try:
                ts_ms = int(float(r.get("timestamp"))) * 1000
                v = float(r.get("value"))
                rows.append({"ts_ms": ts_ms, "fear_greed": max(0.0, min(1.0, v / 100.0))})
            except Exception:
                continue
    except Exception:
        rows = []
    df = pd.DataFrame(rows).sort_values("ts_ms").drop_duplicates("ts_ms")
    if df.empty:
        df = pd.DataFrame([{"ts_ms": 0, "fear_greed": 0.5}])
    _external_cache["fear_greed_series"] = {"ts": _now_ts(), "df": df}
    return df


def fetch_btc_funding_latest() -> float:
    """Latest BTCUSDT perpetual funding rate from Binance futures."""
    c = _external_cache["btc_funding"]
    if _now_ts() - float(c.get("ts", 0)) < EXTERNAL_CACHE_TTL_SEC:
        return float(c.get("value", 0.0))
    out = float(c.get("value", 0.0))
    try:
        params = urllib.parse.urlencode({"symbol": "BTCUSDT", "limit": 1})
        data = _http_json(f"{BINANCE_FUTURES_BASE}/fapi/v1/fundingRate?{params}")
        if isinstance(data, list) and data:
            out = float(data[0].get("fundingRate", 0.0))
    except Exception:
        pass
    _external_cache["btc_funding"] = {"ts": _now_ts(), "value": out}
    return out


def fetch_btc_funding_series(start_ms: int, end_ms: int) -> pd.DataFrame:
    """Funding series df: ts_ms, btc_funding_rate. Cached for training alignment."""
    c = _external_cache["btc_funding_series"]
    cache_key = f"{start_ms}_{end_ms}"
    if (
        c.get("df") is not None
        and c.get("key") == cache_key
        and _now_ts() - float(c.get("ts", 0)) < max(300, EXTERNAL_CACHE_TTL_SEC)
    ):
        return c["df"]
    rows = []
    cur = int(start_ms)
    try:
        while cur < int(end_ms):
            params = {
                "symbol": "BTCUSDT",
                "startTime": cur,
                "endTime": int(end_ms),
                "limit": 1000,
            }
            url = f"{BINANCE_FUTURES_BASE}/fapi/v1/fundingRate?{urllib.parse.urlencode(params)}"
            data = _http_json(url)
            if not isinstance(data, list) or not data:
                break
            for r in data:
                try:
                    ts_ms = int(r.get("fundingTime"))
                    fr = float(r.get("fundingRate", 0.0))
                    rows.append({"ts_ms": ts_ms, "btc_funding_rate": fr})
                except Exception:
                    continue
            last_ts = int(data[-1].get("fundingTime", cur))
            cur = max(cur + 1, last_ts + 1)
            if len(data) < 1000:
                break
    except Exception:
        rows = rows
    df = pd.DataFrame(rows).sort_values("ts_ms").drop_duplicates("ts_ms")
    if df.empty:
        df = pd.DataFrame([{"ts_ms": 0, "btc_funding_rate": 0.0}])
    _external_cache["btc_funding_series"] = {"ts": _now_ts(), "df": df, "key": cache_key}
    return df


_POS_WORDS = {
    "surge", "soar", "soars", "rally", "rallies", "bull", "bullish", "breakout", "up", "gain", "gains",
    "record", "approve", "approval", "adoption", "partnership", "upgrade", "launch", "buy", "buying",
    "inflows", "growth", "positive", "win", "wins",
}
_NEG_WORDS = {
    "crash", "plunge", "dump", "bear", "bearish", "down", "loss", "losses", "lawsuit", "hack", "hacked",
    "exploit", "ban", "banned", "fraud", "scam", "collapse", "liquidation", "liquidations", "outflows",
    "negative", "fear", "sell", "selling",
}


def _score_text_sentiment(text: str) -> float:
    """
    Lightweight lexicon sentiment score in [-1, 1] based on headline keywords.
    Not perfect, but stable, fast, and no extra dependencies.
    """
    if not text:
        return 0.0
    s = text.lower()
    s = re.sub(r"[^a-z0-9\\s\\-]", " ", s)
    toks = [t for t in s.split() if t]
    if not toks:
        return 0.0
    pos = sum(1 for t in toks if t in _POS_WORDS)
    neg = sum(1 for t in toks if t in _NEG_WORDS)
    raw = pos - neg
    # normalize by headline length (soft)
    denom = max(3, min(20, len(toks)))
    score = raw / denom
    return float(max(-1.0, min(1.0, score * 3.0)))


def fetch_news_items() -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for url in NEWS_RSS_URLS:
        try:
            raw = urllib.request.urlopen(
                urllib.request.Request(url, headers={"User-Agent": "CryptoBot/1.0"}),
                timeout=15,
                context=_ssl_ctx(),
            ).read()
            root = ET.fromstring(raw)
            for it in root.findall(".//item"):
                title = (it.findtext("title") or "").strip()
                pub = (it.findtext("pubDate") or it.findtext("{http://purl.org/dc/elements/1.1/}date") or "").strip()
                ts_ms = None
                if pub:
                    try:
                        dt = parsedate_to_datetime(pub)
                        if dt.tzinfo is None:
                            dt = dt.replace(tzinfo=timezone.utc)
                        ts_ms = int(dt.timestamp() * 1000)
                    except Exception:
                        ts_ms = None
                if not title:
                    continue
                items.append({"ts_ms": ts_ms, "title": title})
        except Exception:
            continue
    # drop items without timestamps (can’t align); keep for latest sentiment fallback
    return items


def fetch_news_latest() -> tuple[float, int]:
    c = _external_cache["news_latest"]
    if _now_ts() - float(c.get("ts", 0)) < EXTERNAL_CACHE_TTL_SEC:
        return float(c.get("sent", 0.0)), int(c.get("count24h", 0))
    try:
        items = fetch_news_items()
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        recent = [it for it in items if it.get("ts_ms") and now_ms - int(it["ts_ms"]) <= 24 * 3600 * 1000]
        scores = [_score_text_sentiment(str(it.get("title", ""))) for it in recent]
        sent = float(np.mean(scores)) if scores else 0.0
        cnt = int(len(recent))
    except Exception:
        sent = float(c.get("sent", 0.0))
        cnt = int(c.get("count24h", 0))
    _external_cache["news_latest"] = {"ts": _now_ts(), "sent": sent, "count24h": cnt}
    return sent, cnt


def fetch_news_series(start_ms: int, end_ms: int) -> pd.DataFrame:
    """
    Build an hourly time series of news sentiment and 24h item count.
    Returns df: ts_ms (hour bucket), news_sentiment, news_count_24h
    """
    c = _external_cache["news_series"]
    cache_key = f"{start_ms}_{end_ms}"
    if (
        c.get("df") is not None
        and c.get("key") == cache_key
        and _now_ts() - float(c.get("ts", 0)) < max(300, EXTERNAL_CACHE_TTL_SEC)
    ):
        return c["df"]

    items = fetch_news_items()
    # keep items with timestamps
    rows = []
    for it in items:
        ts = it.get("ts_ms")
        if ts is None:
            continue
        t = int(ts)
        if t < start_ms - 3 * 24 * 3600 * 1000 or t > end_ms + 3 * 24 * 3600 * 1000:
            continue
        rows.append({"ts_ms": t, "score": _score_text_sentiment(str(it.get("title", "")))})
    if not rows:
        sent, cnt = fetch_news_latest()
        df = pd.DataFrame([{"ts_ms": 0, "news_sentiment": sent, "news_count_24h": cnt}])
        _external_cache["news_series"] = {"ts": _now_ts(), "df": df, "key": cache_key}
        return df

    df0 = pd.DataFrame(rows).sort_values("ts_ms")
    df0["hour_ms"] = (df0["ts_ms"] // (3600 * 1000)) * (3600 * 1000)
    hourly = df0.groupby("hour_ms")["score"].mean().reset_index().rename(columns={"hour_ms": "ts_ms", "score": "news_sentiment"})

    # 24h rolling count by hour bucket
    hourly["news_count_24h"] = 0
    hour_ts = hourly["ts_ms"].to_numpy(dtype="int64")
    # count articles in trailing 24h for each hour bucket
    item_ts = df0["ts_ms"].to_numpy(dtype="int64")
    j0 = 0
    for i in range(len(hour_ts)):
        t = hour_ts[i]
        while j0 < len(item_ts) and item_ts[j0] < t - 24 * 3600 * 1000:
            j0 += 1
        # items up to current hour
        j1 = np.searchsorted(item_ts, t + 1, side="right")
        hourly.at[i, "news_count_24h"] = int(max(0, j1 - j0))

    hourly["news_count_24h"] = hourly["news_count_24h"].clip(lower=0, upper=500)
    _external_cache["news_series"] = {"ts": _now_ts(), "df": hourly, "key": cache_key}
    return hourly


def enrich_with_external_features(df: pd.DataFrame) -> pd.DataFrame:
    """Add external dataset features aligned to candle timestamps (ts ms)."""
    out = df.copy()
    ts = pd.to_numeric(out.get("ts", None), errors="coerce")
    if ts is None or ts.isna().all():
        out["fear_greed"] = 0.5
        out["btc_funding_rate"] = 0.0
        out["news_sentiment"] = 0.0
        out["news_count_24h"] = 0
        return out

    ts_ms = ts.fillna(0).astype("int64")
    start_ms = int(ts_ms.min())
    end_ms = int(ts_ms.max())

    base = pd.DataFrame({"ts_ms": ts_ms}).sort_values("ts_ms")

    fg = fetch_fear_greed_series(limit=2500).rename(columns={"ts_ms": "ext_ts_ms"}).sort_values("ext_ts_ms")
    fg_aligned = pd.merge_asof(base, fg, left_on="ts_ms", right_on="ext_ts_ms", direction="backward")
    fear_vals = fg_aligned["fear_greed"].fillna(fetch_fear_greed_latest()).to_numpy()

    # include a small lookback so earliest candles can still find a funding point
    fr = fetch_btc_funding_series(start_ms=max(0, start_ms - 7 * 24 * 3600 * 1000), end_ms=end_ms).rename(columns={"ts_ms": "ext_ts_ms"}).sort_values("ext_ts_ms")
    fr_aligned = pd.merge_asof(base, fr, left_on="ts_ms", right_on="ext_ts_ms", direction="backward")
    fr_vals = fr_aligned["btc_funding_rate"].fillna(fetch_btc_funding_latest()).to_numpy()

    # Restore original ordering
    fear_series = pd.Series(fear_vals, index=base.index).reindex(range(len(out))).fillna(fetch_fear_greed_latest())
    fr_series = pd.Series(fr_vals, index=base.index).reindex(range(len(out))).fillna(fetch_btc_funding_latest())

    out["fear_greed"] = pd.to_numeric(fear_series, errors="coerce").fillna(0.5).clip(0, 1)
    out["btc_funding_rate"] = pd.to_numeric(fr_series, errors="coerce").fillna(0.0)

    # News sentiment (hourly) align
    news = fetch_news_series(start_ms=max(0, start_ms - 7 * 24 * 3600 * 1000), end_ms=end_ms).rename(columns={"ts_ms": "ext_ts_ms"}).sort_values("ext_ts_ms")
    news_aligned = pd.merge_asof(base, news, left_on="ts_ms", right_on="ext_ts_ms", direction="backward")
    ns = news_aligned.get("news_sentiment", pd.Series([0.0] * len(base))).fillna(0.0).to_numpy()
    nc = news_aligned.get("news_count_24h", pd.Series([0] * len(base))).fillna(0).to_numpy()
    ns_series = pd.Series(ns, index=base.index).reindex(range(len(out))).fillna(0.0)
    nc_series = pd.Series(nc, index=base.index).reindex(range(len(out))).fillna(0)
    out["news_sentiment"] = pd.to_numeric(ns_series, errors="coerce").fillna(0.0).clip(-1, 1)
    out["news_count_24h"] = pd.to_numeric(nc_series, errors="coerce").fillna(0).clip(0, 500)
    return out


def fetch_binance_klines(
    symbol: str, interval: str = "1m", total: int = 5000
) -> pd.DataFrame:
    base_url = os.getenv("BINANCE_KLINES_BASE", "https://api.binance.com")
    all_candles: list[list] = []
    end_time: int | None = None
    batch_size = 1000
    ctx = _ssl_ctx()

    while len(all_candles) < total:
        params: dict[str, Any] = {
            "symbol": symbol,
            "interval": interval,
            "limit": min(batch_size, total - len(all_candles)),
        }
        if end_time is not None:
            params["endTime"] = end_time
        url = f"{base_url}/api/v3/klines?{urllib.parse.urlencode(params)}"
        req = urllib.request.Request(url, headers={"User-Agent": "CryptoBot/1.0"})
        with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
            batch = json.loads(resp.read().decode())
        if not batch:
            break
        all_candles = batch + all_candles
        end_time = int(batch[0][0]) - 1
        if len(batch) < batch_size:
            break

    rows = []
    for k in all_candles:
        rows.append({
            "ts": int(k[0]),
            "open": float(k[1]),
            "high": float(k[2]),
            "low": float(k[3]),
            "close": float(k[4]),
            "volume": float(k[5]),
        })
    return pd.DataFrame(rows)


# ─── Regime + stops (mirror backend `regime.js` + `risk.js` for training labels) ─

def _adx_series_js_style(
    high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14
) -> np.ndarray:
    """ADX(14) per candle, aligned to `indicators.js` `adx()`."""
    n = len(close)
    out = np.zeros(n, dtype=float)
    if n < 2:
        return out
    plus_dm: list[float] = []
    minus_dm: list[float] = []
    tr_list: list[float] = []
    for i in range(1, n):
        up_move = float(high[i] - high[i - 1])
        down_move = float(low[i - 1] - low[i])
        plus_dm.append(up_move if up_move > down_move and up_move > 0 else 0.0)
        minus_dm.append(down_move if down_move > up_move and down_move > 0 else 0.0)
        prev_c = float(close[i - 1])
        tr_list.append(
            max(
                float(high[i] - low[i]),
                abs(float(high[i] - prev_c)),
                abs(float(low[i] - prev_c)),
            )
        )
    L = len(tr_list)
    if L == 0:
        return out

    def smooth(arr: list[float]) -> np.ndarray:
        a = np.array(arr, dtype=float)
        r = np.zeros(L)
        s = 0.0
        for i in range(L):
            s += a[i]
            if i >= period:
                s -= a[i - period]
            if i >= period - 1:
                r[i] = s
        return r

    sm_tr = smooth(tr_list)
    sm_plus = smooth(plus_dm)
    sm_minus = smooth(minus_dm)
    dx = np.zeros(L)
    for i in range(L):
        trv = sm_tr[i]
        if trv == 0:
            continue
        p_di = 100.0 * sm_plus[i] / trv
        m_di = 100.0 * sm_minus[i] / trv
        denom = p_di + m_di
        dx[i] = (100.0 * abs(p_di - m_di)) / (denom if denom != 0 else 1.0)

    k = 2.0 / (period + 1)
    prev = float(dx[0])
    for i in range(L):
        v = float(dx[i])
        if i == 0:
            prev = v
        else:
            prev = v * k + prev * (1.0 - k)
        out[i + 1] = prev
    return out


def _regime_hysteresis_series(atr_pct: np.ndarray, adx_s: np.ndarray) -> list[str]:
    """Matches `regime.js` `detectRegime` (hysteresis)."""
    n = len(atr_pct)
    last = "SIDEWAYS"
    types: list[str] = []
    ve, vx, te, tx = 0.012, 0.008, 28.0, 22.0
    for i in range(n):
        ap = float(np.clip(atr_pct[i], 0.0, 0.25))
        adx = float(adx_s[i])
        was_v = last == "VOLATILE"
        was_t = last == "TRENDING"
        if was_v and ap >= vx:
            typ = "VOLATILE"
        elif not was_v and ap > ve:
            typ = "VOLATILE"
        elif was_t and adx >= tx:
            typ = "TRENDING"
        elif not was_t and adx > te:
            typ = "TRENDING"
        else:
            typ = "SIDEWAYS"
        last = typ
        types.append(typ)
    return types


def _stop_dist_and_rr_risk_js(entry: float, raw_atr: float, regime: str) -> tuple[float, float]:
    """Mirrors `risk.js` `riskPlan` stop distance and reward:risk (MIN_RR=2.0)."""
    px = float(entry)
    raw = float(raw_atr)
    is_volatile = regime == "VOLATILE"
    is_trending = regime == "TRENDING"
    if is_volatile:
        stop_dist = max(raw * 2.0, px * 0.012)
    else:
        stop_dist = max(raw * 1.5, px * 0.008)
    min_rr = 2.0
    if is_trending:
        rr = max(2.5, min_rr)
    elif is_volatile:
        rr = max(1.8, min_rr)
    else:
        rr = min_rr
    return stop_dist, rr


# ─── Trade labeling ──────────────────────────────────────────────────────────

def label_trade_outcomes(
    df: pd.DataFrame,
    horizon: int = 60,
    atr_mult: float = 1.0,
    rr: float = 1.6,
) -> np.ndarray:
    """
    Simulate BUY trade outcomes with ATR-based SL/TP + MFE/MAE analysis.
    Returns 1 (TP hit before SL), 0 (SL hit first), -1 (skip).
    """
    close = df["close"].to_numpy(dtype=float)
    high = df["high"].to_numpy(dtype=float)
    low = df["low"].to_numpy(dtype=float)
    atr_vals = (
        _atr(pd.Series(high), pd.Series(low), pd.Series(close), period=14)
        .bfill().fillna(0.0).to_numpy(dtype=float)
    )

    n = len(close)
    labels = np.full(n, -1, dtype=int)

    for i in range(n - horizon):
        entry = close[i]
        a = max(atr_vals[i], entry * 0.003)
        sl_px = entry - a * atr_mult
        tp_px = entry + a * atr_mult * rr

        future_lows = low[i + 1: i + 1 + horizon]
        future_highs = high[i + 1: i + 1 + horizon]

        sl_hits = np.where(future_lows <= sl_px)[0]
        tp_hits = np.where(future_highs >= tp_px)[0]

        sl_first = sl_hits[0] if len(sl_hits) > 0 else horizon + 1
        tp_first = tp_hits[0] if len(tp_hits) > 0 else horizon + 1

        if tp_first < sl_first:
            labels[i] = 1
        elif sl_first < tp_first:
            labels[i] = 0
        elif sl_first <= horizon:
            labels[i] = 0
        else:
            labels[i] = 1 if close[min(i + horizon, n - 1)] > entry else 0

    return labels


def label_trade_outcomes_risk_aligned(
    df: pd.DataFrame,
    horizon: int,
    fee_bps: float = 0.0,
) -> np.ndarray:
    """
    Long-only labels aligned with live bot: `regime.js` hysteresis + `risk.js` stop distances
    (1.5×/2.0× ATR with 0.8%/1.2% floors) and RR (2.0 / 2.5 trending). TP-before-SL path scan.
    `fee_bps`: round-trip taker approximation (×2 sides); if gross TP return < fee_rt → label 0.
    """
    close = df["close"].to_numpy(dtype=float)
    high = df["high"].to_numpy(dtype=float)
    low = df["low"].to_numpy(dtype=float)
    atr_vals = (
        _atr(pd.Series(high), pd.Series(low), pd.Series(close), period=14)
        .bfill().fillna(0.0).to_numpy(dtype=float)
    )
    adx_s = _adx_series_js_style(high, low, close, 14)
    atr_pct = atr_vals / np.maximum(close, 1e-12)
    regimes = _regime_hysteresis_series(atr_pct, adx_s)

    n = len(close)
    labels = np.full(n, -1, dtype=int)
    fee_rt = max(0.0, float(fee_bps)) / 10000.0 * 2.0

    for i in range(n - horizon):
        entry = close[i]
        if not np.isfinite(entry) or entry <= 0:
            continue
        stop_dist, rr = _stop_dist_and_rr_risk_js(entry, float(atr_vals[i]), regimes[i])
        sl_px = entry - stop_dist
        tp_px = entry + stop_dist * rr

        future_lows = low[i + 1 : i + 1 + horizon]
        future_highs = high[i + 1 : i + 1 + horizon]

        sl_hits = np.where(future_lows <= sl_px)[0]
        tp_hits = np.where(future_highs >= tp_px)[0]

        sl_first = sl_hits[0] if len(sl_hits) > 0 else horizon + 1
        tp_first = tp_hits[0] if len(tp_hits) > 0 else horizon + 1

        if tp_first < sl_first:
            gross_ret = (tp_px - entry) / entry
            if fee_rt > 0 and gross_ret < fee_rt:
                labels[i] = 0
            else:
                labels[i] = 1
        elif sl_first < tp_first:
            labels[i] = 0
        elif sl_first <= horizon:
            labels[i] = 0
        else:
            labels[i] = 1 if close[min(i + horizon, n - 1)] > entry else 0

    return labels


def label_trade_outcomes_short(
    df: pd.DataFrame,
    horizon: int,
    fee_bps: float = 0.0,
) -> np.ndarray:
    """Short-side labels: same regime + stop/RR as `label_trade_outcomes_risk_aligned`."""
    close = df["close"].to_numpy(dtype=float)
    high = df["high"].to_numpy(dtype=float)
    low = df["low"].to_numpy(dtype=float)
    atr_vals = (
        _atr(pd.Series(high), pd.Series(low), pd.Series(close), period=14)
        .bfill().fillna(0.0).to_numpy(dtype=float)
    )
    adx_s = _adx_series_js_style(high, low, close, 14)
    atr_pct = atr_vals / np.maximum(close, 1e-12)
    regimes = _regime_hysteresis_series(atr_pct, adx_s)

    n = len(close)
    labels = np.full(n, -1, dtype=int)
    fee_rt = max(0.0, float(fee_bps)) / 10000.0 * 2.0

    for i in range(n - horizon):
        entry = close[i]
        if not np.isfinite(entry) or entry <= 0:
            continue
        stop_dist, rr = _stop_dist_and_rr_risk_js(entry, float(atr_vals[i]), regimes[i])

        sl_px = entry + stop_dist
        tp_px = entry - stop_dist * rr

        future_highs = high[i + 1 : i + 1 + horizon]
        future_lows = low[i + 1 : i + 1 + horizon]

        sl_hits = np.where(future_highs >= sl_px)[0]
        tp_hits = np.where(future_lows <= tp_px)[0]

        sl_first = sl_hits[0] if len(sl_hits) > 0 else horizon + 1
        tp_first = tp_hits[0] if len(tp_hits) > 0 else horizon + 1

        if tp_first < sl_first:
            gross_ret = (entry - tp_px) / entry
            if fee_rt > 0 and gross_ret < fee_rt:
                labels[i] = 0
            else:
                labels[i] = 1
        elif sl_first < tp_first:
            labels[i] = 0
        elif sl_first <= horizon:
            labels[i] = 0
        else:
            labels[i] = 1 if close[min(i + horizon, n - 1)] < entry else 0

    return labels


def _top_decile_win_rate(y: np.ndarray, raw_p: np.ndarray, q: float = 0.9) -> float | None:
    if len(y) < 80:
        return None
    thr = float(np.quantile(raw_p, q))
    m = raw_p >= thr
    if int(np.sum(m)) < 10:
        return None
    return float(np.mean(y[m]))


def _recency_sample_weights(ts_slice: np.ndarray, half_life_days: float) -> np.ndarray:
    """Higher weight for more recent rows. Mean weight ≈ 1. half_life_days<=0 → uniform."""
    n = len(ts_slice)
    if n == 0 or half_life_days <= 0:
        return np.ones(n, dtype=np.float64)
    ts_ms = ts_slice.astype(np.float64)
    t_max = float(np.max(ts_ms))
    hl_ms = float(half_life_days) * 86400_000.0
    if hl_ms <= 0:
        return np.ones(n, dtype=np.float64)
    w = np.exp(np.log(2.0) * (ts_ms - t_max) / hl_ms)
    mean_w = float(np.mean(w)) + 1e-12
    return (w / mean_w).astype(np.float64)


def _train_weights_and_bootstrap(
    X_tr: np.ndarray,
    y_tr: np.ndarray,
    ts_tr: np.ndarray,
    half_life_days: float,
    bag_fraction: float,
    rng: np.random.Generator,
    min_rows: int = 500,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    w_base = _recency_sample_weights(ts_tr, half_life_days)
    n = len(X_tr)
    if bag_fraction > 0 and n >= min_rows:
        k = max(min_rows, int(n * bag_fraction))
        idx = rng.integers(0, n, size=k)
        return X_tr[idx], y_tr[idx], w_base[idx]
    return X_tr, y_tr, w_base


# ─── Model persistence ────────────────────────────────────────────────────────

def model_path() -> Path:
    return MODEL_DIR / "model.pkl"

def short_model_path() -> Path:
    return MODEL_DIR / "model_short.pkl"

def short_calibrator_path() -> Path:
    return MODEL_DIR / "calibrator_short.pkl"

def calibrator_path() -> Path:
    return MODEL_DIR / "calibrator.pkl"


def calibrator_platt_path() -> Path:
    return MODEL_DIR / "calibrator_platt.pkl"


def meta_path() -> Path:
    return MODEL_DIR / "meta.json"

def load_meta() -> dict[str, Any] | None:
    p = meta_path()
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None

_model_lock = threading.Lock()

def save_meta(meta: dict[str, Any]) -> None:
    _ensure_dirs()
    _atomic_write_text(meta_path(), json.dumps(meta, indent=2))

def _atomic_write_bytes(path: Path, dumper, obj) -> None:
    """Write via temp file + os.replace for crash-safe persistence."""
    _ensure_dirs()
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        os.close(fd)
        dumper(obj, tmp)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

def _atomic_write_text(path: Path, text: str) -> None:
    _ensure_dirs()
    fd, tmp = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

def load_model() -> Any | None:
    p = model_path()
    if not p.exists():
        return None
    with _model_lock:
        return joblib.load(p)

def load_calibrator() -> IsotonicRegression | None:
    p = calibrator_path()
    if not p.exists():
        return None
    try:
        with _model_lock:
            return joblib.load(p)
    except Exception:
        return None


def load_calibrator_platt() -> LogisticRegression | None:
    p = calibrator_platt_path()
    if not p.exists():
        return None
    try:
        with _model_lock:
            return joblib.load(p)
    except Exception:
        return None


def save_model(model: Any) -> None:
    with _model_lock:
        _atomic_write_bytes(model_path(), joblib.dump, model)

def save_calibrator(cal: IsotonicRegression) -> None:
    with _model_lock:
        _atomic_write_bytes(calibrator_path(), joblib.dump, cal)


def save_calibrator_platt(cal: LogisticRegression) -> None:
    with _model_lock:
        _atomic_write_bytes(calibrator_platt_path(), joblib.dump, cal)


def load_short_model() -> Any | None:
    p = short_model_path()
    if not p.exists():
        return None
    with _model_lock:
        return joblib.load(p)

def save_short_model(model: Any) -> None:
    with _model_lock:
        _atomic_write_bytes(short_model_path(), joblib.dump, model)

def load_short_calibrator() -> IsotonicRegression | None:
    p = short_calibrator_path()
    if not p.exists():
        return None
    try:
        with _model_lock:
            return joblib.load(p)
    except Exception:
        return None

def save_short_calibrator(cal: IsotonicRegression) -> None:
    with _model_lock:
        _atomic_write_bytes(short_calibrator_path(), joblib.dump, cal)

def delete_calibrator() -> None:
    """Remove stale calibrator (e.g. after feedback retrain that doesn't produce one)."""
    for p in [calibrator_path(), short_calibrator_path()]:
        if p.exists():
            try:
                os.unlink(p)
            except OSError:
                pass


# ─── Pydantic models ─────────────────────────────────────────────────────────

class Candle(BaseModel):
    ts: int | str
    open: float
    high: float
    low: float
    close: float
    volume: float
    buy_volume: float | None = None
    sell_volume: float | None = None


class PredictRequest(BaseModel):
    symbol: str = Field(..., examples=["BTCUSDT"])
    timeframe: str = Field(..., examples=["1m"])
    candles: list[Candle] = Field(..., min_items=30)


class PredictResponse(BaseModel):
    model_loaded: bool
    probability: float
    raw_probability: float
    short_probability: float | None = None
    short_raw_probability: float | None = None
    calibrated: bool
    features: dict[str, float]
    model_kind: str


class TrainRequest(BaseModel):
    candles: list[Candle]
    labels: list[int]


class TrainResponse(BaseModel):
    trained_rows: int
    feature_columns: list[str]


class BootstrapTrainRequest(BaseModel):
    rows: int = Field(2000, ge=500, le=200_000)
    horizon: int = Field(default=LABEL_HORIZON_MIN, ge=1, le=240)
    seed: int = Field(42, ge=0, le=1_000_000)
    start_price: float = Field(60_000.0, gt=0)


class BootstrapTrainResponse(BaseModel):
    trained_rows: int
    horizon: int
    positive_rate: float
    feature_columns: list[str]


class FeedbackRequest(BaseModel):
    symbol: str
    strategy: str
    timeframe: str
    side: Literal["BUY", "SELL"]
    probability: float = Field(..., ge=0.0, le=1.0)
    features: dict[str, float]
    pnl: float
    outcome: Literal["WIN", "LOSS", "BREAKEVEN"]
    ts: str | None = None


class RetrainFromFeedbackRequest(BaseModel):
    min_rows: int = Field(200, ge=10, le=1_000_000)


class RetrainFromFeedbackResponse(BaseModel):
    ok: bool
    trained_rows: int
    positive_rate: float
    model_kind: str
    trained_at: str


class BinanceTrainRequest(BaseModel):
    symbols: list[str] = Field(
        default=[
            "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
            "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
        ],
        min_length=1,
        max_length=20,
    )
    interval: str = Field(default="1m")
    candles_per_symbol: int = Field(default=35000, ge=1000, le=100000)
    horizon: int = Field(default=90, ge=5, le=300)
    atr_mult: float = Field(default=1.0, ge=0.3, le=3.0)
    rr: float = Field(default=1.6, ge=1.0, le=5.0)
    label_profile: Literal["risk_aligned", "legacy"] = "risk_aligned"
    fee_bps: float = Field(default=10.0, ge=0.0, le=50.0)


class BinanceTrainResponse(BaseModel):
    ok: bool
    trained_rows: int
    total_fetched: int
    symbols_used: list[str]
    positive_rate: float
    val_accuracy: float
    val_precision: float
    val_recall: float
    model_kind: str
    trained_at: str
    feature_columns: list[str]
    n_features: int
    calibrated: bool
    label_profile: str = "risk_aligned"
    val_top_decile_wr: float | None = None
    val_baseline_wr: float | None = None
    val_lift: float | None = None
    val_half1_top_decile_wr: float | None = None
    val_half2_top_decile_wr: float | None = None
    val_brier: float | None = None
    val_roc_auc: float | None = None


# ─── FastAPI app ──────────────────────────────────────────────────────────────

app = FastAPI(title="AI Service", version="2.0.0")


@app.get("/health")
def health() -> dict[str, Any]:
    m = load_model()
    meta = load_meta()
    cal = load_calibrator()
    cal_p = load_calibrator_platt()
    m0 = m[0] if isinstance(m, list) else m
    n_model = getattr(m0, "n_features_in_", None) if m0 else None
    compatible = n_model == len(FEATURE_COLUMNS) if n_model is not None else (m is not None)
    ensemble_size = len(m) if isinstance(m, list) else (1 if m else 0)
    short_m = load_short_model()
    return {
        "ok": True,
        "model_loaded": m is not None,
        "model_compatible": compatible,
        "model_n_features": n_model,
        "calibrator_loaded": cal is not None,
        "calibrator_platt_loaded": cal_p is not None,
        "short_model_loaded": short_m is not None,
        "xgboost_available": XGBOOST_AVAILABLE,
        **(
            {"xgboost_import_error": XGBOOST_IMPORT_ERROR}
            if not XGBOOST_AVAILABLE and XGBOOST_IMPORT_ERROR
            else {}
        ),
        "meta": meta,
        "feature_columns": FEATURE_COLUMNS,
        "n_features": len(FEATURE_COLUMNS),
        "ensemble_size": ensemble_size,
        "model_path": str(model_path()),
        "feedback_csv": str(FEEDBACK_CSV),
    }


@app.post("/predict", response_model=PredictResponse)
def predict(req: PredictRequest) -> PredictResponse:
    model = load_model()
    if model is None:
        raise HTTPException(
            status_code=503,
            detail="Model not trained yet. Call /train/from-binance first.",
        )

    check_model = model[0] if isinstance(model, list) else model
    n_expected = getattr(check_model, "n_features_in_", len(FEATURE_COLUMNS))
    if n_expected != len(FEATURE_COLUMNS):
        raise HTTPException(
            status_code=503,
            detail=(
                f"Model expects {n_expected} features but config has "
                f"{len(FEATURE_COLUMNS)}. Retrain via /train/from-binance."
            ),
        )

    candles_df = pd.DataFrame([c.model_dump() for c in req.candles])
    candles_df = enrich_with_external_features(candles_df)
    feats = build_features(candles_df)
    x = feats.iloc[-1:][FEATURE_COLUMNS].to_numpy()

    # Ensemble prediction: model can be a list of models or a single model
    if isinstance(model, list):
        probas = [float(m.predict_proba(x)[0, 1]) for m in model]
        raw_proba = float(np.mean(probas))
        model_kind = f"Ensemble({len(model)}x{type(model[0]).__name__})"
    else:
        raw_proba = float(model.predict_proba(x)[0, 1])
        model_kind = type(model).__name__

    cal = load_calibrator()
    cal_platt = load_calibrator_platt()
    calibrated = False
    proba_iso = raw_proba
    if cal is not None:
        try:
            proba_iso = float(cal.predict([raw_proba])[0])
            proba_iso = max(0.0, min(1.0, proba_iso))
            if not math.isfinite(proba_iso):
                proba_iso = raw_proba
            calibrated = True
        except Exception:
            proba_iso = raw_proba
    iso_w = max(0.0, min(1.0, float(os.getenv("AI_CAL_BLEND_ISOTONIC", "0.72"))))
    proba = proba_iso
    if cal_platt is not None:
        try:
            proba_p = float(
                cal_platt.predict_proba(np.array([[raw_proba]], dtype=np.float64))[0, 1]
            )
            proba_p = max(0.0, min(1.0, proba_p))
            if math.isfinite(proba_p):
                proba = float(iso_w * proba_iso + (1.0 - iso_w) * proba_p)
                calibrated = True
        except Exception:
            proba = proba_iso
    if not math.isfinite(proba):
        proba = float(max(0.0, min(1.0, raw_proba)))

    # Short model prediction (direction-aware)
    short_proba = None
    short_raw_proba = None
    short_model = load_short_model()
    if short_model is not None:
        try:
            if isinstance(short_model, list):
                s_probas = [float(m.predict_proba(x)[0, 1]) for m in short_model]
                short_raw_proba = float(np.mean(s_probas))
            else:
                short_raw_proba = float(short_model.predict_proba(x)[0, 1])
            s_cal = load_short_calibrator()
            if s_cal is not None:
                try:
                    short_proba = float(s_cal.predict([short_raw_proba])[0])
                    short_proba = max(0.0, min(1.0, short_proba))
                    if not math.isfinite(short_proba):
                        short_proba = short_raw_proba
                except Exception:
                    short_proba = short_raw_proba
            else:
                short_proba = short_raw_proba
        except Exception:
            short_proba = None
            short_raw_proba = None

    last_features = feats.iloc[-1].to_dict()
    last_features = {k: float(v) for k, v in last_features.items()}

    return PredictResponse(
        model_loaded=True,
        probability=proba,
        raw_probability=raw_proba,
        short_probability=short_proba,
        short_raw_probability=short_raw_proba,
        calibrated=calibrated,
        features=last_features,
        model_kind=model_kind,
    )


@app.post("/train", response_model=TrainResponse)
def train(req: TrainRequest) -> TrainResponse:
    if len(req.candles) != len(req.labels):
        raise HTTPException(status_code=400, detail="candles and labels must have same length")
    if len(req.candles) < 200:
        raise HTTPException(status_code=400, detail="Need at least 200 rows to train")

    df = pd.DataFrame([c.model_dump() for c in req.candles])
    y = np.array(req.labels, dtype=int)
    X = build_features(df)[FEATURE_COLUMNS].to_numpy()

    if XGBOOST_AVAILABLE:
        model = XGBClassifier(
            n_estimators=300, max_depth=4, learning_rate=0.05,
            subsample=0.9, colsample_bytree=0.9, reg_lambda=1.0,
            objective="binary:logistic", eval_metric="logloss", random_state=42,
        )
    else:
        model = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, random_state=42)
    model.fit(X, y)
    save_model(model)
    save_meta({
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "trained_rows": int(X.shape[0]),
        "positive_rate": float(np.mean(y)) if len(y) else 0.0,
        "model_kind": type(model).__name__,
        "source": "train",
    })
    return TrainResponse(trained_rows=int(X.shape[0]), feature_columns=FEATURE_COLUMNS)


@app.post("/train/bootstrap", response_model=BootstrapTrainResponse)
def train_bootstrap(req: BootstrapTrainRequest) -> BootstrapTrainResponse:
    rng = np.random.default_rng(req.seed)
    n = int(req.rows)
    horizon = int(req.horizon)

    close = np.empty(n, dtype=float)
    close[0] = float(req.start_price)
    vol_state = 1.0
    for i in range(1, n):
        vol_state = 0.95 * vol_state + 0.05 * (0.5 + rng.random() * 2.0)
        step = rng.normal(0, 40 * vol_state)
        close[i] = max(50.0, close[i - 1] + step)

    open_ = np.roll(close, 1)
    open_[0] = close[0]
    high = np.maximum(open_, close) + rng.random(n) * 20
    low = np.minimum(open_, close) - rng.random(n) * 20
    volume = 10 + rng.random(n) * 50

    candles = pd.DataFrame({
        "ts": np.arange(n, dtype=int),
        "open": open_, "high": high, "low": low, "close": close, "volume": volume,
    })

    future_close = candles["close"].shift(-horizon)
    labels = (future_close > candles["close"]).astype(int).fillna(0).to_numpy(dtype=int)

    X = build_features(candles)[FEATURE_COLUMNS].to_numpy()
    y = labels

    if XGBOOST_AVAILABLE:
        model = XGBClassifier(
            n_estimators=350, max_depth=4, learning_rate=0.05,
            subsample=0.9, colsample_bytree=0.9, reg_lambda=1.0,
            objective="binary:logistic", eval_metric="logloss", random_state=42,
        )
    else:
        model = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, random_state=42)
    model.fit(X, y)
    save_model(model)
    save_meta({
        "trained_at": datetime.now(timezone.utc).isoformat(),
        "trained_rows": int(X.shape[0]),
        "positive_rate": float(np.mean(y)) if len(y) else 0.0,
        "model_kind": type(model).__name__,
        "source": "bootstrap", "horizon": horizon,
    })
    return BootstrapTrainResponse(
        trained_rows=int(X.shape[0]), horizon=horizon,
        positive_rate=float(np.mean(y)) if len(y) else 0.0,
        feature_columns=FEATURE_COLUMNS,
    )


@app.post("/feedback")
def feedback(req: FeedbackRequest) -> dict[str, Any]:
    _ensure_dirs()
    ts = req.ts or datetime.now(timezone.utc).isoformat()
    row = {
        "ts": ts, "symbol": req.symbol, "strategy": req.strategy,
        "timeframe": req.timeframe, "side": req.side,
        "probability": float(req.probability), "pnl": float(req.pnl),
        "outcome": req.outcome,
        "features_json": pd.Series([req.features]).to_json(orient="records"),
    }
    write_header = not FEEDBACK_CSV.exists()
    pd.DataFrame([row]).to_csv(FEEDBACK_CSV, mode="a", index=False, header=write_header)
    return {"ok": True}


@app.post("/retrain/from-feedback", response_model=RetrainFromFeedbackResponse)
def retrain_from_feedback(req: RetrainFromFeedbackRequest) -> RetrainFromFeedbackResponse:
    _ensure_dirs()
    if not FEEDBACK_CSV.exists():
        raise HTTPException(status_code=400, detail="No feedback CSV found")

    df = pd.read_csv(FEEDBACK_CSV)
    if df.empty or len(df) < req.min_rows:
        raise HTTPException(status_code=400, detail=f"Need at least {req.min_rows} feedback rows")

    feats = []
    for raw in df["features_json"].astype(str).tolist():
        try:
            arr = json.loads(raw)
            feats.append(arr[0] if isinstance(arr, list) and arr else {})
        except Exception:
            feats.append({})

    Xdf = pd.DataFrame(feats)
    for c in FEATURE_COLUMNS:
        if c not in Xdf.columns:
            Xdf[c] = 0.0
    X = Xdf[FEATURE_COLUMNS].replace([np.inf, -np.inf], np.nan).fillna(0.0).to_numpy()
    y = (df["pnl"].astype(float) > 0).astype(int).to_numpy(dtype=int)

    pnl = df["pnl"].astype(float).to_numpy()
    if FEEDBACK_REQUIRE_NONZERO_PNL:
        keep = np.abs(pnl) > 0
        X, y, df = X[keep], y[keep], df.iloc[np.where(keep)[0]].reset_index(drop=True)

    if X.shape[0] > 0:
        keep2 = np.sum(np.abs(X), axis=1) > 0
        X, y, df = X[keep2], y[keep2], df.iloc[np.where(keep2)[0]].reset_index(drop=True)

    if X.shape[0] < req.min_rows:
        raise HTTPException(status_code=400, detail=f"Need at least {req.min_rows} quality feedback rows after filtering")

    w = None
    if FEEDBACK_HALF_LIFE_DAYS and FEEDBACK_HALF_LIFE_DAYS > 0:
        ts_col = pd.to_datetime(df["ts"], errors="coerce", utc=True)
        now = pd.Timestamp.now(tz="UTC")
        age_days = (now - ts_col).dt.total_seconds().fillna(0).clip(lower=0) / (24 * 3600)
        w = np.clip(np.exp(-age_days.to_numpy(dtype=float) / float(FEEDBACK_HALF_LIFE_DAYS)), 0.05, 1.0)

    if XGBOOST_AVAILABLE:
        model = XGBClassifier(
            n_estimators=350, max_depth=4, learning_rate=0.05,
            subsample=0.9, colsample_bytree=0.9, reg_lambda=1.0,
            objective="binary:logistic", eval_metric="logloss", random_state=42,
        )
    else:
        model = HistGradientBoostingClassifier(max_depth=4, learning_rate=0.05, random_state=42)

    if w is not None:
        model.fit(X, y, sample_weight=w)
    else:
        model.fit(X, y)
    save_model(model)
    delete_calibrator()
    trained_at = datetime.now(timezone.utc).isoformat()
    save_meta({
        "trained_at": trained_at, "trained_rows": int(X.shape[0]),
        "positive_rate": float(np.mean(y)) if len(y) else 0.0,
        "model_kind": type(model).__name__, "source": "feedback",
        "calibrated": False,
    })
    return RetrainFromFeedbackResponse(
        ok=True, trained_rows=int(X.shape[0]),
        positive_rate=float(np.mean(y)) if len(y) else 0.0,
        model_kind=type(model).__name__, trained_at=trained_at,
    )


@app.post("/train/from-binance", response_model=BinanceTrainResponse)
def train_from_binance(req: BinanceTrainRequest) -> BinanceTrainResponse:
    """
    V2 training pipeline:
    - Fetches real Binance klines for multiple symbols
    - Builds 40 enhanced features (multi-TF, candlestick patterns, time-of-day)
    - Labels via SL/TP simulation (`risk_aligned`: `regime.js` hysteresis + `risk.js` stops/RR; or `legacy`)
    - Walk-forward split with purged gap to prevent leakage
    - Recency-weighted rows (TRAIN_RECENCY_HALF_LIFE_DAYS) + optional ensemble bagging (TRAIN_ENSEMBLE_BAG_FRACTION)
    - Class-balanced training with early stopping
    - Isotonic calibration for accurate probability estimates
    """
    from sklearn.metrics import (
        accuracy_score,
        brier_score_loss,
        f1_score,
        log_loss,
        precision_score,
        recall_score,
        roc_auc_score,
    )

    all_X: list[np.ndarray] = []
    all_y: list[np.ndarray] = []
    all_y_short: list[np.ndarray] = []
    all_ts: list[np.ndarray] = []
    total_fetched = 0
    symbols_used: list[str] = []

    for sym in req.symbols:
        try:
            df = fetch_binance_klines(
                symbol=sym, interval=req.interval, total=req.candles_per_symbol
            )
            if len(df) < 200:
                continue

            df = enrich_with_external_features(df)

            X = build_features(df)[FEATURE_COLUMNS].to_numpy()
            ts_arr = df["ts"].to_numpy(dtype=np.int64)
            y_short = None
            if req.label_profile == "legacy":
                y = label_trade_outcomes(
                    df, horizon=req.horizon, atr_mult=req.atr_mult, rr=req.rr
                )
            else:
                y = label_trade_outcomes_risk_aligned(
                    df, horizon=req.horizon, fee_bps=req.fee_bps
                )
                y_short = label_trade_outcomes_short(
                    df, horizon=req.horizon, fee_bps=req.fee_bps
                )

            if y_short is not None:
                valid = (y >= 0) & (y_short >= 0)
            else:
                valid = y >= 0
            X, y, ts_arr = X[valid], y[valid], ts_arr[valid]
            if y_short is not None:
                y_short = y_short[valid]
            if len(X) < 100:
                continue

            all_X.append(X)
            all_y.append(y)
            if y_short is not None:
                all_y_short.append(y_short)
            all_ts.append(ts_arr)
            total_fetched += len(df)
            symbols_used.append(sym)
        except Exception:
            continue

    if not all_X:
        raise HTTPException(
            status_code=400, detail="Could not fetch usable data for any symbol"
        )

    X = np.vstack(all_X)
    y = np.concatenate(all_y)
    ts = np.concatenate(all_ts)
    y_short_sorted: np.ndarray | None = None
    if all_y_short and len(all_y_short) == len(all_X):
        y_short_sorted = np.concatenate(all_y_short)

    # Sort globally by timestamp for true walk-forward integrity
    order = np.argsort(ts, kind="mergesort")
    X, y, ts = X[order], y[order], ts[order]
    if y_short_sorted is not None and len(y_short_sorted) == len(X):
        y_short_sorted = y_short_sorted[order]

    # Walk-forward split with purge gap (prevents look-ahead leakage)
    n = len(X)
    train_end = int(n * 0.65)
    val_end = int(n * 0.82)
    # Purge gap: at least 2×horizon rows AND ~3% of series; cap so validation window stays non-empty
    min_val_rows = max(200, int(n * 0.04))
    room = (val_end - train_end) - min_val_rows
    gap_target = max(int(req.horizon * 2), int(n * 0.03))
    gap = min(gap_target, max(0, room))
    val_start = train_end + gap
    cal_start = val_end + gap

    X_train, y_train = X[:train_end], y[:train_end]
    ts_train = ts[:train_end]
    X_val, y_val = X[val_start:val_end], y[val_start:val_end]
    X_cal, y_cal = X[cal_start:], y[cal_start:]

    pos_count = float(np.sum(y_train == 1))
    neg_count = float(np.sum(y_train == 0))
    scale_pos_weight = neg_count / max(pos_count, 1)

    # ── Ensemble: train N_ENSEMBLE models with varied seeds/subsets ──
    N_ENSEMBLE = 5
    ensemble_models: list = []

    for ei in range(N_ENSEMBLE):
        seed = 42 + ei * 7
        rng = np.random.default_rng(seed)
        col_frac = max(0.55, 0.75 - ei * 0.04)
        X_fit, y_fit, w_fit = _train_weights_and_bootstrap(
            X_train,
            y_train,
            ts_train,
            TRAIN_RECENCY_HALF_LIFE_DAYS,
            TRAIN_ENSEMBLE_BAG_FRACTION,
            rng,
        )
        if XGBOOST_AVAILABLE:
            m = XGBClassifier(
                n_estimators=1200,
                max_depth=6,
                learning_rate=0.015,
                subsample=0.75,
                colsample_bytree=col_frac,
                reg_lambda=3.0,
                reg_alpha=0.8,
                min_child_weight=10,
                gamma=0.1,
                scale_pos_weight=scale_pos_weight,
                objective="binary:logistic",
                eval_metric="logloss",
                early_stopping_rounds=60,
                random_state=seed,
            )
            m.fit(X_fit, y_fit, sample_weight=w_fit, eval_set=[(X_val, y_val)], verbose=False)
        else:
            total_for_hgb = len(X_fit) + len(X_val)
            val_frac = len(X_val) / total_for_hgb if total_for_hgb > 0 else 0.15
            X_hgb = np.vstack([X_fit, X_val])
            y_hgb = np.concatenate([y_fit, y_val])
            w_hgb = np.concatenate(
                [w_fit, np.ones(len(X_val), dtype=np.float64)]
            )
            m = HistGradientBoostingClassifier(
                max_depth=6,
                learning_rate=0.015,
                max_iter=1200,
                min_samples_leaf=20,
                l2_regularization=3.0,
                class_weight="balanced",
                early_stopping=True,
                validation_fraction=val_frac,
                n_iter_no_change=60,
                random_state=seed,
            )
            m.fit(X_hgb, y_hgb, sample_weight=w_hgb)
        ensemble_models.append(m)

    # Primary model (first of ensemble) for compatibility; ensemble stored separately
    mdl = ensemble_models[0]

    def _ensemble_proba(X_in: np.ndarray) -> np.ndarray:
        probas = np.column_stack([m.predict_proba(X_in)[:, 1] for m in ensemble_models])
        return np.mean(probas, axis=1)

    # ── Feature importance pruning ──
    pruned_features: list[str] = []
    if hasattr(mdl, "feature_importances_"):
        imp = mdl.feature_importances_
        median_imp = float(np.median(imp[imp > 0])) if np.any(imp > 0) else 0
        keep_mask = imp >= median_imp * 0.05
        pruned_features = [FEATURE_COLUMNS[i] for i in range(len(FEATURE_COLUMNS)) if not keep_mask[i]]

    # ── Isotonic + Platt calibration on held-out calibration set ──
    calibrated = False
    cal_platt_trained = False
    cal_obj = None
    raw_cal_proba: np.ndarray | None = None
    if len(X_cal) > 100 and len(y_cal) > 100:
        try:
            raw_cal_proba = _ensemble_proba(X_cal)
        except Exception:
            raw_cal_proba = None
        if raw_cal_proba is not None:
            try:
                cal_obj = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
                cal_obj.fit(raw_cal_proba, y_cal)
                save_calibrator(cal_obj)
                calibrated = True
            except Exception:
                pass
        if raw_cal_proba is not None and len(np.unique(y_cal)) > 1:
            try:
                platt = LogisticRegression(
                    C=1.0, solver="lbfgs", max_iter=500, class_weight=None
                )
                platt.fit(raw_cal_proba.reshape(-1, 1), y_cal)
                save_calibrator_platt(platt)
                cal_platt_trained = True
            except Exception:
                pass

    # ── Evaluate on validation set ──
    raw_val_proba = _ensemble_proba(X_val)
    y_pred = (raw_val_proba >= 0.5).astype(int)
    acc = float(accuracy_score(y_val, y_pred))
    prec = float(precision_score(y_val, y_pred, zero_division=0))
    rec = float(recall_score(y_val, y_pred, zero_division=0))
    f1 = float(f1_score(y_val, y_pred, zero_division=0))
    ll = float(log_loss(y_val, raw_val_proba))

    try:
        val_brier = float(brier_score_loss(y_val, raw_val_proba))
    except Exception:
        val_brier = None
    val_roc_auc = None
    try:
        if len(np.unique(y_val)) > 1:
            val_roc_auc = float(roc_auc_score(y_val, raw_val_proba))
    except Exception:
        val_roc_auc = None

    val_baseline_wr = float(np.mean(y_val)) if len(y_val) else None
    val_top_decile_wr = _top_decile_win_rate(y_val, raw_val_proba)
    val_lift = (
        float(val_top_decile_wr - val_baseline_wr)
        if val_top_decile_wr is not None and val_baseline_wr is not None
        else None
    )
    mid = len(y_val) // 2
    val_half1_top_decile_wr = None
    val_half2_top_decile_wr = None
    if mid >= 80 and len(y_val) - mid >= 80:
        val_half1_top_decile_wr = _top_decile_win_rate(
            y_val[:mid], raw_val_proba[:mid]
        )
        val_half2_top_decile_wr = _top_decile_win_rate(
            y_val[mid:], raw_val_proba[mid:]
        )

    # Save long ensemble
    save_model(ensemble_models)

    # ── Train SHORT model: y_short_sorted is masked & sorted with X (same rows as long model) ──
    short_trained = False
    if (
        y_short_sorted is not None
        and len(y_short_sorted) == len(X)
        and len(X) > 500
    ):
        y_s = y_short_sorted
        X_s_train, y_s_train = X[:train_end], y_s[:train_end]
        X_s_val, y_s_val = X[val_start:val_end], y_s[val_start:val_end]
        X_s_cal, y_s_cal = X[cal_start:], y_s[cal_start:]
        s_pos = float(np.sum(y_s_train == 1))
        s_neg = float(np.sum(y_s_train == 0))
        s_scale = s_neg / max(s_pos, 1)

        short_ensemble: list = []
        for ei in range(N_ENSEMBLE):
            seed = 137 + ei * 7
            rng_s = np.random.default_rng(seed)
            col_frac = max(0.55, 0.75 - ei * 0.04)
            X_sf, y_sf, w_sf = _train_weights_and_bootstrap(
                X_s_train,
                y_s_train,
                ts_train,
                TRAIN_RECENCY_HALF_LIFE_DAYS,
                TRAIN_ENSEMBLE_BAG_FRACTION,
                rng_s,
            )
            if XGBOOST_AVAILABLE:
                ms = XGBClassifier(
                    n_estimators=1200, max_depth=6, learning_rate=0.015,
                    subsample=0.75, colsample_bytree=col_frac,
                    reg_lambda=3.0, reg_alpha=0.8, min_child_weight=10, gamma=0.1,
                    scale_pos_weight=s_scale,
                    objective="binary:logistic", eval_metric="logloss",
                    early_stopping_rounds=60, random_state=seed,
                )
                ms.fit(X_sf, y_sf, sample_weight=w_sf, eval_set=[(X_s_val, y_s_val)], verbose=False)
            else:
                total_hgb_s = len(X_sf) + len(X_s_val)
                vf_s = len(X_s_val) / total_hgb_s if total_hgb_s > 0 else 0.15
                X_hgb_s = np.vstack([X_sf, X_s_val])
                y_hgb_s = np.concatenate([y_sf, y_s_val])
                w_hgb_s = np.concatenate(
                    [w_sf, np.ones(len(X_s_val), dtype=np.float64)]
                )
                ms = HistGradientBoostingClassifier(
                    max_depth=6, learning_rate=0.015, max_iter=1200,
                    min_samples_leaf=20, l2_regularization=3.0,
                    class_weight="balanced", early_stopping=True,
                    validation_fraction=vf_s, n_iter_no_change=60, random_state=seed,
                )
                ms.fit(X_hgb_s, y_hgb_s, sample_weight=w_hgb_s)
            short_ensemble.append(ms)
        save_short_model(short_ensemble)

        if len(X_s_cal) > 100 and len(y_s_cal) > 100:
            try:
                s_raw_cal = np.mean(np.column_stack([m.predict_proba(X_s_cal)[:, 1] for m in short_ensemble]), axis=1)
                s_cal_obj = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
                s_cal_obj.fit(s_raw_cal, y_s_cal)
                save_short_calibrator(s_cal_obj)
            except Exception:
                pass
        short_trained = True

    trained_at = datetime.now(timezone.utc).isoformat()

    # Model versioning: archive with version ID
    version_id = f"v_{trained_at.replace(':', '').replace('-', '').replace('.', '_')}"
    version_dir = MODEL_DIR / "versions" / version_id
    version_dir.mkdir(parents=True, exist_ok=True)
    try:
        import shutil
        for src in [model_path(), calibrator_path(), calibrator_platt_path(), meta_path()]:
            if src.exists():
                shutil.copy2(src, version_dir / src.name)
    except Exception:
        pass

    # Feature importance (top 10) — average across ensemble
    importance = {}
    all_imps = [getattr(m, "feature_importances_", None) for m in ensemble_models]
    valid_imps = [i for i in all_imps if i is not None]
    if valid_imps:
        imp = np.mean(valid_imps, axis=0)
        top_idx = np.argsort(imp)[::-1][:10]
        importance = {FEATURE_COLUMNS[i]: round(float(imp[i]), 4) for i in top_idx}

    meta = {
        "trained_at": trained_at,
        "trained_rows": int(X_train.shape[0]),
        "val_rows": int(X_val.shape[0]),
        "cal_rows": int(X_cal.shape[0]),
        "total_fetched": total_fetched,
        "symbols": symbols_used,
        "positive_rate": float(np.mean(y_train)),
        "val_accuracy": round(acc, 4),
        "val_precision": round(prec, 4),
        "val_recall": round(rec, 4),
        "val_f1": round(f1, 4),
        "val_log_loss": round(ll, 4),
        "model_kind": type(mdl).__name__,
        "source": "binance",
        "calibrated": calibrated,
        "calibration_platt": cal_platt_trained,
        "feature_columns": FEATURE_COLUMNS,
        "n_features": len(FEATURE_COLUMNS),
        "top_features": importance,
        "interval": req.interval,
        "horizon": req.horizon,
        "label_profile": req.label_profile,
        "fee_bps": req.fee_bps,
        "atr_mult": req.atr_mult,
        "rr": req.rr,
        "val_top_decile_wr": round(val_top_decile_wr, 4) if val_top_decile_wr is not None else None,
        "val_baseline_wr": round(val_baseline_wr, 4) if val_baseline_wr is not None else None,
        "val_lift": round(val_lift, 4) if val_lift is not None else None,
        "val_half1_top_decile_wr": round(val_half1_top_decile_wr, 4) if val_half1_top_decile_wr is not None else None,
        "val_half2_top_decile_wr": round(val_half2_top_decile_wr, 4) if val_half2_top_decile_wr is not None else None,
        "val_brier": round(val_brier, 6) if val_brier is not None else None,
        "val_roc_auc": round(val_roc_auc, 4) if val_roc_auc is not None else None,
        "train_recency_half_life_days": TRAIN_RECENCY_HALF_LIFE_DAYS,
        "train_ensemble_bag_fraction": TRAIN_ENSEMBLE_BAG_FRACTION,
        "ensemble_size": N_ENSEMBLE,
        "version_id": version_id,
        "pruned_features": pruned_features,
        "short_model_trained": short_trained,
    }
    save_meta(meta)

    return BinanceTrainResponse(
        ok=True,
        trained_rows=int(X_train.shape[0]),
        total_fetched=total_fetched,
        symbols_used=symbols_used,
        positive_rate=float(np.mean(y_train)),
        val_accuracy=round(acc, 4),
        val_precision=round(prec, 4),
        val_recall=round(rec, 4),
        model_kind=type(mdl).__name__,
        trained_at=trained_at,
        feature_columns=FEATURE_COLUMNS,
        n_features=len(FEATURE_COLUMNS),
        calibrated=calibrated,
        label_profile=req.label_profile,
        val_top_decile_wr=val_top_decile_wr,
        val_baseline_wr=round(val_baseline_wr, 4) if val_baseline_wr is not None else None,
        val_lift=round(val_lift, 4) if val_lift is not None else None,
        val_half1_top_decile_wr=val_half1_top_decile_wr,
        val_half2_top_decile_wr=val_half2_top_decile_wr,
        val_brier=val_brier,
        val_roc_auc=val_roc_auc,
    )
