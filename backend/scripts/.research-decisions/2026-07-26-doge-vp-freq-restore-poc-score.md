# 2026-07-26 — DOGE VP FREQ: frequency restore (poc + score6)

## Verdict

**Partial freq restore accepted** under year-clean bar. Still **far below ≥2/wk**.

| Stack | n | tw | FULL | year-clean |
|-------|---|----|------|------------|
| year-clean lock (rej only, score7, atr0.8%) | 46 | 0.16 | +232% | yes |
| **+ `poc_bounce` + `vpMinScore: 6`** | **67** | **0.24** | **+230%** | **yes** |

## Hypothesis

Throttle loosens alone barely move N. Meaningful restore needs **setup expansion**
with coin-native evidence. `poc_bounce` added trades that stayed year-green;
open VAL / VAH destroyed years.

## Accepted (sequential)

1. `vpAllowedSetups: ["va_rejection", "poc_bounce"]` — tw 0.16→0.21, years green
2. `vpMinScore: 7 → 6` on that stack — tw →0.24, years green, FULL holds

## Rejected (do not retest without new evidence)

| Probe | Why |
|-------|-----|
| Open `val_breakdown` / `vah_breakout` (± bear60) | Multi-year red / FULL crush |
| `lvn_vacuum` / `naked_poc` | No-op (identical to lock) |
| Soften `vpMinAtrPct` to 0.007 **with poc** | Re-reds 2024–25 (−0.3% to −9.7%) |
| gap1 / maxDay3 / buyBody20 alone | Negligible tw; not worth lock churn |

## Year path (locked restore)

| Year | Ret | n |
|------|-----|---|
| 2020–21 | +9.8% | 5 |
| 2021–22 | +28.6% | 21 |
| 2022–23 | +38.1% | 15 |
| 2023–24 | +47.2% | 11 |
| 2024–25 | +6.4% | 6 |
| 2025–26 | +7.9% | 9 |
| FULL | **+229.6%** | 67 |

Calmar ~1.0 · PF ~2.25 · tw **0.24**

## Preset

`VOLUME_PROFILE_FREQ_DOGE_15M` updated. UI: ★ DOGE FREQ (rej+poc year-clean).

## Next

1. POC-cell autopsy for further safe expansion (not open VAL).
2. Or switch stream to **NEAR F3** (Phase 0 queue).
3. WF+MC only after a path that can approach deployable frequency — do not certify at 0.24/wk.
