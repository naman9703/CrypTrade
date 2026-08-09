# ST BNB — FEE_LADDER trail (one change)

**Date:** 2026-08-08  
**Hypothesis:** ST tiered trail fails to lock BE on giveback losers (MFE≥0.1% but trailStep≈0). FEE_LADDER activates fee tiers without ST gate.  
**One change:** `futuresTrailingStopMode: SUPERTREND → FEE_LADDER`.  
**Base:** ATR×3, trail on, fixed TP off, flip off.  
**Window:** 2025-01-01 → 2026-08-02 · BNBUSDT 15m

| | ST trail | FEE_LADDER |
|--|--|--|
| Trades | 621 | 605 |
| /day | 1.07 | 1.05 |
| WR | 42.7% | 40.2% |
| PF | 0.654 | 0.604 |
| Return % | -71.9 | -83.3 |
| Max DD % | 71.9 | 83.3 |
| SL w/ trailStep | 37.5% | 35.3% |
| Exits | {"sl":568,"trail":53} | {"sl":558,"trail":47} |

## Verdict

No material lift (or worse). Archive FEE_LADDER for this stack; next named hyp (earlier BE buffer / disaster SL).
