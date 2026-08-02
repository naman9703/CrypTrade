# MICRO_EVENT — hydration fix + live radar panel (2026-08-02)

## Changes shipped

1. **Two-way futures** — `supertrendFuturesTwoWay: true` in `MICRO_EVENT_ACTIVATION_PATCH` so continuation SELL can open shorts (was silently skipped as `no_futures_long`).
2. **Live/demo time-stop meta** — `entryMetaByPosition` map in `binanceLiveFuturesUsdM.js` + `binanceDemoFuturesUsdM.js`; merged into `getPositions().meta` (`strategyKey`, `maxHoldSec`, `entryTime`, `confluenceScore`).
3. **Backtest hydration** — `microEventBacktestHydration.js`: CVD from `futures_agg_trades`, funding from `historical_funding_rates`/REST, OI from `openInterestHist` (bounded lookback), macro from calendar JSON. Book imbalance documented as live-only gap.
4. **Live radar** — `microEventRadarStatus.js` + `MicroEventRadarPanel.tsx` between Portfolio and Chart; readiness gates, per-detector rows, signal/skip tape, open positions.
5. **Hardening** — skip telemetry throttle (prior), per-symbol eval serialization, quota only after `placed`, `checkMicroEventFrequencyGate` in order path, `detectFundingCrowd` continuation/fade fix, bar-close cooldown via `lastFireMs`.

## Validation run (partial)

Attempted: `FROM=2026-01-01 TO=2026-02-01 SKIP_ENSURE=1 node scripts/backtest-validate-micro-event.mjs`

- IS window: **n=0** trades (DB not available for force_orders hydration mid-run — `ECONNREFUSED 127.0.0.1:54333`).
- **Next step:** start Timescale (`docker compose up -d`), re-run full validate on 2024-06→2026-06 window; expect non-zero N if liq+CVD+funding layers stack in hydrated replay.

## Verdict

**Engineering checkpoint — not certified deployable.** Live tick path can fire with full microstructure; backtest path now *can* stack confirm layers when DB + aggTrade cache populated. OOS PF / ≥30 trades / gates **pending** full validate re-run.
