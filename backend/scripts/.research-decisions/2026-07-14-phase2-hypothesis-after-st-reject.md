# Phase 2 hypothesis — after ST Elite honesty REJECT

Date: 2026-07-14  
Parent: `2026-07-14-elite-st-honesty-reval-reject.md`

## Named failure mode (from BTC autopsy)

**Liquidation / unbounded adverse excursion under trail-only + high leverage**
wipes multi-month expectancy (one liq −$182 ≈ total winner PnL). Secondary:
losers that never develop MFE bleed via late trail exits.

This is **not** fixed by raising ADX/volume again first — entry already selective.
It is a **Layer 4 risk / exit** failure on failed trends.

## Chosen playbook (one stream)

**Low-frequency trend continuation with locked Supertrend trail + explicit
disaster stop** (hard max MAE / ATR disaster SL that prevents exchange liq,
without re-enabling 0.2%/1.5% profit caps).

Same entry family as Elite gates initially (hypothesis isolation): **one change
only** vs rejected baseline = add disaster SL (e.g. `eliteStAutoBracketMode=OFF`
with profile disaster, or explicit `backtest`/live disaster pct / ATR mult).

Alternate later (not this step): rewrite LIQ trend-day playbook — still frozen
until a dedicated restore plan.

## Experiment 1 (next concrete run)

| Field | Value |
|-------|-------|
| Baseline | Uniform Elite + `ELITE_ST_EXIT_CONTRACT` (trail-only, no disaster) |
| Single change | Disaster SL on (hard stop) while trail remains primary exit / TP still off |
| Window | 2025-01-01 → 2026-06-01, BTC+ETH+BNB at minimum; then 5-coin if BTC improves |
| Success | BTC full-window net&gt;0 **and** MC p5&gt;0; portfolio holdout ≥ prior; no new fee bleed |
| Fail | Net stays ≤0 or WF still collapses → archive disaster-SL variant; try different playbook |

Banned: funding threshold tweaks; LIQ entry-score churn; stacking filters;
promoting harvest-only metrics.

## Design principles for any successor stream

1. Live exit cfg ≡ backtest (`applyEliteStExitContract` + documented disaster if any)
2. Low frequency (fee survival)
3. Hypothesis → one change → full sim → holdout → WF+MC+gates
4. No deploy language until gates pass under that exit contract
