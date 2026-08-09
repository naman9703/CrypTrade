# ST BNB — move-quality gate (one change)

**Date:** 2026-08-08  
**Hypothesis:** HTF-aligned flips still include weak displacement; enable live-parity move-quality gate.  
**One change:** `supertrendMoveQualityGate: false → true` (defaults).  
**Base:** ATR×3, trail, no fixed TP, HTF4H on.  
**Window:** 2025-01-01 → 2026-08-02 · BNBUSDT 15m

| | MQ off | MQ on |
|--|--|--|
| Trades | 382 | **32** |
| /day | 0.66 | **0.06** |
| WR | 41.1% | 62.5% |
| PF | 0.695 | 0.609 |
| Return % | −40.8 | −2.6 |
| Max DD % | 41.5 | 3.3 |

## Verdict

**REJECT — N-starve.** −2.6% on 32 trades is not an edge; PF worsened. Do not keep MQ defaults on this stack.

## Stream checkpoint (keep)

**ATR×3 + trail (buf 1.5%) + no fixed TP + HTF4H** → 382 trades / 0.66/day / PF **0.70** / **−41%**.  
Still red; best so far. Next candidates (one at a time): retrain/reattach XGB on this stack (AI up), softer MQ score only, or coin/TF premise change — not hour filters.
