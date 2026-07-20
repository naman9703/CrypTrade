# 2026-07-17 — BTC VP FREQ frequency restore reject

## Experiment

- **Baseline:** locked `VOLUME_PROFILE_FREQ_BTC_15M`
- **Windows:** `oos_2020-21`, `oos_2021-22`, `lock_2022-26`, `full_2020-26`
- **Script:** `backtest-vp-freq-btc-frequency-restore.mjs`
- **Rule:** one change at a time; never reopen vacuum bleed

## Variants tested

| Variant | Idea | Result |
|---|---|---|
| `buy_rej_score5` | lower score floor to admit more BUY rejection | **No change** vs baseline |
| `rej_wick_soft` | soften rejection wick/close-depth | Better 2020-21, but **damages 2021-22 and lock badly** |
| `add_poc_bounce` | add `poc_bounce` to allowed setups | Slight N gain, 2021-22 improves, but **lock return falls +115% → +101%** |
| `max3_gap0` | loosen ops caps only | **No change** vs baseline |

## Key numbers

- Baseline full: **75 trades / +145.4% / 0.22/wk**
- `add_poc_bounce` full: **80 trades / +135.0% / 0.24/wk**
  - extra POC trades were net-negative on lock
- `rej_wick_soft` full: **67 trades / +69.9%**

## Verdict

**REJECT all BTC-only frequency restore variants.**

Reasons:

1. Operational loosening was non-binding
2. Rejection softening hurts expectancy
3. `poc_bounce` adds some trades but fails the “N up without meaningful return damage” rule
4. BTC 15m positive cells remain structurally sparse

## Consequence

Do **not** weaken the 15m BTC lock to chase frequency. Next frequency path must be:

- a genuinely new BTC-native setup family / timeframe with its own prepared matrix, or
- portfolio breadth (ETH), with BTC retained as a sleeve
