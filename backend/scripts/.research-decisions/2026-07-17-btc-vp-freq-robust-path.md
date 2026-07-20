# 2026-07-17 — BTC robust path (not N-crush): diagnosis + what works

## Your critique (accepted)

Cutting trades to “fix” a bad OOS year is not robustness. Live needs:

1. Understand **why** the setup fails (market physics)
2. Change **behavior** or refuse only **negative-EV condition cells**
3. Restore frequency from **positive** cells — never by reopening bleed cells
4. Unrecognized conditions → abstain (capital protection)

## What actually went wrong (2021–22)

Not “the year.” Three measurable failure modes:

| Failure physics | Cell | Multi-year EV |
|-----------------|------|---------------|
| Vacuum expansion chase | vacuum VAH / vacuum VAL bear | strongly negative every year |
| Bounce-short into squeeze | SELL `va_rejection` after prior20d ≤ 0 | OOS −$10 / 3t |
| Structured auction | structured VAH/VAL, BUY rej | positive |

Removing vacuum trades is **not** a fake N-crush: those trades lose money in 2022–26 too. Blocking them raised lock return +90%→+116%.

## Practical approaches tested

| Approach | Idea | OOS 21–22 | Lock 22–26 | Verdict |
|----------|------|----------:|-----------:|---------|
| Vacuum **retest** (behavior fix) | Keep vacuum, change entry | −24% | +32% (neg year) | **REJECT** |
| Prep block + poc/score expand | Restore N from extra setups | +1.7% | +101% | Fragile (poc nets − on lock) |
| Prep block only | Refuse vacuum bleed | −3.9% | **+116%** | Incomplete (SELL rej residual) |
| Prep + SELL rej only if prior20d>0 | Adaptive rejection | **+7.4%** | **+116%** | **LOCK** |

## Locked (non-year) rules

```text
vpPreparedRegimeOnly: true
  → block vacuum VAH
  → block vacuum VAL in bear_trend
vpRejectionSellBlockExtendedDown: true
vpRejectionExtendedPriorPct: 0
  → SELL va_rejection only when prior20d > 0 (exhaustion after strength)
  → BUY va_rejection kept (major BTC edge)
```

## Frequency honesty

BTC 15m positive cells are sparse. Restoring N by reopening vacuum **fails**. Next frequency paths that respect this doctrine:

- Expand **BUY va_rejection** / structured-only quality (not vacuum)
- Multi-coin portfolio (ETH FREQ carries activity)
- New playbook/TF with its own prepared matrix — not looser 15m vacuum gates

## Live novelty doctrine (unchanged)

Unrecognized cell → abstain or classify after autopsy. Do not optimize one OOS window and hope.

## Status

Research lock on BTC FREQ preset + frontend. Not WF+MC certified / not deploy claim.
Artifacts: `.vp-freq-btc-robust-path.json`, prepared-regime matrix + A/B.
