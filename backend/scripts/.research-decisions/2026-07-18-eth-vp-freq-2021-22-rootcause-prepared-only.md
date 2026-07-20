# 2026-07-18 — ETH 2021–22 ROOT CAUSE resolved (prepared-only abstain)

**Mandate:** Trade only conditions the setup is optimized on. Abstain unfavourable /
unoptimized OOS regimes so capital does not bleed. Reliability for live > max curve.

**Autopsy:** `research-vp-freq-eth-2122-root-cause.mjs`  
**A/B:** `backtest-vp-freq-eth-2122-prepared-only-ab.mjs`

---

## Root cause (reverse engineered)

Under H1+H2, 2021–22 was still **49t / −$20 / −20.5%**.

| Attribution | Net | Meaning |
|-------------|----:|---------|
| SELL `val_breakdown` | **−$19.6** | Entire year hole |
| of which VAL in **bull60 / flat60 / weak_bear** | most of bleed | Shorts into residual blow-off & transition — **not** clean bear |
| of which VAL `bear60` | −$1.8 | Mild — prepared regime |
| BUY `va_rejection` | **−$8.1** | Thin unproven in bull_trend blow-off |
| BUY `vah_breakout` | **+$10.9** | Keep — worked |

**Market character 2021–22:** blow-off residual then crash. Entries had **55% bull60**,
avg prior60d **+15.7%**. The stack’s edge was trained on **clean bear VAL follow-through**
(2025–26: 57% bear60, prior60d −6%). Same detector, wrong auction state.

**Ambiguous vacuum+bull60** (pays 2025–26, bleeds 2021–22) is the same root class:
VAL short while 60d return is still elevated. Until a finer discriminator exists,
**abstain** that class for live reliability (do not keep trading it and hoping).

---

## Optimum solution (prepared-only)

| Rule | Behaviour |
|------|-----------|
| `vpValSellRequirePrior60dBear: true` (−5%) | **VAL shorts only in bear60** — prepared condition |
| `vpBuyRejectionBlockUnpreparedMacro: true` | Abstain BUY `va_rejection` in `bull_trend` / `weak_bear` |

Live contract: if tape is not bear60 for VAL (or prepared rej macro), **do not trade**
that setup — wait until those conditions are separately optimized.

---

## Full-sim A/B

| Variant | Lock 22–26 | 2021–22 | 22–23 | 23–24 | 24–25 | 25–26 |
|---------|-----------:|--------:|------:|------:|------:|------:|
| H1+H2 only | 154t / **+638%** / DD20% | **−20.5%** | +32% | +56% | +39% | +170% |
| Bear60 VAL only | 130t / +346% / DD20% | −3.1% | +43% | +46% | +30% | +79% |
| **Bear60 VAL + rej gate (LOCK)** | **126t / +288% / DD18%** | **+4.6%** | **+40%** | **+35%** | **+34%** | **+68%** |
| Bear_trend + rej (stricter) | 119t / +219% / DD18% | +8.5% | **+3%** | +35% | +34% | +88% |

**LOCK = bear60 VAL + rej gate:** first variant that turns **2021–22 green** while
keeping every trained year strongly positive. Lock return falls vs peak +638% because
we **give up ambiguous bull60 VAL edge** — required for OOS reliability.

Stricter bear_trend-only rejected as primary: crushes 2022–23 to +3%.

---

## What this means for live

- **Prepared:** VAL in bear60; VAH under existing chase/path locks; BUY rej in bull_chop/bear_trend
- **Abstain:** VAL when prior60d > −5%; BUY rej in bull_trend/weak_bear; thin unproven cells
- **Later optimize:** vacuum-into-elevated-60d shorts only if a discriminator is found —
  until then they stay off

---

## Status

Locked in `VOLUME_PROFILE_FREQ_ETH_15M` (backend + frontend).  
**Not WF+MC certified yet** — next: validation harness under this exit/entry contract.
