# REJECT — ETH VP FREQ S1/S4 cell blankets (2026-07-18)

## Hypothesis (rejected)

Residual 2021–22 under H1+H2+H3 (~46t / −13%):
- **S1:** abstain `SELL|val_breakdown|weak_bear|vacuum`
- **S4:** abstain `BUY|va_rejection|bull_trend`

Harvest CF looked PROMISING. Full-sim gate failed.

## Full-sim (`backtest-vp-freq-eth-2122-residual-fix-ab.mjs`)

| Variant | lock 22–26 | oos 21–22 | y 25–26 |
|---------|------------|-----------|---------|
| v0 H123 | 149t / **+690%** | 46t / −13.4% | 48t / +155% |
| v1 S1 only | 141t / **+557%** | 41t / −7.5% | 44t / +107% |
| v2 S4 only | 145t / **+587%** | 44t / −6.5% | 47t / +139% |
| v3 S1+S4 | 137t / **+471%** | 39t / −0.2% | 43t / **+94%** |

## Why reject

- Those cells are **net profitable on the lock window** (S1 7t/+$47, S4 5t/+$60). Blanketing greeds one bad year by cutting live edge.
- Lock leaves ~600% class (S1/S3 fail hard; S4 borderline but 21–22 still red).
- 2025–26 vacuum/bull path damaged — classic OOS fragility.

## Doctrine

Do **not** blank a condition cell that pays in trained years. Prefer **within-cell quality** (e.g. BUY rejection close strength; VAH bull+tight path) that separates 21–22 losers from lock winners.

## Next

Quality A/B: `vpBuyRejectionMinCloseStrength` + `vpBuyBreakoutBlockBullTight`.
