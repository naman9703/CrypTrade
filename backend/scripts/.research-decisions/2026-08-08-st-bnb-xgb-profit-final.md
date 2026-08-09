# ST BNB — XGB profitability push (honest close-out)

**Date:** 2026-08-08  
**Mandate:** Make HTF+ATR×3+trail+noTP stack profitable via XGB (freq viable, OOS-honest).

## Base

| | HTF stack (no XGB) |
|--|--|
| Trades | 382 |
| /day | 0.66 |
| PF | 0.695 |
| Return | −40.8% |

## Full-window XGB (optimistic — includes train period)

| thr | n | /day | PF | ret% | Notes |
|--|--|--|--|--|--|
| 0.32 | 285 | 0.49 | **0.989** | −0.9 | Near breakeven; **OOS half PF 0.73** |
| 0.75 | 89 | 0.15 | **1.13** | **+2.3** | Green full-window; **freq &lt; 2/wk**; OOS n=29 PF~0.98 |

## Honest OOS (sim only after train_end ≈ 2026-04-05)

| thr | n | /day | PF | ret% |
|--|--|--|--|--|
| 0.32 | 57 | 0.48 | 0.41 | −14 |
| 0.75 | 13 | 0.11 | 1.15 | +0.5 |
| 0.82 | 10 | 0.08 | 1.61 | +1.4 |

OOS “green” only at thr≥0.75 with **n≪30** — fails promote bar. Portfolio BTC+ETH+BNB @0.75 OOS: **portRet −0.06%**, ETH still red.

## Rejected along the way

- Flip exit, FEE_LADDER, buffer cuts, MQ defaults, hour filters (cherry-pick), Asia-only harvest without OOS proof
- R-regression gate → N-starve when PF&gt;1

## Verdict

**Cannot certify profitable.** XGB improves the HTF stack (full-window toward breakeven / small green at high thr) but:

1. Near-breakeven thresholds **fail OOS**
2. OOS-green thresholds **starve N** (&lt;30 trades, &lt;2/wk)
3. Multi-coin does not rescue OOS

**Best research checkpoint (not deployable):**  
`ATR×3 + trail(buf 1.5%) + no fixed TP + HTF4H + XGB@0.32` → ~PF 0.99 / −1% full-window, **0.49/day** — still red OOS.

## Next (if continuing ST)

Do **not** threshold-hunt further on this coin/TF. Next named premises: different entry family, different TF (e.g. 1H), or archive BNB 15m ST as expectancy-negative after honest iteration.
