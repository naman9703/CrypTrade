# Experiment: SR_INTRADAY LIQ + informational context filter (edge_v1)

- **Baseline:** `INTRADAY_PRO_LIQ_15M`, BTC/ETH/BNB, 2025-01-01→2026-01-01, 2% risk
- **Hypothesis:** OI cascade + short-liq-day + negative funding abstain bad long sweeps (from harvest research)
- **Single change:** `edge_v1` context filter at entry via `liqContextFilter.js`
- **IS (train 75%):** baseline −24.3% portfolio / filtered −13.3% — still negative
- **OOS (holdout 25%):** baseline −9.8% / filtered −0.9% — improved but not positive
- **Per-coin OOS:** BTC filtered +5.1% full year; BNB still drag; portfolio gates not run
- **Gates:** NOT RUN — insufficient evidence for promotion
- **Verdict:** **REJECT** for deployment; archive as damage-control research only
- **Reason:** Full sim never achieves positive OOS portfolio return. Harvest meanR did not transfer. Does not beat SUPERTREND_ELITE validated baseline. Next step if continuing LIQ: autopsy BNB losers → coin-specific gate or drop ETH/BNB from LIQ portfolio before any new filter.
