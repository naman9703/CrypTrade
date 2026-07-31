# LIQ_CASCADE — Phase 0 + validation (2026-07-30)

**Status:** `REJECT`
**Symbol:** ETHUSDT 1m @ 1% risk
**Script:** `backtest-validate-liq-cascade.mjs`, `research-liq-cascade-phase0.mjs`

## Results (FULL / OOS)

| Window | n | tw/wk | ret | Calmar | PF(R) |
|--------|---|-------|-----|--------|-------|
| FULL | 1 | 3.5 | -1.87% | -51.83 | 0 |
| OOS | 1 | 8.75 | -1.87% | — | 0 |

## Gates

- oosPositive: FAIL (-1.87%)
- mcP5Positive: FAIL (0%)
- calmarOver1: FAIL (-51.83)
- wfDegradationOk: FAIL (999.0%)
- Frequency ≥2/wk: PASS

## Notes

- Bar-close backtest uses Coinalyze 5min aggregated liquidations + OI (not tick-level forceOrder history).
- Live tick executor (`liqCascadeLiveEngine.js`) is paper-gated; requires `liqCascadeLiveTickEnabled` and blocks LIVE unless `LIQ_CASCADE_LIVE_ALLOW=1`.
- Do not deploy until OOS n≥30 and all gates pass.
