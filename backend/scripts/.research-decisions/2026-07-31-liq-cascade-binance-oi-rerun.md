# LIQ_CASCADE — Binance OI ingest + prod 5m/1m rerun (2026-07-31)

**Change:** Wire `liqCascadeOiSource: binance` → `historical_open_interest` (Binance `openInterestHist` 5m). Coinalyze OI retained as fallback via `liqCascadeOiSource: coinalyze`.

**OI gate re-enabled:** `window`, min drop 0.12%, window 3 bars (15m wall-clock; auto-scaled to 3×5m when liq is 1m).

**Window:** ~60h force_orders archive.

| Setup | Trades | Net P&L | WR | PF | vs prior (OI off, 17 trades −$2.40 on 5m) |
|-------|--------|---------|----|----|-------------------------------------------|
| Prod 5m + Binance OI | 8 | −$3.65 | 38% | 0.39 | Fewer trades, similar red |
| Prod 1m + Binance OI | 5 | −$2.10 | 40% | 0.41 | — |

**OI coverage:** 767×5m points/symbol over window (~64h of Binance 30d retention).

**Verdict:** Binance OI loads correctly and gates fire on exchange-native drops — but setup still **not profitable** on this checkpoint. OI-on reduces frequency vs OI-off (17→8 on 5m) without improving expectancy.

**Artifact:** `.liq-cascade-prod-binance-oi-rerun.json`
