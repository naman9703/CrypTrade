# REJECT — ETH VP FREQ closeStrength@entry quality filter (2026-07-19)

## Mistake

Harvest on **entry bar** closeStrength looked PROMISING (`buy_rej_weak_close`
Δ21 +$10 / lockCost ~$10). Full-sim with `vpBuyRejectionMinCloseStrength: 0.55`:

| Window | Baseline | +closeStr 0.55 |
|--------|----------|----------------|
| lock 22–26 | 149t / **+690%** | 143t / **+533%** |
| oos 21–22 | 46t / −13.4% | 46t / −13.4% (**unchanged**) |

## Root cause

Backtest fills **next bar** after signal (`entryIdx = signalIdx + 1`). Autopsy
features at `entryTs` are **not** the bar the detector saw. On the **signal bar**,
BUY-rej losers actually have *higher* closeStrength than winners — the filter
removed lock winners and missed the 21–22 bleed.

## Doctrine

Always feature-autopsy on the **signal bar**. Do not lock closeStrength-at-entry
rules. Prefer signal-bar body / cycle (prior120) quality.

## Next

`vpBuyRejectionMinBody` (directional body ≥ 0.20) — signal-bar harvest: Δ21 +$13.3
and lock drops are net-negative (helps lock).
