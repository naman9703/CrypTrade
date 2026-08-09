# ST BNB — ATR×3 + trailing (one change)

**Date:** 2026-08-04  
**Hypothesis:** Enable `trailingStopLossAuto` on ATR×3 initial SL to lock winners / cut giveback.  
**One change:** `trailingStopLossAuto: false → true` (mode already `SUPERTREND`).  
**Window:** 2025-01-01 → 2026-08-02 · BNBUSDT 15m

| | ATR×3 no trail | + trail |
|--|--|--|
| Trades | 752 | 752 |
| WR | 48.4% | 48.4% |
| PF | 0.659 | 0.659 |
| Return % | −78.1 | −78.1 |
| Exits | sl 388 / tp 364 | **identical** |
| `trailStep>0` | 0 | **0** |

## Root cause (not “trail bad”)

Trail **never engaged**. Baseline keeps `supertrendFuturesUseFixedTp: true` @ **1%**. Intra-bar order evaluates fixed TP **before** trail advance; on this set every trade still exits `sl`/`tp` with `trailStep=0`.

## Verdict

**No effect — not a profitability test of trailing.** Archive “trail-on alone” as a wiring/exit-contract miss. Next one-change: disable fixed TP so ST trail can run (see companion log).
