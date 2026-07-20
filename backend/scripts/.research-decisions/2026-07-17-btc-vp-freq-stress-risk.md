# 2026-07-17 — BTC VP FREQ stress and risk overlay verdict

## Experiment

- **Baseline:** locked `VOLUME_PROFILE_FREQ_BTC_15M`
- **Window:** `2022-06-01 → 2026-05-31`
- **Script:** `backtest-vp-freq-btc-stress-risk.mjs`

## Baseline

- **32 trades / +115.3% / DD 8.9% / Calmar 2.34**

## Risk-overlay ablation

| Overlay | Return | DD | Verdict |
|---|---:|---:|---|
| `riskKillSwitchDdPct=15` | +115.3% | 8.9% | non-binding |
| `riskWeeklyMaxLossPct=8` | +115.3% | 8.9% | non-binding |
| `riskConsecutiveLossLimit=3` | +115.3% | 8.9% | non-binding |
| stacked safe overlay | +80.4% | 11.4% | **worse** |

## Stress result

| Stress | Return | DD | Read |
|---|---:|---:|---|
| Flash crash −15% | +151.1% | 8.9% | tolerant |
| Flash crash −30% | +109.3% | 8.9% | tolerant |
| Sustained bear −30% | +102.4% | 13.3% | still positive, more stress |
| Exchange gap | +115.3% | 8.9% | little effect |
| Slip×2 | +102.4% | 9.5% | acceptable |
| Slip×4 | +77.9% | 10.9% | acceptable but weaker |
| Liquidity crunch / slip×8 | **−28.0%** | 28.0% | dangerous |

Real crash windows:

- COVID 2020: **1 trade / −2.8%**
- May 2021 deleveraging: **2 trades / −5.5%**
- FTX 2022: **0 trades**

## Verdict

**Keep research risk overlays OFF (`0`) on the locked BTC stream.**

The overlays do not improve the validated path; the stacked variant reduces return
and increases DD. Use the new live-plumbing hooks as protection infrastructure, but
do not claim they improve the edge today.

Main operational warning: **liquidity-crunch conditions remain a real tail risk**.
