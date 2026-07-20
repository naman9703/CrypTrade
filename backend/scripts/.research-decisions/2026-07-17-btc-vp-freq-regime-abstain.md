# 2026-07-17 — BTC VP FREQ prepared-regime abstention

## Ask

When market conditions are outside the regimes the setup was optimized for,
abstain (do not trade) because bleed risk is higher.

## Principle (accepted)

Yes — this is the correct live design:

- Encode **prepared vs unprepared** as **bar-time measurable conditions**
- Do **not** hardcode calendar years (“skip 2021”)
- Abstain when the setup has no validated edge in that condition

## What was tested

Baseline: `VOLUME_PROFILE_FREQ_BTC_15M`  
Windows: OOS `2021-07-21→2022-06-30` and lock `2022-06-01→2026-05-31`  
Script: `backtest-vp-freq-btc-regime-abstain.mjs`  
Artifact: `.vp-freq-btc-regime-abstain.json`

| Variant | Meaning | OOS 21–22 | Lock 22–26 | Lock years≥0 |
|---------|---------|----------:|-----------:|:------------:|
| Locked | current | 40t / **−34.3%** | 56t / **+90.5%** | yes |
| **A** structured VAH only (no vacuum any macro) | prepared long | 31t / **−22.0%** | 45t / **+87.7%** | yes |
| B block vacuum VAL | prepared short | 29t / −23.5% | 40t / +81.2% | yes |
| **C** A+B | max abstain | 20t / **−9.3%** | 29t / +78.5% @ **0.14/wk** | yes |
| D bull VAH chase 8% | soft long | 34t / −26.6% | 51t / +77.5% | yes |
| E A+chase | — | 29t / −22.3% | 43t / +87.7% | yes |

## Verdict

**Concept: YES. Promotion of a full abstain stack: NO (not perfect yet).**

- Abstention **reduces** OOS damage (best case −34% → −9%) but **does not make OOS profitable**.
- Strongest OOS damage control (**C**) also crushes lock frequency (0.27 → 0.14/wk) and still loses on 2021–22.
- Softest useful rule (**A**) almost preserves lock return (+90.5 → +87.7) but **2022–23 drops +14.7% → +2.2%** (vacuum VAH winners removed) and OOS remains −22%.

Per rulebook / user mandate (“implement only if perfect”): **do not change BTC preset**.

## Code left in place (research capability)

- `vpSellBreakdownMaxPathPct` wired for VAL vacuum abstention experiments
- Research script retained for the next regime autopsy

## Next hypothesis (if continuing)

2021–22 residual after C is mostly **SELL `va_rejection`** (−$9.7 / 3t) plus leftover structured bleed.
Need a BTC-native prepared-regime definition for bounce shorts / early-bear squeezes — not more global HTF tweaks.
