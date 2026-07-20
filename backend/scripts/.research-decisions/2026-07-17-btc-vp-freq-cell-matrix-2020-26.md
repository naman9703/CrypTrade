# 2026-07-17 — BTC VP FREQ cell matrix 2020-26

## Experiment

- **Baseline:** locked `VOLUME_PROFILE_FREQ_BTC_15M`
- **Window:** `2020-01-01 → 2026-05-31`
- **Script:** `research-vp-freq-btc-prepared-regime-matrix.mjs`
- **Change:** extend the matrix to 2020 and add fold-wise chronological status attribution

## Main findings

Durable bleed:

- `SELL|val_breakdown|bear_trend|vacuum` → still a reliable negative cell
- `SELL|val_breakdown|bear_trend|structured` also comes out negative on the broader 2020–26 sample

Prepared-positive with enough N:

- `BUY|vah_breakout|bull_trend|structured`
- `BUY|vah_breakout|bull_chop|structured`

Thin / unresolved:

- many BUY/SELL rejection and tight-path cells remain **unknown_thin**
- early folds still contain substantial **unseen** and **unknown** traffic

## Fold insight

The chronological fold breakdown shows:

1. Prepared cells help, but
2. unknown / unseen cells still contribute a large part of realized OOS

So a strict `vpPreparedAllowlistOnly` live lock would be **too sparse** and would
discard too much unresolved but not-yet-proven-negative activity.

## Verdict

**Keep the current doctrine:**

- deny known bleed cells
- keep unknown cells tradeable for now
- add live novelty monitoring / optional size-down
- revisit allowlist-only only after more cell N or after ETH/portfolio breadth exists

## Implementation consequence

Shared condition-cell taxonomy + novelty monitor plumbing were added so live/paper
can now:

- tag each VP trade with a cell key
- optionally abstain unknown cells
- disable prepared cells if rolling live expectancy turns negative
