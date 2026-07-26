# 2026-07-26 — DOGE VP FREQ: POC-cell cleanup (not open VAL)

## Verdict

**POC expansion was net-negative.** Deeper cell work = **deny bleed POC cells**,
not add VAL. Quality up for certification; frequency still low.

| Stack | n | tw | FULL | Calmar | year-clean |
|-------|---|----|------|--------|------------|
| rej+poc open (prior lock) | 67 | 0.24 | +230% | 1.00 | yes |
| **block bleed POC + gap1** | **58** | **0.21** | **+329%** | **1.61** | **yes** |

## Autopsy

POC book under lock: **n=12 net −31.5** (WR 33%). Rejection book carried the edge
(n=55 net +261).

| POC cell | n | net |
|----------|---|-----|
| SELL\|poc\|weak_bear\|structured | 2 | −22 |
| SELL\|poc\|bear_trend\|tight | 2 | −20 |
| SELL\|poc\|bull_trend\|vacuum | 1 | −17 |
| SELL\|poc\|bear_trend\|structured | 1 | −15 |
| BUY\|poc\|bull_trend\|vacuum | 1 | −8 |
| SELL\|poc\|bear_trend\|vacuum | 1 | −6 |
| BUY\|poc\|bull_trend\|tight | 1 | +6 |
| BUY\|poc\|bull_chop\|tight | 1 | +9 |
| SELL\|poc\|weak_bear\|tight | 2 | +41 |

## Locked change (one family)

`vpPreparedRegimeOnly` + deny list of the 6 bleed POC cells + `vpMinBarGap: 1`.

## Rejected

| Probe | Why |
|-------|-----|
| Open VAL / VAH | Prior restore: multi-year red |
| Soften ATR to 0.007 (alone or +POC block) | Re-reds 2024–25 |
| Keep open bleed POC for frequency | Net drag; Calmar stuck at ~1.0 (cert risk) |

## Next

Run `backtest-validate-vp-freq-doge.mjs` — expect low-freq sleeve or reject on
freq/Calmar/WF; do not claim deployable.

## Artifacts

- `research-vp-freq-doge-poc-cell-restore.mjs`
- `.vp-freq-doge-poc-cell-restore.json`
