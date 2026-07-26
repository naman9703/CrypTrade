# 2026-07-26 — DOGE VP FREQ: year-clean incomplete (NOT optimized)

## Verdict

**SUPERSEDED 2026-07-26** by `2026-07-26-doge-vp-freq-year-clean-minatr.md`
(`vpMinAtrPct: 0.008` ± `vpBuyRejectionMinBody: 0.25`). Keep this file as the
failure-mode autopsy of the pre-ATR stack.

**Historical (pre-ATR):** NOT OPTIMIZED. Do not promote.

User correctly rejected year-wise reds. After residual work (pre-ATR):

| Year | Best stack | Status |
|------|------------|--------|
| 2020–21 | **+5.4%** | fixed (BUY prior60≤100%) |
| 2021–22 | **+21.2%** | ok |
| 2022–23 | **+29.1%** | ok |
| 2023–24 | **+42.3%** | ok |
| **2024–25** | **−15.9%** | **UNSOLVED** |
| 2025–26 | **+16.0%** | ok |
| FULL | **+128.9%** / Calmar 0.75 / tw 0.27 | research only |

## What improved vs first “lock”

1. `vpRejectionSellBearMinHtfSepPct: 0.0035 → 0.005`
2. `vpBuyRejectionMaxPrior60dPct: 1.0` (blow-off BUY rej abstain)

2020–21 went from −8.6% → +5.4%. Full +63% → +129%.

## Why 2024–25 is not fixed

Under the stack, residual losers (n=9) are almost all **never-green / tiny-MFE full SL** — exit trails cannot save them.

Tried and **rejected** as year-clean solutions (break another year or leave 24–25 red):

- Global sell HTF 0.35%/0.50% (kills 2021–22 / 2025–26)
- Blanket BUY bull_trend / SELL-only (kills 2022–23)
- Cell deny packs of residual bleeds (kills 2021–22)
- Extended-down rej, wick floors, chop MFE trail (no help on never-green)
- Deny weak_bear SELL vac (destroys the only paying 24–25 cell + other years)

## Honest bar

Optimized means **no year left meaningfully red** (research bar used here: every year ≥0%, or a named measurable abstain that stands the sleeve down in that regime without calendar cuts).

Current state fails that bar on **2024–25**.

## Next (when Docker/disk allow)

1. Regime stand-down with a **new measurable feature** separating 2024–25 never-green entries from good-year same cells (not another cell deny already tested).
2. Or reopen funnel (add VAL / other setups) only with coin-native evidence that 2024–25 character pays elsewhere.
3. Parallel: NEAR F3 (stronger raw OOS in Phase 0 screen).

## Preset

`VOLUME_PROFILE_FREQ_DOGE_15M` updated to the improved stack — labeled research / incomplete.
