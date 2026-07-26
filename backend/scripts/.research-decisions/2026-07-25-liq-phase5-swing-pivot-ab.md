# Phase 5 hard A/B — swing-pivot levels (2026-07-25)

**Hypothesis:** false_reclaim (Phase 4 top cause, 52% loss $) is driven by sweeping
insignificant daily/session pools. Fractal swing pivots (N L/R) raise level significance.

**Method:** isolated `intradayLiqLevels` change vs clean CORE. IS=first 70% Y1, OOS=last 30%, HOLD=prior year.

## Results

| Variant | IS ret/PF/tw | OOS ret/PF/tw | HOLD ret/PF/tw |
|---------|--------------|---------------|----------------|
| CORE_daily+sess | -70.45/0.678/6.74 | -15.3/0.504/5.31 | -83.22/0.673/6.83 |
| pivot_only_L3 | -79.73/0.386/4.79 | -7.47/0.318/3.13 | -88.8/0.4/3.85 |
| pivot_only_L5 | -88.35/0.406/6.58 | -4.02/0.498/4.67 | -91.25/0.6/5.96 |
| pivot_only_L7 | -82.87/0.447/6 | -3.55/0.69/4.22 | -91.14/0.568/5.64 |
| daily+pivot_L5 | -91.91/0.528/10 | -4.88/0.497/7.74 | -94.69/0.712/9.32 |
| daily+sess+pivot_L5 | -91.11/0.549/10.41 | -5.61/0.49/8.05 | -96.54/0.657/9.93 |

## Verdict: **IMPROVES_BUT_STILL_RED**

Best: `pivot_only_L7` OOS pf=0.69 ret=-3.55 tw=4.22

Do **not** promote. Documented so we do not re-test the same idea. Next: address false_reclaim via **entry timing** (wait for post-reclaim displacement bar) as a separate one-change hard A/B — only if candle-path evidence supports a new mechanism vs prior progress-confirm reject.

Artifact: `.liq-phase5-swing-pivot-ab.json`
