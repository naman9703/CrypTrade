# ST BNB — 4H Supertrend alignment (one change)

**Date:** 2026-08-08  
**Hypothesis:** Counter-4H 15m flips are structure-against-context losers; require HTF ST agree.  
**One change:** `supertrendHtf4hEnabled: false → true`.  
**Base:** ATR×3, trail on (buf 1.5%), fixed TP off, flip off.  
**Window:** 2025-01-01 → 2026-08-02 · BNBUSDT 15m

| | No HTF4H | HTF4H on |
|--|--|--|
| Trades | 621 | 382 |
| /day | 1.07 | **0.66** (~4.6/wk) |
| WR | 42.7% | 41.1% |
| PF | 0.654 | **0.695** |
| Return % | −71.9 | **−40.8** |
| Max DD % | 71.9 | **41.5** |
| HTF veto | — | 388 (186 short@bull / 198 long@bear) |

## Verdict

**Keep.** Named context gate helps (+31pp return, PF↑, DD↓) without N-crush (still ≥0.5/day). **Not yet profitable.** New base for next one-change.
