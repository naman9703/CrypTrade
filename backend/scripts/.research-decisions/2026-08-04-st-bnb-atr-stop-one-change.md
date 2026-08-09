# ST BNB 15m — ATR stop (one change)

**Date:** 2026-08-04  
**Hypothesis:** Instant SL chop from 0.3% fixed stop inside 15m noise (autopsy: 72.5% of SLs on XGB@0.09 run died in ≤2 bars).  
**One change:** `slAtrMultiplier` (ATR path precedes fixed 0.3% SL in `computeStopPct`).  
**Window:** 2025-01-01 → 2026-08-02 · BNBUSDT 15m · start $10k · same bot cfg as baseline `db6a6e92` (no XGB).

| | Fixed 0.3% SL | ATR×2 | ATR×3 |
|--|--|--|--|
| Trades | 591 | 725 | 752 |
| WR | 18.4% | 38.9% | 48.4% |
| PF | 0.436 | 0.613 | 0.659 |
| Return % | −100.0 | −95.3 | −78.1 |
| Max DD % | 100.0 | 95.5 | 78.1 |
| SL ≤2 bars | 61.0% | 20.1% | **5.7%** |

## Verdict

- **Hypothesis confirmed:** wider ATR stops crush instant-chop (61% → 6% at ATR×3).
- **Not profitable:** best PF still **0.66**, return still deep red. Stop geometry was necessary but not sufficient.
- **XGB thresholds alone cannot fix this** — re-attach XGB only after ungated ST is closer to PF ≥ 1.

## Next (one change)

1. Enable **trail** (`trailingStopLossAuto=true`) with ATR×3 initial SL (exit contract), **or**
2. One **RSI / dist_ema20** skip from XGB importance on ATR-stop trade set, **or**
3. Risk kill-switch so ruin does not hide expectancy — not as the primary return lever.

Script: `backend/scripts/research-st-atr-stop-bnb.mjs`
