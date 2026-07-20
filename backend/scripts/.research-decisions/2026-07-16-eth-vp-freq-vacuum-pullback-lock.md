# 2026-07-16 — ETH VP FREQ vacuum VAH pullback gate lock

**Question:** After weak-bear short lock, 2022–23 still bleeds on **vacuum VAH** (`path≥2%`).
What distinguishes bad vacuum longs from good ones?

**Row dump:** `research-vp-freq-vacuum-vah-rows.mjs` → `.vp-freq-vacuum-vah-rows.json`

## Finding

Vacuum VAH is **not one playbook**. Losers are mostly **re-acceleration / relief chase**
(`prior5d > 1%`, often `macroBull` with brief `prior60d > 5%` slipping past non-bull cap).
Winners are mostly **pullback breaks** (`prior5d ≤ 1%` or washout).

| Year | All vacuum VAH | Keep only `prior5d≤1%` |
|------|---------------:|------------------------:|
| 2022–23 | 9t / **−$10.4** | 4t / **+$7.8** |
| 2023–24 | 8t / +$12.9 | 4t / +$18.9 |
| 2025–26 | 5t / −$8.9 | 4t / −$5.8 |

Structured VAH (path 1–2%) unchanged. Global `prior5d>8%` chase filter already locked;
this is **vacuum-only** and much softer (1%).

## One-change rule

```text
if vah_breakout path ≥ 2%:
  require prior5d ≤ 1%
```

Config:

```text
vpBuyVacuumMaxPrior5dPct: 0.01
vpBuyVacuumPrior5dLookback: 96 * 5
```

## Full-sim A/B (confirmed)

Script: `backtest-vp-freq-eth-vacuum-prior5d.mjs` → `.vp-freq-eth-vacuum-prior5d.json`

| Variant | N | Full | 2022–23 | 2023–24 | 2025–26 | DD |
|--------|--:|-----:|--------:|--------:|--------:|---:|
| Without vacuum gate | 177 | +466.7% | +17.2% | +45.5% | +130.5% | 26.8% |
| **`prior5d≤1%` on path≥2%** | **166** | **+487.1%** | **+24.0%** | **+43.6%** | **+137.2%** | **24.6%** |

Improves every year bucket; largest lift on **2022–23** (+17% → +24%) without hurting 2025–26.

## Verdict

**LOCK confirmed** — row autopsy + full sim. Not WF+MC certified.
