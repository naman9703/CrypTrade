# 2026-07-18 — ETH H1 LOCK: dump-into-residual-bull VAL abstain

**Process:** Phase 4 of `docs/VP_FREQ_REGIME_OPTIMIZATION_PROCESS.md`  
**Autopsy:** `2026-07-18-eth-vp-freq-2021-22-regime-autopsy.md`  
**A/B:** `backtest-vp-freq-eth-2122-h1-ab.mjs` → `.vp-freq-eth-2122-h1-ab.json`

## Named failure

2021–22 = blow-off residual / crash. Entire hole is **SELL `val_breakdown`**
(−$36), while BUY VAH is **positive**. Not shallow-HTF (already gated).  
**Universal bleed slice:** VAL when `prior60d > +5%` AND `prior20d ≤ −5%`
(dump into residual bull / dead-cat). Bleeds every year it appears; **0 trades in 2025–26**.

## One change (H1)

```text
vpValSellBlockBull60Dump: true
vpValSellBull60Pct: 0.05
vpValSellBull60DumpPrior20dPct: -0.05
```

**Not locked here:** blanket bull60, bull60 nonVac (H2), vacuum-bull60 discriminator (H3).

## Full-sim A/B

| Window | ABC (v0) | H1 dump (v1) |
|--------|----------:|-------------:|
| **Lock 2022–26** | 166t / **+484.8%** / DD24.8% | 160t / **+604.6%** / DD22.0% |
| OOS 2021–22 | −32.4% / DD41.8% | **−22.8%** / DD33.6% |
| 2022–23 | +23.9% | **+28.5%** |
| 2023–24 | +43.3% | **+56.5%** |
| 2024–25 | +38.9% | **+42.9%** |
| 2025–26 | +151.1% | **+151.1%** (unchanged) |
| Full 2020–26 | +178% / DD59% | **+310%** / DD48% |

Lock path **improved** vs the user’s ~483% class. Frequency −6 trades on lock —
not an N-crush.

## Verdict

**LOCK H1** into `VOLUME_PROFILE_FREQ_ETH_15M` (backend + frontend).  
NonVac surgical flag **removed** until H2 is isolated.

## Residual (next process cycle — do not patch)

2021–22 still **−22.8%**. Primary leftover from autopsy: **VAL bull60 vacuum**
(−$20 in 21–22) which is **+$37 in 2025–26** → year-specific; needs H3 feature
discrimination, not a blanket.

## Status

Research lock. Not WF+MC certified. Not deployable yet.
