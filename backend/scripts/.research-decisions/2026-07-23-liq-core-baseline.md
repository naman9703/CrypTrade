# Decision — LIQ_CORE baseline (rebuild infra + ablation)

Date: 2026-07-23  
Window: **2025-01-01 → 2026-06-01** (~17 months)  
Script: `backtest-liq-core-baseline.mjs`  
Artifact: `backend/scripts/.liq-core-baseline.json`  
Doctrine: `docs/LIQ_CORE_PLAYBOOK.md`

## What shipped

- Parallel playbook `LIQ_CORE` (`INTRADAY_PRO_LIQ_CORE_15M`)
- Chronological picks (`intradayLiqPickMode: chronological`) — no EOD quality look-ahead
- Concept-only defaults (session extremes on; body/score/CHoCH/V2 off)
- UI: ★ LIQ_CORE (rebuild)

## Results (honest)

| Path | BNB n | tw | Ret% | PF |
|------|------:|---:|-----:|---:|
| CORE | 539 | **7.31** | −145.5 | 0.31 |
| Legacy LIQ_15M | 75 | 1.02 | −29.1 | 0.55 |

CORE hits the **frequency** bar (≥2/wk) on BNB/ETH/BTC but **destroys expectancy** (PF ~0.3, DD ~account). Ablations (body, same-bar, minRr, score, hold) do not restore PF.

## Verdict

**INFRA + FREQ checkpoint — EDGE FAIL.** Do not promote. Do not “fix” by re-stacking binary entry gates without autopsy.

## Next (one change)

1. Autopsy CORE SL-heavy losers (named failure mode).
2. Exit-only experiment on CORE entries.
