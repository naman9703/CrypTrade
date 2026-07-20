# FIX — ETH FREQ UI backtest crushed by BTC novelty bleed (2026-07-19)

## User report

UI VOLUME_PROFILE ETH 15m on multi-year OOS (incl. 2020/2021) showed
**158t / +238% / DD 29.3%**, while research lock stack was ~**+500–650%** class.

## Root cause (reproduced exactly)

`buildBacktestAdapters` auto-attached `attachVpNoveltyMonitorToCfg` for every
`vpPlaybook=FREQ` run (`vpNoveltyEnabled !== false`). That injects **BTC**
`DEFAULT_BTC_BLEED` / `DEFAULT_BTC_PREPARED` cells.

On ETH, bleed abstain blocks vacuum VAL/VAH edges that **pay** on ETH.

Same window 2020-06→2026-05, same filled H1–H4 preset:

| Path | N | Ret | DD |
|------|---|-----|-----|
| fill + direct adapter | 240 | **+537.8%** | 39.4% |
| fill + `buildBacktestAdapters` (BTC novelty) | **158** | **+238.0%** | **29.3%** |

Second row = exact UI result.

## Fix

1. Novelty monitor is **opt-in** (`vpNoveltyEnabled === true` only).
2. ETH FREQ preset sets `vpNoveltyEnabled: false`.
3. Worker skips LIQ/SMC `materializeIntradayEngineCfgSync` for `VOLUME_PROFILE`.

## Doctrine

- OOS includes hard years (2020/2021) — never “fix” by excluding them.
- Coin-native cell lists only; never default BTC bleed onto ETH.
- Research scripts and UI backtest path must share the same signal filters.

## Apply

Restart backend → ★ ETH FREQ → Save → re-run the **same** OOS window (incl. 2021).
Expect ~fill+directAdapter class metrics, not 158/+238.
