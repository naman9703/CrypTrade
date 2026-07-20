# 2026-07-20 — BNB VP FREQ certification reject (improved, not yet sleeve)

## Experiment

- **Baseline:** frozen `VOLUME_PROFILE_FREQ_BNB_15M`
- **Window:** BNBUSDT futures 15m, **2020-01-01 → 2026-05-31**
- **Script:** `backtest-validate-vp-freq-bnb.mjs`
- **Prior best pre-cert stack:** VAL-only + bull60 dump/non-vac/extending + weak_bear vacuum block + prepared bear vacuum block

## What changed vs prior BNB lock candidate

BNB got its own coin-native lock instead of inheriting the legacy mixed `vah+val` funnel or ETH overlays:

| Layer | Rule | Why |
|-------|------|-----|
| Funnel | `vpAllowedSetups: ["val_breakdown"]` | VAH continuation/vacuum bleed was the main multi-year destroyer on BNB |
| Shared physics | `vpValSellBlockBull60Dump`, `vpValSellBlockBull60NonVac`, `vpValSellBlockBull60Extending` | Residual bull60 VAL shorts fail on BNB too; relative rule kept more edge than a blunt bear-only lock |
| Prepared weak-bear | `vpValSellBlockWeakBearVacuum`, `vpPreparedBlockVacuumValBear` | Unprepared vacuum VAL cells still bleed; keep structured/bear winners |
| **H7** | `vpValSellBlockFlatPrior60` | Flat/transition prior60 slice was a repeat bleed (about -$23 multi-year) |
| **H8** | `vpValSellChaseFilter` @ **5%** prior5d | Sharp 5d rally shorts were squeeze/chase losses (about -$42 multi-year) |

Rejected along the way: VAH reopen variants, ETH `volTargetSizing` copy, flat chop exit overlays, stronger HTF hardening as a certification fix, and blanket weak-bear vacuum ceilings that crushed lock runners.

## Validation result

- Full window: **108 trades / +260.7% / CAGR 22.6% / Calmar 0.96 / DD 23.4% / PF 1.72**
- Jun→May years: **no catastrophic year** (worst **-8.2%** in 2022-23; 2023-24 **-6.7%**)
- Monte Carlo (1% risk): **p5 +15.8%**, ruin 0.0%
- Expanding purged WF: OOS sum **+210.5%** on **87** OOS trades
- Core gates: **FAIL** only on **Calmar > 1** (`0.96`)
- Extra gates: OOS N≥30 **PASS**, catastrophic year **PASS**, frequency **FAIL** (**0.32/wk** < 2)

## Cost stress

| Scenario | Return | DD |
|----------|-------:|---:|
| slip×2 | **+127.9%** | 25.6% |
| slip×4 | **+57.3%** | 30.0% |
| liq crunch | **-78.2%** | 79.0% |

Cost robustness is better than the earlier BNB funnels, but liquidity-crunch fragility is still too high for promotion language.

## Verdict

**REJECT_CERTIFICATION.**

Why:

1. This is a real improvement over prior BNB candidates and now passes OOS / MC / catastrophic-year checks
2. It still misses the core Calmar gate (**0.96 < 1.0**)
3. Frequency is far below standalone doctrine (**0.32 trades/week**)

## Config locked for current BNB research baseline

```text
vpAllowedSetups: ["val_breakdown"]
vpValSellBlockBull60Dump: true
vpValSellBlockBull60NonVac: true
vpValSellBlockBull60Extending: true
vpValSellBull60ExtendRatio: 0.6
vpValSellBlockWeakBearVacuum: true
vpPreparedRegimeOnly: true
vpPreparedBlockVacuumValBear: true
vpValSellBlockFlatPrior60: true
vpValSellFlatPrior60LoPct: -0.05
vpValSellFlatPrior60HiPct: 0.05
vpValSellChaseFilter: true
vpValSellChaseMaxPrior5dPct: 0.05
vpNoveltyEnabled: false
```

Artifact: `backend/scripts/.vp-freq-bnb-certification.json`
