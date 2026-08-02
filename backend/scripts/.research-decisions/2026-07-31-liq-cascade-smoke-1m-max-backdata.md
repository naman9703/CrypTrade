# LIQ_CASCADE smoke 1m portfolio — max force_orders backdata (checkpoint)

**Date:** 2026-07-31  
**Preset:** `LIQ_CASCADE_PORTFOLIO_1M_SMOKE_1MIN` (tp 5× ATR, z≥1.2, $5k bar, minRr 0)  
**Costs:** 0.05% slippage + 0.04% fee/side, 10× leverage  
**Liq source:** `force_orders` ticks only (no Coinalyze liq for this window)

## Data span (max archive)

| Symbol | Ticks | From → To | ~Hours |
|--------|-------|-----------|--------|
| BTCUSDT | 310 | 2026-07-29 02:20 UTC | 51h total window |
| ETHUSDT | 203 | 2026-07-29 03:16 UTC | (common end 2026-07-31 05:23 UTC) |
| BNBUSDT | 39 | 2026-07-29 05:38 UTC | |

**~2.1 days / 51 hours** — not ≥8 weeks; checkpoint only.

## Full portfolio sim ($100 start, equal 3-coin split)

| Metric | Value |
|--------|-------|
| Trades | **81** (~38/day portfolio) |
| Net P&L | **−$23.70** (−23.7%) |
| Final equity | $76.30 |
| Win rate | 37% |
| Profit factor | 0.43 |
| Max DD | 25.1% |

### P&L by exit (portfolio)

| Exit | Net $ |
|------|-------|
| TP | **+$17.58** |
| SL | **−$39.85** |
| Flip | −$1.39 |

TP increase to 5× ATR **works for TP leg** (+$17.6 gross contribution), but **stop losses dominate**.

## Per-coin (unit sim, pre-replay)

| Coin | Trades | Unit net $ |
|------|--------|------------|
| BTC | 34 | −9.34 |
| ETH | 40 | −12.32 |
| BNB | 7 | −1.45 |

## Decision

**REJECT** for deploy — even on all available tick data, smoke 1m portfolio is **deep red** after realistic costs. Frequency is high (~38 trades/day) but edge is negative; SL geometry + churn > TP gains.

**Next honest lever (one change):** raise selectivity (min liq $ / z / disp) — not wider TP alone.

Artifact: `scripts/.liq-cascade-max-backdata-smoke-1m.json`
