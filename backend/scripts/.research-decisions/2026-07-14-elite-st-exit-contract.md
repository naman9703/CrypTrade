# Decision — Elite ST exit contract locked (live = backtest)

Date: 2026-07-14

## Contract

**Trail-only Supertrend + exit-on-flip.** No fixed %-SL/TP brackets. No disaster SL.

Canonical object: `ELITE_ST_EXIT_CONTRACT` / `applyEliteStExitContract()` in
`backend/src/strategy/supertrendElite.js`.

| Key | Value |
|-----|-------|
| `trailingStopLossAuto` | true |
| `futuresTrailingStopMode` | SUPERTREND |
| `supertrendFuturesExitOnFlip` | true |
| `supertrendFuturesUseFixedSl` | **false** |
| `supertrendFuturesUseFixedTp` | **false** |
| `supertrendFuturesFixedSlPct` | 0 |
| `supertrendFuturesFixedTpPct` | 0 |
| `eliteStAutoBracketMode` | OFF |
| Trail knobs | `ELITE_ST_TRAIL_PATCH` (fee BE, buffer 0.05%, no ATR buffer / post-T02 crush) |

Sizing: `RISK_AT_SL` uses synthetic sizing stop via `backtestSizingStopPct` (default 1%)
when exit SL is off — bracket-off does not force 1% notional fallback.

## Aligned

- `SUPERTREND_ELITE_1H_PRESET` (and variants that spread it)
- `ELITE_ST_ACTIVATION_PATCH`
- `backtest-validate-supertrend.mjs`
- `backtest-portfolio-supertrend.mjs`
- `research-phase3a-validate-stream.mjs` (SUPERTREND_ELITE path)

## Why

Prior “deployable” CAGR used non-representative trailing (research trail-only vs
panel 0.2%/1.5% brackets / `useFixed*` defaulting on). This contract is the only
exit model allowed for honesty re-validation.

## Next

Sanity check → full WF/MC/gates + portfolio → PROMOTE or REJECT decision.

## Sanity (2026-07-14)

BTCUSDT 15m 2026-01→2026-04 under contract: brackets OFF; 3 trades all `exitReason=trail`;
`initialRiskUsd` > 0 on all; **PASS**.
