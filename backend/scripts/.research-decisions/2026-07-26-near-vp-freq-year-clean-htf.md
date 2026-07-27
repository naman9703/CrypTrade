# 2026-07-26 — NEAR VP FREQ: year-clean via HTF sep + poc_bounce

## Verdict

**YEAR-CLEAN research sleeve** (every year ≥0% on 2021-01→2026-05).  
**NOT deploy-certified** — frequency ~0.16/wk, N=46. Certification harness next.

Do **not** call this “optimized for live” until WF+MC+gates and a realistic freq path.

## Hypothesis

Open F3 `va_rejection` on NEAR is structurally broken (FULL −99.99%, 1117 trades,
5 of 6 years deeply red). Feature discrim + hard A/B showed **HTF separation** is the
master lever — bad-year losers had lower `htfSep` than good-year winners. HTF align
monotonically cleans years and lifts Calmar; without it, ATR/body/ADX levers alone
do nothing useful on the open book.

## One-change / ladder sequence

| Step | Change | All years ≥0 | Notes |
|------|--------|--------------|-------|
| H0 | F3 open (no HTF) | no | −99.99% / tw 3.96 / Cal −0.83 |
| 1 | `vpRequireHtfAlign` + sep **0.0015** | no | +95% / tw 0.33; red 23-24, 24-25 |
| 2 | sep **0.0040** | no | +106% / tw 0.16; tiny reds 21-22/−1.6, 24-25/−0.4 |
| 3 | sep **0.0045** | **yes** | **+193% / Calmar 1.60 / tw 0.12 / n=35** — year-clean frontier |
| 4 | sep 0.0050 | yes | +204% / Cal 1.66 / n=34 — same clean, −1 trade |
| 5 | +`poc_bounce` on sep 0.0045 | **yes** | **+232% / Cal 1.81 / tw 0.16 / n=46** — ACCEPT freq restore |

### Locked stack year path (step 5)

| Year | Ret | n |
|------|-----|---|
| 2020–21 | +23.25% | 5 |
| 2021–22 | +4.04% | 10 |
| 2022–23 | +9.12% | 9 |
| 2023–24 | +51.95% | 11 |
| 2024–25 | +3.94% | 6 |
| 2025–26 | +50.09% | 5 |
| FULL | **+231.64%** | 46 |

Calmar **1.81** · PF **2.37** · tw **0.16** · DD **~14.6%**

## Rejected / do not retest without new evidence

- Open F3 (no HTF) — structurally −99%
- ATR / buyBody / ADX / prior60 / sellExtDown **without** HTF base (all stay −99%)
- `add_val` / `add_vah` on clean lock (crush year-clean; VAL −56%, VAH multi-red)
- `vpMinScore: 6` alone or with poc (re-opens 2021-22 tiny red)
- sep 0.0040 (flat reds; not year-clean under the mandate)
- atr008 / buyP60 stacks on sep 0.0045 (shrink N, no clean gain)

## Locked preset

`VOLUME_PROFILE_FREQ_NEAR_15M`:
- `vpAllowedSetups: ["va_rejection", "poc_bounce"]`
- `vpRequireHtfAlign: true`
- `vpMinHtfSepPct: 0.0045`

## Scripts / artifacts

- `research-vp-freq-near-f3-midyear-autopsy.mjs` — Phase 0 autopsy; HTF master lever
- `research-vp-freq-near-f3-htf-ladder.mjs` — fine sep ladder → 0.0045 frontier
- `research-vp-freq-near-f3-freq-restore.mjs` — `add_poc` ACCEPT
- `.vp-freq-near-f3-*.json` / logs

## Next

1. Cert harness `backtest-validate-vp-freq-near.mjs` (expect RESEARCH_SLEEVE_LOW_FREQ).
2. Optional post-cert freq A/B — do not accept year-red to chase ≥2/wk.
3. Move to next coin (ADA / XLM) after NEAR sleeve is logged.
