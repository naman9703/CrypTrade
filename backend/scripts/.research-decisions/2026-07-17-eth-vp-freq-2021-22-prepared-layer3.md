# 2026-07-17 — ETH 2021–22: same fix as BTC (refuse unprepared physics)

## Question

Why is ETH 2021–22 still bad after Layer-1, and how do we make the setup
survive OOS / live novelty the way BTC did — without year-patching?

## What was wrong (not “the year”)

After Layer-1 deny, 2021–22 was still ~−14…−18%. Autopsy under the lock:

| Source | 2021–22 impact | Multi-year read |
|--------|---------------:|-----------------|
| **Thin / unknown cells** (full n&lt;4) | **−$11.7 / 8t** | net ≤ 0 across years — untrained noise |
| Prepared SELL bull_trend vacuum VAL | −$3.7 | **+$77 full** — keep |
| Prepared BUY va_rejection tight | −$3.1 | **+$53 full** — keep |
| Other prepared cells | small ± | mostly positive full |

So OOS looked worse because ETH was still trading **negative-EV untrained cells**,
plus normal variance inside prepared edge — same frame as BTC, not “fix the year.”

**Rejected year-patches (would destroy edge elsewhere):**

- Block `SELL VAL` when `prior20d > 0`: helps 2021–22 (−$8.7) but slice is
  **+$92 full-history** (huge 2025–26). Classic OOS-only cut → reject.
- Session filters: help 2021–22, crush 2025–26 → reject.
- Copy BTC `vacuum VAL bear` block: destroys ETH’s largest edge → reject.

## How we solved it (BTC doctrine, ETH cells)

```
Layer 1 — Known unprepared cells → ABSTAIN   (already locked)
Layer 2 — Known prepared cells → TRADE
Layer 3 — Unknown / thin / untrained → ABSTAIN  ← LOCKED NOW (allowlist)
Layer 4 — Live novelty kill-switch when a prepared cell’s rolling EV goes negative
```

Locked into `VOLUME_PROFILE_FREQ_ETH_15M`:

1. **Deny list** — Layer-1 unprepared + thin multi-year bleed keys
2. **Allowlist** — only trained-positive cells (`vpPreparedAllowlistOnly`)
3. **Off** — BTC vacuum-VAH(all) / vacuum-VAL(bear) flags (wrong for ETH)

Novel live regimes that do not match a prepared cell key are refused automatically.

## Result (full sim, research costs)

| Window | Layer-1 only | Layer-1 + Layer-3 allowlist |
|--------|-------------:|----------------------------:|
| Full | 234t / +401% / DD35% | **194t / ~+313% / DD34%** |
| OOS 2020–21 | +16% | +7% |
| OOS 2021–22 | −18% | **~−11%** (improved; residual = prepared variance) |
| OOS 2025–26 | +123% | **+142%** (edge preserved) |
| Catastrophic years (≤−25%) | 0 | 0 |

Frequency cut is real (−17% vs Layer-1) but buys **unknown→abstain**, which is the
live reliability requirement. Deny-only alone left untrained cells tradeable.

## Still not “solved”

- **2021–22 can still be mildly negative** inside prepared cells (multi-year winners
  having a bad year). That is not fixed by year-patches without killing edge.
- Next autopsy (one change): within-prepared sub-conditions that bleed **multi-year**,
  not “make 2021–22 match 2025–26.”
- Frequency still below ≥2/wk; do not reopen denied/unknown cells to chase N.
- Not WF+MC certified / not deployable.
- `vpConditionCellKey` now persisted on backtest trades for monitoring.

## Status

Research lock — ETH prepared-regime **Layer 1 + Layer 3**. Same architecture as BTC:
**refuse unprepared / untrained physics, keep prepared edge.**
