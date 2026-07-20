# Experiment: BTC day-type router (range fade + trend continuation)

- **Window:** 2025-01-01 → 2026-01-01, BTCUSDT 15m, 2% risk, no context filter
- **Hypothesis:** Routing range days → classical fade and breakdown/breakout → trend continuation fixes PnL leak AND raises frequency toward 1/day
- **Script:** `research-liq-btc-day-router.mjs`

## Result: **REJECT naive router for app**

| ID | Variant | Trades | t/day | Return% | PF | Classical | Trend |
|----|---------|--------|-------|---------|-----|-----------|-------|
| A | Baseline classical | 22 | 0.06 | +8.0 | 0.78 | 22 / 0.78 | 0 |
| B | Breakdown veto only | 3 | 0.01 | +4.1 | **1.55** | 3 / 1.55 | 0 |
| C | Day router loose | 195 | 0.53 | −87.0 | 0.12 | 2 / 99 | 193 / 0.09 |
| D | Router strict disp | 187 | 0.51 | −83.8 | 0.12 | 3 / 1.73 | 184 / 0.10 |
| E | LIQ_DAILY trend params | 105 | 0.29 | −68.2 | 0.23 | 0 | 105 / 0.23 |
| F | Short-cont only | 47 | 0.13 | −37.9 | 0.25 | 0 | 47 / 0.25 |
| G | Veto + 4 picks/day | 3 | 0.01 | +4.1 | 1.55 | 3 | 0 |

## Why it failed

1. **Trend continuation module is not BTC-viable** — `evaluateTrendContinuationSetup` fires on ~50% of days and loses at PF 0.09–0.25 even with displacement-only + ADX≥20.
2. **Classical on range days** — only **2–3 trades/year** pass all gates on non-trend days (119 range days in 2025, almost no qualifying sweeps).
3. **More picks/day (G)** does not help — only 3 setups qualify after breakdown veto.
4. **Frequency target (~1/day) cannot be met** by wiring existing trend continuation without rewriting it.

## Day-type distribution (BTC 2025)

- Breakdown days: 108
- Breakout days: 123
- Range days: 119
- Both: 15

Router adds trades on trend days, but those trades are toxic with current continuation logic.

## Next step (before app)

1. **Do not ship** `INTRADAY_PRO_LIQ_BTC_DAY_ROUTER_15M` as-is.
2. **Ship breakdown veto** as optional quality mode (B) — user accepts ~3 trades/year.
3. **Rewrite trend-day playbook** for BTC (pullback after break + displacement, not EMA fade spam) OR accept classical-only at 0.06/day.
4. Investigate why only 3 classical trades on 119 range days — separate funnel work.
