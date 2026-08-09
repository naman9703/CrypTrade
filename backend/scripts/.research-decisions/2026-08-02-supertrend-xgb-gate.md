# Supertrend XGB gate — first train (CSV 7b7d8123)

**Date:** 2026-08-02  
**Source:** `Downloads/backtest-7b7d8123-trades (3).csv` (1751 labeled rows, RR>0 label)  
**Artifact:** `ai-service/data/model/supertrend_xgb.pkl`  
**Model:** HistGradientBoostingClassifier · threshold **0.12**

## Splits (time-ordered 60/20/20) — trade-level A/B

| Split | Baseline n | Gated kept | keep_frac | WR | mean R | PF |
|-------|------------|------------|-----------|----|--------|-----|
| Val | 350 | 178 | 0.509 | 0.258 | -0.029 | 0.967 |
| OOS | 351 | 189 | 0.538 | 0.233 | -0.170 | 0.812 |
| OOS baseline (ungated) | 351 | 351 | 1.000 | 0.174 | -0.437 | 0.558 |

## Gates

- freq_ok_val (≥50% keep on val): **True**
- oos_pf_ge_1: **False**
- oos_mean_r_positive: **False**

## Top importance

- vol_vs_avg20: 0.0622
- body_pct: 0.0414
- dist_ema20_pct: 0.0380
- rsi14: 0.0378
- dist_swing_low_pct: 0.0254
- atr_percentile: 0.0235
- upper_wick_pct: 0.0127
- dist_swing_high_pct: 0.0116

## Verdict

Trade-level gated OOS vs baseline is above. Gated mean R / PF can look better while still deep red vs costs if baseline is deeply negative — **not deployable**.

**Full sim A/B** (panel → Apply gate & re-backtest) still required with Docker/DB; harvest metrics alone are not live language.

Promote language only if full-sim OOS ret>0, PF≥1, n≥30, and frequency ≥50% of baseline (target ≥2/wk when window allows).

Live gate: **blocked** (freq_ok=True, oos_pf_ge_1=False, oos_mean_r_positive=False).
