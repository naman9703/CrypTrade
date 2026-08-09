# ST BNB — lower trailBufferRate (one change)

**Date:** 2026-08-08  
**Hypothesis:** Baseline `trailBufferRate=0.015` (1.5%) delays ST trail activation past typical loser MFE; winners clear ~2%+ so they lock.  
**One change:** `trailBufferRate: 0.015 → 0.003`.  
**Base:** ATR×3, trail on, fixed TP off, flip off, SUPERTREND trail mode.  
**Window:** 2025-01-01 → 2026-08-02 · BNBUSDT 15m

| | buf 0.015 | buf 0.003 |
|--|--|--|
| Trades | 621 | 826 |
| /day | 1.07 | 1.43 |
| WR | 42.7% | 70.5% |
| PF | 0.654 | 0.192 |
| Return % | -71.9 | -97.1 |
| Max DD % | 71.9 | 97.1 |
| SL-loss w/ trailStep | 0.3% | 0.0% |
| Exits | {"sl":568,"trail":53} | {"sl":308,"trail":518} |

## Verdict

No material lift (or worse). Archive this buffer cut or try intermediate (e.g. 0.002).
