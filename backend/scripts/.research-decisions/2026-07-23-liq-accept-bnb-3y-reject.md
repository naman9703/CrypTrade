# LIQ_ACCEPT BNB 3y — REJECT (2026-07-23)

## Hypothesis

Classical sweep+reclaim **fade** fails on BNB (PF ~0.53 full / 0.60 holdout) because ~78% of loss $ is instant no-follow. Many sweeps are **false reclaims** — auction accepts the pool pierce and continues. **LIQ_ACCEPT** enters WITH the sweep after hold-beyond confirms failed reclaim (SL back inside pool, TP at next liquidity in trade direction).

## Implementation

- `scanAcceptanceCycles`, `listAcceptanceSetups`, `computeAcceptanceBrackets` in `liquidity.js`
- Wired in `intradayPro.js` fast path when `intradayLiqPlaybook: "LIQ_ACCEPT"`
- Preset `INTRADAY_PRO_LIQ_ACCEPT_BNB_15M` + `fillLiqSoloPresetDefaults` branch
- Validation: `backend/scripts/research-liq-accept-bnb-3y-validate.mjs`
- Artifact: `.liq-accept-bnb-3y-validate.json`

## Window

BNBUSDT 15m · 2023-07-01 → 2026-07-01 · holdout 2025-07-01+

## Results (honest)

| Variant | Full n | /wk | Full PF | Hold ret% | Hold PF |
|---------|--------|-----|---------|-----------|---------|
| CORE (X4+T1+P1) | 1056 | 6.74 | 0.534 | **-0.99** | **0.598** |
| ACCEPT H0 hold2 | 1079 | 6.89 | 0.432 | -0.16 | 0.460 |
| ACCEPT H1 hold1 | 1215 | 7.76 | 0.409 | -0.02 | 0.465 |
| ACCEPT H3 hold3 | 982 | 6.27 | 0.373 | -0.13 | **0.552** |
| ACCEPT no minExt | 1135 | 7.25 | 0.389 | -0.05 | 0.420 |
| ACCEPT HTF align | 997 | 6.37 | 0.530 | -0.57 | 0.476 |
| ACCEPT maxTpRr=3 | 1069 | 6.83 | 0.409 | -0.12 | 0.408 |

**Frequency:** OK (~6–8/wk). **Edge:** FAIL all variants — holdout return ≤ 0, PF < 1, MC p5 ≈ 0, Calmar < 1.

## Verdict

**REJECT promote.** LIQ_ACCEPT does not beat CORE on holdout PF; slight holdout return improvement on H1/H3 (-0.02% / -0.13%) is noise vs PF degradation and still negative expectancy.

## Root cause (accept stream)

Continuation entries after failed reclaim still suffer same post-entry pathology: low WR (~25–28%), full-R SL mass, no separable entry gate found in this pass.

## Next (ordered)

1. **Hybrid router with evidence** — e.g. multi-bar reclaim fade + breakdown accept only if coin-native holdout A/B passes (not EOD day-router spam).
2. **Exit / path layer on best holdout cohort** — oracle skip-instant still ~PF 2.5 on CORE; need separable pre-entry or early-path rule without clipping runners.
3. **Coin-native per-level tuning** — BNB session cluster vs PDH/PDL acceptance rates before ETH/BTC ports.

**No live lock.** CORE remains research baseline; ACCEPT available as opt-in playbook only.
