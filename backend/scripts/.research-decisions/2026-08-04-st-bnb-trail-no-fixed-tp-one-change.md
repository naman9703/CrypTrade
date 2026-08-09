# ST BNB — ATR×3 + trail, drop fixed TP (one change)

**Date:** 2026-08-04  
**Prior:** Trail-on with fixed 1% TP = zero engagement.  
**Hypothesis:** Fixed TP races / starves ST trail; exit contract should be ATR initial SL + Supertrend trail (Elite-style).  
**One change vs trail-on+ATR×3:** `supertrendFuturesUseFixedTp: false`, `supertrendFuturesFixedTpPct: 0`.  
**Window:** 2025-01-01 → 2026-08-02 · BNBUSDT 15m

| | ATR×3 + trail + fixed TP 1% | + trail, **no fixed TP** |
|--|--|--|
| Trades | 752 | 621 |
| PF | 0.659 | 0.654 |
| Return % | −78.1 | **−71.9** |
| Exits | sl/tp only | sl 568 / **trail 53** |
| `trailStep>0` | 0% | **42.8%** (max step 13) |

## Verdict

Trail **works** once fixed TP is off (53 trail exits). Slightly less red (−72% vs −78%) but **still deep red**, PF≪1. Frequency still high (~1+/day). **Not profitable.**

Fewer trades = longer runners occupying the slot (flip exit still off).

## Next (named)

Most losers still full ATR SL (568). One change: enable **ST flip exit** (`supertrendFuturesExitOnFlip: true`) on ATR×3 + trail + no fixed TP — cut adverse structure sooner without N-crush filters.
