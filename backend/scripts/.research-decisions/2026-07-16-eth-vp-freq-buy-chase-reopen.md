# 2026-07-16 — ETH VP FREQ buy-chase filter reopened on adaptive stack

**Question:** After locking the regime-adaptive ABC stack, does the previously rejected
VAH buy-chase filter become valid if re-tested on top of the new baseline?

**Baseline tested:** current `VOLUME_PROFILE_FREQ_ETH_15M` adaptive lock  
**Script:** `backtest-vp-freq-eth-buy-chase.mjs`  
**Output:** `.vp-freq-eth-buy-chase.json`

## Result

The answer is **yes for the plain filter**, **no for the non-bull-only variant**.

| Variant | N | Full | 2022–23 | 2023–24 | 2024–25 | 2025–26 |
|--------|--:|-----:|--------:|--------:|--------:|--------:|
| Baseline adaptive lock | 204 | +250% | +8.5% | +5.3% | +36.7% | +124.0% |
| `prior5d>8%` chase ON | 186 | **+353%** | **+18.1%** | **+23.4%** | **+38.9%** | **+124.0%** |
| Chase ON, non-bull-only | 200 | +250% | +5.4% | +5.3% | +40.8% | +124.0% |

## Read

- The old rejection was correct **on the old baseline**, where chase-cut was just a trade-count
  reduction that failed the user mandate.
- After the adaptive stack removed the big non-chase failure modes, the remaining high-prior5d
  VAH buys are now mostly **bad continuation / relief-rally chases**, not needed edge.
- There was **no 2025–26 cost** because the current adaptive lock already leaves no relevant
  VAH buys above the `prior5d>8%` threshold in that year.
- The non-bull-only condition is too soft; it lets through the exact 2022 squeeze rallies we
  wanted to cut, so it gives back the improvement.

## Verdict

**PROMOTE plain `vpBuyChaseFilter` retest to next candidate lock.**

Candidate config:

```text
vpBuyChaseFilter: true
vpBuyChaseMaxPrior5dPct: 0.08
```

Do **not** prefer `vpBuyChaseNonBullOnly`; it failed the isolation test.

## Next

1. Full adaptive preset A/B with chase ON vs OFF as the new baseline.
2. Re-run deep bad-year autopsy after enabling chase.
3. Only then decide whether to lock it into `VOLUME_PROFILE_FREQ_ETH_15M`.
