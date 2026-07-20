# 2026-07-17 — ETH prepared-regime Layer-1 lock (BTC doctrine, ETH-native cells)

## Mandate

Make ETH adaptive/relative for OOS the same way BTC was: **measurable condition
cells**, not year patches. When the market is in a known-unprepared cell → abstain.
Do not crush frequency unless the cut clearly improves OOS. Do not rush certification.
Do not add random knobs (session filters rejected).

## Why certain durations bled (root cause — optimize later)

ETH ABC lock was validated mainly on **2022–2026**. On full history the bad legs are:

| Duration | What failed | Why (cell language) |
|----------|-------------|---------------------|
| **2020–21** | Violent bull + squeeze | `SELL\|val_breakdown\|weak_bear\|vacuum` shorts got run over; thin/unknown cells added noise |
| **2021–22** | Top → crash | Same weak_bear VAL bleed + `BUY\|vah_breakout\|bull_trend\|vacuum` relief-rally chases |
| **2022–26** | Worked | Bear continuation + structured/bull-trend vacuum VAL follow-through (ETH's real edge) |

**ETH ≠ BTC cells.** Copying BTC's `vacuum VAL in bear` block would destroy ETH's
largest edge (`SELL|val_breakdown|bear_trend|vacuum` ≈ +$46). ETH's #1 bleeder is
**weak_bear** vacuum VAL (−$23.5 / 30t), not bear vacuum VAL.

Fold-wise matrix: the `prepared` bucket is positive every WF fold; OOS bleed is
concentrated in `unprepared_bleed` + `unknown_thin` / `unseen`.

## Doctrine applied (same architecture as BTC)

```
Layer 1 — Known unprepared cells → ABSTAIN   ← LOCKED NOW (ETH cell keys)
Layer 2 — Known prepared cells → TRADE
Layer 3 — Unknown / thin → still tradeable for now (BTC default)
           allowlist-only tested as v2: more N cut, worse full return than Layer-1 alone
Layer 4 — Live novelty kill-switch (already wired) when a cell's rolling EV goes negative
```

## Locked change (`VOLUME_PROFILE_FREQ_ETH_15M`)

```text
vpPreparedBlockCellKeys:
  - SELL|val_breakdown|weak_bear|vacuum
  - BUY|vah_breakout|bull_trend|vacuum
  - SELL|val_breakdown|bull_trend|structured
  - SELL|val_breakdown|weak_bear|structured
  - SELL|val_breakdown|bull_chop|structured
vpPreparedBlockVacuumVah: false      # do NOT copy BTC all-vacuum-VAH
vpPreparedBlockVacuumValBear: false  # do NOT copy BTC — bear vacuum VAL is ETH edge
```

## OOS A/B (`backtest-vp-freq-eth-prepared-oos-ab.mjs`)

| Variant | Full N | Full ret | DD | Cat years | 2020-21 | 2021-22 | 2025-26 |
|---------|-------:|---------:|---:|----------:|--------:|--------:|--------:|
| v0 ABC only | 318 | +178% | 59% | 2 | −24% | −32% | +151% |
| **v1 deny unprepared** | **234** | **+401%** | **35%** | **0** | **+16%** | −18% | +123% |
| v2 deny + allowlist | 194 | +307% | 34% | 0 | +7% | −14% | +143% |

**LOCK v1.** Frequency cut is moderate (−26% trades) with a large OOS/robustness gain.
v2 (unknown→abstain) does not beat v1 enough to justify the extra N cut — keep as
optional stricter Layer 3 for later.

## Residual (understand, do not year-patch)

After Layer 1:

- **2021–22 still ~−14…−18%** — mild, not catastrophic. Bleed is inside remaining
  tradeable cells (prepared + unknown), not the denied list. Next autopsy target when
  continuing: within-cell features on those remaining 2021–22 losers (not session filters).
- **2019–20** partial window still negative on thin N — low priority.
- Later years stay strongly positive.

## What NOT to do next

- Do not copy BTC vacuum-VAL-bear / all-vacuum-VAH onto ETH
- Do not session-filter to "fix" 2021–22 (already shown to hurt other years)
- Do not rush WF+MC certification until residual 2021–22 is understood or accepted
- Do not reopen denied cells to chase frequency

## Status

Research lock — prepared-regime Layer 1 for ETH. **Not certified.** Frequency still
below ≥2/wk target; next frequency work must come from new positive cells / portfolio,
not from reopening weak_bear VAL or bull vacuum VAH.
