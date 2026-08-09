# ST BNB — trailBufferRate calibration (0.015 → 0.003)

**Date:** 2026-08-08  
**Prior:** 0.0005 engaged trail but PF→0.23 (noise scratches).  
**One change:** `trailBufferRate: 0.015 → 0.003` (same activation-buffer hyp, mid calibrate).  
**Base:** ATR×3, trail on, fixed TP off, flip off.  
**Window:** 2025-01-01 → 2026-08-02 · BNBUSDT 15m

| | buf 0.015 | buf 0.003 |
|--|--|--|
| Trades | 621 | 826 |
| WR | 42.7% | 70.5% |
| PF | 0.654 | **0.192** |
| Return % | −71.9 | **−97.1** |
| Exits | trail 53 | trail 518 |

## Verdict

**REJECT.** Any material buffer cut below 1.5% → noise trail / ruin. Keep **0.015**. Exit-buffer stream closed.

## Stream status (BNB ST 15m)

Best still: ATR×3 + trail + no fixed TP + buf 0.015 + flip off → PF ~0.65 / −72%.  
Exit contract changes exhausted for lift. **Next = entry context** (one gate), not more trail knobs.
