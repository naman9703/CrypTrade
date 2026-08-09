# ST BNB — flip exit on ATR×3+trail+noTP (one change)

**Date:** 2026-08-08  
**Hypothesis:** Full ATR SL holds through adverse ST flips; exit on flip cuts losers earlier.  
**One change:** `supertrendFuturesExitOnFlip: false → true`.  
**Base stack:** ATR×3 SL, trail on, fixed TP off.  
**Window:** 2025-01-01 → 2026-08-02 · BNBUSDT 15m

| | Flip off | Flip on |
|--|--|--|
| Trades | 621 | 841 |
| /day | 1.07 | 1.46 |
| WR | 42.7% | 37.3% |
| PF | 0.654 | 0.646 |
| Return % | −71.9 | **−93.0** |
| Max DD % | 71.9 | 93.0 |
| Exits | sl 568 / trail 53 | sl 556 / flip 227 / trail 58 |

## Verdict

**REJECT.** Flip raises N (+220) and deepens ruin (−21pp return). Cuts winners too (WR 42.7%→37.3%). Archive flip-on for this stack.

## Autopsy → next hyp

On flip-off base: **72% of SL losers** had MFE≥0.1% but **`trailStep>0` on ~0.3%** of them — ST tiered trail never locks BE on the giveback path. Next one-change: `futuresTrailingStopMode: FEE_LADDER` (earlier fee-tier BE without ST gate).
