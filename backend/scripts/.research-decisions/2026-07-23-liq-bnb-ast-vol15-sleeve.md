# LIQ BNB AST + vol15 — RESEARCH_SLEEVE_LOW_FREQ (not live)

**Date:** 2026-07-23  
**Stream:** LIQ classical fade on BNB (not VP)  
**Preset:** `INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M`  
**Artifact:** `backend/scripts/.liq-bnb-l0-vol-hard-ab.json`, `.liq-bnb-l0-feature-autopsy.json`

## Hypothesis

Under Asia + same-bar + toxic + maxSl 0.8% + prem/disc align (**L0 / AST_sl08_loc**), residual H12/Y2026 bleed is dominated by **weak-volume sweeps** (soft: keep `sweepVolSpike ≥ 1.5` flips H12 and Y26 positive). One hard change: raise `intradayLiqSweepMinVolRatio` from CORE inheritance (~0.9) to **1.5**.

## Hard results (BNB 15m, fees+slip, 2023-07→2026-07)

| Variant | Y25 | H12 | Y24 | Y26 | FULL | tw/wk |
|---------|-----|-----|-----|-----|------|-------|
| L0 (no vol lift) | 1.60 / +16 n=19 | 0.82 / −8 | 0.97 / −1 | 0.33 / −17 | 1.04 / +3 | 0.34 |
| **vol15** | **1.55 / +11 n=14** | **1.55 / +11** | **2.22 / +15** | **1.19 / +1.4** | **1.56 / +26** | **0.21** |
| vol12 | 1.62 / +17 | 1.27 / +8 | 1.64 / +12 | 0.76 / −3 | 1.36 / +25 | 0.28 |
| vol18 | 1.36 / +6 | 1.76 / +10 | 2.54 / +14 | 2.33 / +5 | 1.66 / +24 | 0.17 |
| vol15_noSess | 1.62 / +11 | 1.62 / +11 | 3.00 / +19 | 1.19 / +1.5 | 1.85 / +33 | 0.19 |

**vol15** is the locked research stack: sole one-change on L0 that greens **Y25 + H12 + Y26 + FULL**.

## Honesty residuals

- Frequency **~0.21/wk** ≪ ≥2/wk deploy floor → label **`RESEARCH_SLEEVE_LOW_FREQ`** only.
- Half-years still bleed early sample: Y23H2 / Y24H1 slightly negative under vol15; do not claim year-uniform edge.
- N per calendar year is small (Y26 n=4). Do **not** promote without WF + MC + ≥30 OOS trades.
- Do **not** rewrite CORE defaults yet — sleeve is opt-in research preset.

## Rejected / not promoted from this pass

- max1/day, macro alone, tighter SL alone: did not flip H12 on L0 without vol.
- Soft `adx < 22`: tiny N / cherry-pick risk — not wired.
- `drop_pdh` / levels=`pdl`: crushed N / FULL negative.
- Progress-confirm / hybrid / ACCEPT: prior REJECT (unchanged).

## Next

1. WF + MC + 4-gate harness on `INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M`.
2. Frequency restore only after expectancy holds (multi-coin breadth or relative rule — not veto crush).
3. Optional isolated A/B: `vol15` + session extremes off (higher FULL in this sample) — one change after vol15 lock.
