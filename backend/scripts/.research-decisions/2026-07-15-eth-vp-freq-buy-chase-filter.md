# 2026-07-15 — ETH VP FREQ buy-chase filter (2022–23 relief rallies)

**Hypothesis (one change):** 2022–23 VAH BUY losers chased **relief / short-covering rallies** after sharp ~5d bounces (avg prior5d +8.5%, prior60d +10.8%, MFE 0.62% then SL). Washout VAH winners had prior60d **−21%**. Block `BUY vah_breakout` when `prior5d > 8%` — do not delete VAH or crush maxTrades.

**Autopsy:** `2026-07-15-eth-vp-freq-2022-23-autopsy.md` · canvas `eth-vp-freq-2022-23-autopsy.canvas.tsx`  
**Run (UI):** `0e26b212` 2022-06→2023-05 −9.3% / DD 47.6% (opposite failure vs 2023–24 shorts).

## Implementation

- `vpBuyChaseFilter` + `vpBuyChaseMaxPrior5dPct` (default 0.08)
- `macroPrior5d` in VP precompute; `passesVpBuyChaseFilter` (independent of `vpRegimeImmunity`)
- Locked on `VOLUME_PROFILE_FREQ_ETH_15M` (+ frontend preset)

## Full sim (ETH FREQ + macro-adapt SELL; A/B chase only)

Window 2022-06-01 → 2026-05-31 · RISK_AT_SL · $100 · realistic costs  
Script: `backtest-vp-freq-eth-buy-chase.mjs` → `.vp-freq-eth-buy-chase.json`

| | N | Ret | DD | 22–23 | 23–24 | 24–25 | 25–26 |
|--|--:|--:|--:|--:|--:|--:|--:|
| Chase OFF | 263 | +135% | 52.4% | −5.4% | +0.0% | +13% | +119% |
| Chase ON (8%) | **239** | **+207%** | **43.9%** | **+0.8%** | **+17%** | **+15%** | **+126%** |

−24 trades / 4y (~6/y) — restores path without ultra-low-N. Good year not hurt.

## Still open (separate experiment)

**H2:** SELL `va_rejection` 0/5 · −$25 in 2022–23 (short into bounce). Do **not** stack with H1 in one change.

## Status

Research lock on ETH FREQ preset. **Not** WF+MC certified / not promote.
