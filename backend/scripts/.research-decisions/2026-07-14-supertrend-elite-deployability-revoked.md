# Decision — SUPERTREND_ELITE deployability REVOKED

Date: 2026-07-14

## Finding

Prior claims that `SUPERTREND_ELITE` was the **only deployable / only OOS-validated**
stream (~10–21% CAGR) are **withdrawn**. Those headline results used **incorrect /
non-representative trailing** relative to the exit logic we would actually run.
Until the strategy is re-validated end-to-end with the **correct trailing model**
(same path as intended live/backtest exit) through the full WF + MC + 4-gate harness,
there is **insufficient evidence** to call it deployable.

## Policy (agents + docs)

- Do **not** present SUPERTREND_ELITE as the default solution, baseline-to-beat,
  or “only validated edge” in answers or research docs.
- Treat historical ~10–21% CAGR / portfolio tables as **stale research artifacts**
  under a known trailing bug — not production truth.
- Do **not** recommend live deployment of any strategy until it passes validation
  with correct exits.

## Restore criteria

Re-assert deployability only after:

1. Trailing / exit config matches intended live behavior (documented).
2. Full `runSimulation` with realistic costs.
3. Multi-coin holdout + walk-forward + Monte Carlo + acceptance gates pass.
4. Decision log entry with evidence (`PROMOTE` under correct trail).

Until then: **no strategy in this repo is certified deployable.**
