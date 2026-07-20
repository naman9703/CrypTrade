# 2026-07-16 — ETH VP FREQ rejection wick + regime stack decisions

**Goal:** make FREQ robust across bull / squeeze-bear / clean-bear — behaviour by
condition, not trade-count crush.

## Already locked (kept)

1. Macro-adapt SELL HTF (bull grind 2023–24)
2. Chop-only SELL MFE giveback trail (VAL whipsaw)

## New change locked: `vpRejectionMinWickRatio = 0.35`

**Hypothesis:** thin VA rejections (tiny wick pierce) are noise; real rejects need
wick dominance.

Full sim 2022-06 → 2026-05 (vs macro+chop baseline):

| | N | Ret | DD | 22–23 | 23–24 | 24–25 | 25–26 |
|--|--:|--:|--:|--:|--:|--:|--:|
| Baseline | 263 | +145% | 50% | −1.5% | 0.0% | +13% | +119% |
| **Wick 0.35** | **259** | **+184%** | **48%** | −1.5% | **+4.2%** | **+22%** | **+127%** |

−4 trades / 4y. **No year regresses.** 2023–24 flips positive.

## Rejected variants (isolated A/B)

| Variant | Why rejected |
|---------|----------------|
| Close-depth always (0.35) | 2022 +3% but **2023–24 −4%** |
| Depth + extended-only + vacuum max-path non-bull | 2022/23 both worse |
| Global `vpBuyBreakoutMaxPathPct=0.02` | Helps 22/25, **2023–24 −6%**, N crush 263→~46/yr |
| Full rej+path stack | +231% headline but 2023–24 −10%, N 163 |

Code retains depth / max-path knobs for research; ETH FREQ leaves them **off**.

## Still open (2022–23 still ~−1.5%)

Vacuum VAH + residual chop — needs a playbook that does not free bull-year day
slots to worse shorts. Next isolated experiment after this lock.

## Status

Research lock on ETH FREQ. Not WF+MC certified.
