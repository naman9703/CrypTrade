# 2026-07-16 — ETH VP FREQ weak-bear short floor lock

**Question:** After locking chase + adaptive filters, what remains in the 2023–24 short bleed?

**Observation from row dump:** the residual losers are mostly `SELL val_breakdown` trades with:

- `macroBull = false` (so they bypass the bull-macro hardening),
- `prior20d` only **mildly negative** (roughly `>-10%`),
- shallow HTF separation.

These are not clean bear continuation shorts; they are weak-bear / transition pullbacks.

## One-change test

Demand stronger HTF confirmation for this subset only:

```text
if !macroBull and prior20d > -0.10:
  require htfSep >= 0.005
```

Also tested a tighter `0.8%` version to avoid overfitting by assumption.

**Script:** `backtest-vp-freq-eth-weak-bear-short.mjs`  
**Output:** `.vp-freq-eth-weak-bear-short.json`

## Results

| Variant | N | Full | 2022–23 | 2023–24 | 2024–25 | 2025–26 |
|--------|--:|-----:|--------:|--------:|--------:|--------:|
| Baseline current lock | 186 | +353.3% | +18.1% | +23.4% | +38.9% | +124.0% |
| **Weak-bear HTF >= 0.5%** | **177** | **+466.7%** | **+17.2%** | **+45.5%** | **+44.2%** | **+130.5%** |
| Weak-bear HTF >= 0.8% | 168 | +257.3% | +17.2% | +26.9% | +45.1% | +65.7% |

## Read

- The `0.5%` floor removes the bad transition shorts without damaging the real bear edge.
- The tighter `0.8%` version is **too aggressive** and crushes 2025–26 continuation profits.
- Cost to 2022–23 is small (`+18.1%` → `+17.2%`) while 2023–24 and 2025–26 both improve.

## Verdict

**LOCK** the weak-bear short floor:

```text
vpSellWeakBearMinHtfSepPct: 0.005
vpSellWeakBearPrior20dFloorPct: -0.1
```

This is now part of the ETH FREQ preset baseline. Re-run deep autopsy after lock.
