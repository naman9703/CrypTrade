# LIQ_CASCADE 1min liq replay — production vs smoke (checkpoint)

**Date:** 2026-07-31  
**Window:** 72h requested; effective tick coverage ~0.3 weeks (2026-07-29 → 2026-07-31)  
**Source:** `force_orders` ticks → 1m liq bars  
**Script:** `research-liq-cascade-last10h-signals.mjs` with `SETUP=production_1m|smoke_1m`

## Data quality

| Symbol | Ticks | 1m liq bars (nonzero) | Coverage |
|--------|-------|------------------------|----------|
| BTCUSDT | 286 | 169 / 4320 | 0.30 wk |
| ETHUSDT | 203 | 116 / 4320 | 0.29 wk |
| BNBUSDT | 39 | 26 / 4320 | 0.27 wk |

**Verdict:** accumulating — not replay-ready for edge claims (need ≥8 weeks).

## Funnel comparison (portfolio totals, 72h window)

| Stage | prod 5m liq | smoke 5m | **prod 1m liq** | **smoke 1m** |
|-------|-------------|----------|-----------------|--------------|
| Liq bars in window | 2,592 | 2,592 | **12,960** | **12,960** |
| Nonzero liq bars | 187 | 187 | **311** | **311** |
| ≥ min $ bar | 97 | 111 | **192** | **205** |
| z-score pass | 43 | 49 | **102** | **120** |
| displacement pass | 48 | 111 | **36** | **205** |
| OI pass | 12 | 111 | **6** | **205** |
| cascade-eligible (trigger) | 6 | 49 | **0** | **120** |
| raw signals (full gates) | 0 | 41 | **0** | **89** |
| adapter signals (rate-limited) | 0 | 39 | **0** | **76** |

## Per-coin smoke 1m (path verify)

| Coin | cascade-eligible | raw | adapter |
|------|------------------|-----|---------|
| BTC | 52 | 37 | 31 |
| ETH | 52 | 44 | 38 |
| BNB | 16 | 8 | 7 |

## Production 1m — why zero signals

Trigger funnel dies at **OI + displacement** (same as 5m prod, worse on 1m):

- **OI window (15 bars):** only 6/192 min-$ bars pass 12% drop — Coinalyze OI is coarse vs 1m liq timing.
- **Displacement ≥0.8 ATR:** only 36/192 pass — 1m in-bar disp is often <0.8 ATR even when liq z is extreme.
- Near-misses show repeated pattern: z + $ + dom pass, `oiPass: false`, `dispPass: false`.

**Not a frequency failure** — production gates are doing their job; combo is too strict for current data granularity.

## Smoke 1m — frequency lift confirmed

- **~2.2× raw signals vs smoke 5m** (89 vs 41) on same tick archive.
- **~1.9× adapter signals** (76 vs 39) after maxTradesPerDay/minBarGap.
- BTC+ETH each ~37–44 raw / ~31–38 adapter over ~2.1 days → **~8–15 signals/day/coin** (paper path only).

## Decision

- **Smoke 1m:** viable for **paper path verification** — apply `⚠ BTC paper smoke (1m liq)` preset, Save, confirm Activity + orders.
- **Production 1m:** **checkpoint, not promote** — zero trades on 0.3wk; OI+disp remain binding constraints. Re-test when tick coverage ≥8wk; consider OI gate `off` or `backtest_off` ablation on 1m before live capital.
- **No edge claim** on any setup until full sim + holdout on sufficient tick history.

## Artifacts

- `scripts/.liq-cascade-replay-production_1m.json`
- `scripts/.liq-cascade-replay-smoke_1m.json`
- `scripts/.liq-cascade-force-orders-coverage.json` (1min interval)

## Re-run

```bash
cd backend
SKIP_ENSURE=1 SETUP=production_1m HOURS=72 LIQ_SOURCE=force_orders node scripts/research-liq-cascade-last10h-signals.mjs
SKIP_ENSURE=1 SETUP=smoke_1m HOURS=72 LIQ_SOURCE=force_orders node scripts/research-liq-cascade-last10h-signals.mjs
```
