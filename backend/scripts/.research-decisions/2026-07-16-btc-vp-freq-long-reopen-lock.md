# 2026-07-16 — BTC VP FREQ: longs were setup mismatch, not “short-biased coin”

**Ask:** Why is BTC short-biased? Understand coin vs setup; don’t cut all longs —
adapt the setup so BTC can long profitably with higher results.

## Where “short-biased” came from (wrong endpoint)

Funnel 2026-07-15 on **one year** (2025-06→2026-05): `+vah / open ETH` → **−13…−33%**.
Preset dropped `vah_breakout`. That year is a **clean bear** — raw VAH longs fail there.

That is **not** “BTC cannot long.” It is “ungated VAH in a bear year loses.”

## What was actually true

| Fact | Evidence |
|------|----------|
| BUY `va_rejection` was **never banned** | Locked shorts stack: **5 BUY rej / +$48** — majority of short-stack PnL |
| Raw VAH multi-year | 37t / **−$1.7** (flat, not catastrophic) |
| VAH vacuum path≥2% | 23t / **−$7.5** |
| VAH structured 1–2% | 8t / **+$6.1** |
| VAH in macroBear | 6t / **−$8.6** |
| VAH in macroBull | 31t / **+$6.9** |
| 2022–23 open VAH | BUY **+$15** (helps) |
| 2025–26 open VAH | BUY **−$8** (hurts) — same pathology as the funnel year |

**Coin nature:** BTC still needs *stricter* long gates than ETH’s open funnel, and short
VAL needs deep-bear gating. It is **not** a one-way short market.

## Adaptive long fix (locked)

Re-enable `vah_breakout` with:

```text
vpBuyBreakoutMaxPathPct: 0.02
vpBuyBreakoutMaxPathNonBullOnly: true
vpBuyVacuumBullPriorPct: 0.05
vpBuyVacuumPriorLookback: 96*60
```

= block **vacuum** VAH outside bull macro (same family as ETH vacuum cap).

### Full-sim 2022-06→2026-05

| Variant | N | t/wk | Ret | Years≥0 | BUY VAH |
|---------|--:|-----:|----:|:-------:|--------:|
| Shorts locked | 34 | 0.16 | +62% | 4/4 | (rej only) |
| Open VAH raw | 71 | 0.34 | +61% | 4/4 | −$5.7 |
| **VAH + vacuum-cap non-bull** | **56** | **0.27** | **+90%** | **4/4** | **+$18.6** |
| Vacuum cap all regimes | 45 | 0.22 | +88% | 4/4 | +$18.3 |
| + chase 8% | 51–65 | — | ≤+78% | — | worse than vacuum-cap alone |

**Promote vacuum-cap non-bull** — best return **and** ~1.6× frequency vs shorts-only.
Chase / pullback extras REJECTED on top (don’t improve).

## Year table (locked long+short)

| Year | N | Ret | BUY | SELL |
|------|--:|----:|----:|-----:|
| 2022–23 | 13 | +15% | +$19 | −$4 |
| 2023–24 | 13 | +7% | +$2 | +$6 |
| 2024–25 | 16 | +22% | +$48 | −$22 |
| 2025–26 | 14 | +27% | +$4 | +$37 |

## ETH vs BTC (corrected)

| | ETH | BTC |
|--|-----|-----|
| Longs | Open VAH + many adaptive long gates | VAH OK **with** vacuum/bear gate |
| Shorts | VAL strong in clean bear | VAL only deep prior60d bear |
| Shared | Vacuum VAH bleeds outside bull | Same failure mode |
| Difference | More two-sided density | Fewer auctions; needs tighter VAL + gated VAH |

Cutting all longs was the wrong fix. **Gating the long failure mode** was the right one.

## Status

Preset + frontend updated. Research lock — not WF+MC certified.
Artifacts: `research-vp-freq-btc-long-autopsy.mjs`, `backtest-vp-freq-btc-long-adaptive.mjs`.
