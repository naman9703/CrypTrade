# LIQ guide audit + parity fix (2026-07-23)

## Verdict

Our classical LIQ CORE is **correct** on pierce+reclaim of PDH/PDL/session pools and chronological picks, but was **not** a full match to the reference guide — and had a **live≠backtest** defect for Asia / off-hours sleeves.

## Critical fix

Live `signal()` for LIQ solo previously called `evaluateIntradayBar`, which hard-filters UTC **07–22**. Backtests use `selectIntradayPicks` LIQ fast path (**no** that filter). AST_VOL15 `asia_accum` (00–07) traded in backtests but would be **silent live**.

**Fix:** `isLiqSoloStack` + live path → `selectIntradayPicks` (same as SMC solo).

## Guide gaps implemented (opt-in, off on CORE)

| Guide layer | Config |
|-------------|--------|
| Wick/body ≥1.5 | `intradayLiqMinSweepWickBodyRatio` |
| Follow-through 0.5 ATR / 1–2 bars | `intradayLiqRequireFollowThrough` + `FollowThroughAtrMult` / `Bars` |
| ATR stop buffer | `intradayLiqSlBufferAtrMult` |
| Fractal swing pivots | `intradayLiqLevels` includes `swing_pivot`, `SwingPivotLookback` |
| RiskGuard on AST sleeve | `maxDailyLoss: 3`, `riskConsecutiveLossLimit: 3` |
| Asia session hours on AST | `srIntradaySessionStartHour: 0`, `End: 24` |

Volume ×1.5 already proven on BNB AST sleeve — keep.

**Not** default-enabled on CORE: HTF hard EMA align, wick/body, follow-through (prior / expected N crush without coin autopsy).

## Coin tune process

`docs/LIQ_COIN_OPTIMIZATION_PROCESS.md`
