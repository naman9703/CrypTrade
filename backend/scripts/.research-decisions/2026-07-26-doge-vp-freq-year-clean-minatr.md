# 2026-07-26 — DOGE VP FREQ: year-clean via min ATR (+ BUY body)

## Verdict

**YEAR-CLEAN research sleeve** (every year ≥0% on 2021-01→2026-05).  
**NOT deploy-certified** — frequency ~0.16/wk, N=46, no WF+MC+4-gate yet.

Do **not** call this “optimized for live” until frequency restore and harness pass.

## Hypothesis

2024–25 losers under the prior stack were mostly **never-green SLs in low ATR%**.  
Band autopsy: only `atr≥1%` paid in that year; `0.4–1%` bled. Soft fill-bar vol
probes from the prior discrim were **invalid** (`va_rejection` already requires
`vpRejectionMinVolRatio≥1.0` at signal; hard `vpMinBarVolRatio` correctly no-oped).

## One-change sequence

| Step | Change | 2024–25 | All years ≥0 | Notes |
|------|--------|---------|--------------|-------|
| H0 | prior DOGE F3 stack | −15.85% | no | tw 0.27 / +129% |
| 1 | `vpMinAtrPct: 0.008` | **+2.09%** | **yes** | primary year-clean |
| 2 | +`vpBuyRejectionMinBody: 0.25` | **+6.34%** | **yes** | better FULL/Calmar |

### Locked stack year path (step 2)

| Year | Ret | n |
|------|-----|---|
| 2020–21 | +3.87% | 4 |
| 2021–22 | +12.07% | 14 |
| 2022–23 | +40.16% | 12 |
| 2023–24 | +58.53% | 8 |
| 2024–25 | +6.34% | 4 |
| 2025–26 | +20.66% | 4 |
| FULL | **+231.9%** | 46 |

Calmar ~1.28 · PF ~2.48 · tw ~0.16

Step-1 alone (ATR only): FULL +181% / Calmar 1.09 / tw 0.18 / 24–25 +2.1%.

## Rejected / do not retest without new evidence

- Soft `drop_vol_lt_*` as entry gate (fill-bar mismatch; hard minVol no-op)
- `vpMinAtrPct ≥ 0.009` (turns 2025–26 red)
- `vpRejectionMinVolRatio` 1.5/1.8 on ATR stack (re-reds 24–25 and/or 25–26)
- `vpBuyRejectionBlockBullTrend` on ATR stack (year-clean but crushes 2022–23 keepGood)

## Scripts / artifacts

- `research-vp-freq-doge-f3-2425-feature-discrim.mjs` — ATR signal found; vol soft invalid
- `research-vp-freq-doge-f3-2425-atr-residual.mjs`
- `.vp-freq-doge-f3-2425-atr-residual.json`

## Preset

`VOLUME_PROFILE_FREQ_DOGE_15M` — research year-clean sleeve.

## Next

1. Frequency restore without re-redding a year (relax gap / reopen setups with coin-native A/B).
2. WF + MC + 4-gate before any promote language.
3. Parallel: NEAR F3 Phase 0 → coin-native stream.
