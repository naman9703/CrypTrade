# LOCK — ETH VP FREQ H4 BUY rejection min body (2026-07-19)

## Hypothesis

2021–22 residual BUY `va_rejection` losers are **wick-only fake reclaims**
(signal-bar `|close−open|/range` ≪ 0.20). Require a real reclaim body.

Not a macro/cell blanket (S1/S4 REJECTED). Not closeStrength@entry (wrong bar).

## Evidence

Signal-bar autopsy: `buy_rej_body_lt_20` Δ21 +$13.3; lock drops net-negative.

Full-sim (`vpBuyRejectionMinBody: 0.2`):

| Window | H123 | +H4 body 0.20 |
|--------|------|---------------|
| lock 22–26 | 149t / +690% | 147t / **+669%** |
| oos 21–22 | 46t / −13.4% | 43t / **−2.9%** |
| y 22–23 | +45.4% | +45.4% |
| y 23–24 | +56.4% | +56.4% |
| y 24–25 | +43.1% | +33.7% (mild) |
| y 25–26 | +155% | **+166%** |

N drop: −2 lock / −3 oos — frequency intact.

## Config

`VOLUME_PROFILE_FREQ_ETH_15M.vpBuyRejectionMinBody = 0.2`

## Rejected along the way

- S1/S4 cell blankets — lock crush (`2026-07-18-eth-vp-freq-s1-s4-cell-blanket-reject.md`)
- closeStrength@entry — 21–22 unchanged, lock −690→−533 (`2026-07-19-eth-vp-freq-closestrength-entry-bar-reject.md`)
- Signed/directional body — over-cut vs harvest abs body

## Doctrine note

Autopsy features must use the **signal bar** (fill is next bar).

## Residual / next

21–22 still ~−3% (mostly VAL). Continue signal-bar relative VAL subtypes without
blanketing lock-positive cells. Then WF+MC+gates — not certified deployable yet.
