# 2026-07-19 — ETH VP FREQ certification = research sleeve (not standalone deploy)

## Experiment

- **Baseline:** locked `VOLUME_PROFILE_FREQ_ETH_15M` after H1–H4 + **H5/H6 + vol-target**
- **Window:** ETHUSDT futures 15m, **2020-01-01 → 2026-05-31**
- **Script:** `backtest-validate-vp-freq-eth.mjs`
- **Prior reject:** `2026-07-17-eth-vp-freq-certification-reject.md` (Calmar 0.29, MC p5 −7%, catastrophic years)

## What changed since reject (one-change research → locked stack)

| Layer | Rule | Why |
|-------|------|-----|
| H1–H4 | dump / non-vac / extending bull60 VAL + BUY rej min body | 2021–22 physics (already locked) |
| **H6** | `vpBuyBreakoutBlockBullVacuum` — abstain BUY VAH vacuum in **bull_trend** only | Fake expansion chase; keeps weak_bear vacuum VAH edge; clears catastrophic-year path |
| **H5** | `vpValSellBlockWeakBearVacuumHighPrior60` @ **15%** | Residual elevated prior60 while local HTF weak; soft ceil keeps lock +42 runner (~9.5% prior60) |
| **Vol-target** | `volTargetSizing` (ATR ref 0.5%, mult 0.4–2×) | Same entries; de-risk high-ATR regimes → Calmar 0.82→**1.37**, DD 40%→**25%** |

Rejected along the way: H1 dump widen (lock crush), cell blankets S1/S4, BTC novelty, kill-switch DD, nopoc (lock −21%), H7 fill-bar rej path (signal-bar mismatch).

## Validation result

- Full window: **225 trades / +567% / CAGR 34.4% / Calmar 1.37 / DD 25.1% / PF 1.89**
- Jun→May years: **no year ≤ −25%** (worst 2020–21 **−11.4%**)
- Monte Carlo (1% risk): **p5 +33.8%**, ruin 0.0%
- Expanding purged WF: OOS sum **+332.7%** on **184** OOS trades; all folds ≥ −9.2%
- Core gates: **PASS** (OOS>0, MC p5>0, Calmar>1, WF deg<35%)
- Extra: OOS N≥30 **PASS**, catastrophic year **PASS**, frequency **FAIL** (0.67/wk < 2)

## Cost stress

| Scenario | Return | DD |
|----------|-------:|---:|
| slip×2 | **+107.5%** | 34.7% |
| slip×4 | −53.6% | 70.1% |
| liq crunch | −97.4% | 97.7% |

Survives slip×2; fragile under slip×4 / crunch (weaker than BTC sleeve on cost stress).

## Verdict

**PROMOTE as `RESEARCH_SLEEVE_LOW_FREQ`.**

Meaning:

1. Robust enough for a **portfolio sleeve** / paper path under this exact exit+sizing stack
2. **Not** standalone deploy under the ≥2 trades/week doctrine
3. Next frequency work must be a **new positive setup family** or multi-coin breadth — not loosening H5/H6 / vacuum bull VAH

## Config locked

```text
vpBuyBreakoutBlockBullVacuum: true
vpValSellBlockWeakBearVacuumHighPrior60: true
vpValSellWeakBearVacPrior60Pct: 0.15
volTargetSizing: true
volTargetAtrPct: 0.005
volTargetMinMult: 0.4
volTargetMaxMult: 2
```

Artifact: `backend/scripts/.vp-freq-eth-certification.json`
