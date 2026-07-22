# 2026-07-21 — SOL VP FREQ certification gap analysis + lock update

## Aim

Make SOLUSDT VOLUME_PROFILE_FREQ **reliable OOS** (survive unseen regimes like live) and **clear the certification harness** (WF + MC + 4 gates + extras).

## Starting gaps (H9 VAL-only lock)

| Gap | Evidence | Why it blocks live trust |
|-----|----------|--------------------------|
| **MC p5 &lt; 0** | Cert −6.0% | Left-tail path can lose money |
| **Calmar &lt; 1** | 0.55 | Return not worth drawdown |
| **2021–22 red on harness** | −9% | Hard-regime survival incomplete |
| **Frequency ≪ 2/wk** | 0.55/wk | Not standalone-deployable |
| **slip×4 fragile** | −47% | Execution stress fails |

## Named failure modes → one-change path

| Step | Hypothesis | Change | Result |
|------|------------|--------|--------|
| H8 | Prepared rejection can restore N without VAH bleed | Allow `va_rejection` + extended-down block + wick 0.35 | +222% / Cal 0.69 / MC p5 ≈0 / fold years mostly green — **progress** |
| H8b | Weak rejection wicks inflate left-tail R | `vpRejectionMinWickRatio: 0.40` | MC p5 **+8%**, Calmar **0.97**, all years ≥0 |
| H8c | Shallow HTF losers cap Calmar | `vpMinHtfSepPct: 0.002` | **Calmar 1.06**, MC p5 **+9.5%**, ret **+303%**, 186t — **core MC+Calmar PASS** |
| H8d | WF fold0 VAL relief-bounce (prior5−prior20 &gt; 15%) | `vpValSellBlockReliefBounce` | Harvest flipped fold0; **full resim REJECT** (Calmar 0.85, 2025–26 −13%, WF worse) |

## Locked preset (`VOLUME_PROFILE_FREQ_SOL_15M`)

```text
vpAllowedSetups: ["val_breakdown", "va_rejection"]
vpRequireHtfAlign: true
vpMinHtfSepPct: 0.002
vpValSellRequirePrior60dBear: true
vpValSellPrior60dBearPct: -0.05
vpRejectionSellBlockExtendedDown: true
vpRejectionExtendedPriorPct: 0.05
vpRejectionMinWickRatio: 0.4
vpNoveltyEnabled: false
```

UI: ★ SOL FREQ (VAL+rej wick40)

## Certification harness (2026-07-21) — locked preset

**Script:** `backtest-validate-vp-freq-sol.mjs`  
**Artifact:** `.vp-freq-sol-certification.json` (wick40+htf020 run before relief experiment)

| Metric | Result |
|--------|--------|
| Full | **186t / +303% / CAGR 29% / Calmar 1.06 / DD 27% / PF 1.39 / 0.66/wk** |
| Years | all ≥0 (2021–22 **+50%**) |
| MC p5 | **+9.5% PASS** |
| WF OOS sum | **+102%** on 169 OOS trades |
| WF degradation | **58% FAIL** (&lt;35% required) — fold0 testRet **−11.4%** |
| Extra | N≥30 PASS · no catastrophic year PASS · frequency FAIL |
| Cost | slip×2 +106%; slip×4 −52%; liq crunch −99% |

**Verdict: `REJECT_CERTIFICATION`**

(With relief-bounce temporarily enabled: fold0 OOS flipped green, but Calmar/WF/2025–26 regressed → **not locked**.)

## Remaining gaps to clear certification (honest)

1. **Walk-forward degradation (primary gate fail)**  
   - Fold0 (2021-11→2022-10) loses while later folds pay.  
   - Same cell (`VAL|bear_trend`) is **−$46 in fold0** and **+$245 later** — not a blanket cell ban.  
   - Relief-bounce relative rule helps fold0 in harvest but **fails full-sim year table**.  
   - **Next hypotheses (one at a time):** exit-model (MFE giveback only in deep-bear relief), size de-risk on high |prior60|, or prepared rejection subtype only — protect 2025–26.

2. **Frequency (0.66/wk vs ≥2/wk)**  
   - Even if core gates pass, standalone deploy needs frequency restore from **positive cells** (not reopening VAH vacuum).  
   - Portfolio sleeve path exists (`RESEARCH_SLEEVE_LOW_FREQ`) once WF degradation also passes.

3. **Cost stress**  
   - slip×4 / liq crunch still destroy equity — shared VP FREQ fragility; not SOL-unique.

## What improved vs prior H9

| | H9 VAL-only | Locked H8+wick40+HTF020 |
|--|------------|-------------------------|
| Full ret | +111% | **+303%** |
| Calmar | 0.55 | **1.06** |
| MC p5 | −6% | **+9.5%** |
| 2021–22 | −9% | **+50%** |
| Frequency | 0.55/wk | 0.66/wk (still low) |
| WF deg | (not passed) | **still FAIL 58%** |

## Honest live-trust statement

SOL VP FREQ is **materially improved** and now passes **MC p5 + Calmar + multi-year ≥0** on the lock window, but it is **not certified**: walk-forward fold0 still loses and frequency remains below doctrine. Treat as **research sleeve candidate** — do not claim live-ready OOS robustness until WF degradation clears without year-table sacrifice.

## Artifacts

- `.vp-freq-sol-wick-sweep.json`, `.vp-freq-sol-wick40-calmar.json`
- `.vp-freq-sol-relief-ab.json`, `.vp-freq-sol-certification.json`
- Filter knob (off by default on SOL): `vpValSellBlockReliefBounce` / `vpValSellReliefBounceMaxPct` / optional `vpValSellReliefBounceMinPrior60dPct`
