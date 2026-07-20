# 2026-07-16 — BTC VP FREQ frequency audit (ablate N-only filters)

**Ask:** Raise frequency by removing filters that cut N without helping return;
explain ETH vs BTC divergence on the same VP framework.

## Ablation (regime locks)

From locked stack (HTF 0.5% + weakBear + prior60d VAL), remove one at a time:

| Remove | N | Ret | Verdict |
|--------|--:|----:|---------|
| (locked) | 30 | **+49%** | — |
| weakBear | 33 | +35% | **Keeps return** — do not remove |
| macroAdapt | 33 | +35% | Same (bull floor = global 0.5%) |
| prior60d VAL | 52 | +27% (23–24 red) | **Keeps years green** — do not remove |
| HTF → 0.15% | 54 | +10% | **Keeps return** — do not remove |
| HTF → 0.4% | 34 | +32% | Still helps; weaker than 0.5% |
| No HTF + p60 only | 560 | −100% | Frequency without edge = ruin |

**Conclusion:** No regime filter is “N-only.” Softening them buys trades by selling expectancy.

## Operational gates (on locked regime stack)

| Change | N | Ret | Years | Verdict |
|--------|--:|----:|-------|---------|
| locked score7 max1/day | 30 | +49% | all ≥0 | prior lock |
| **score → 6** | **31** | **+62%** | all ≥0 | **score7 was hurting both** |
| maxDay → 2 | 33 | +48% | all ≥0 | tiny ret cost |
| gap 3→0 | 30 | +49% | all ≥0 | **not binding** |
| **score6 + max2/day + gap1** | **34** | **+62%** | all ≥0 | **promote** |

## Relock

```text
vpMinScore: 6          # was 7 — ablation: +N and +ret
vpMaxTradesPerDay: 2   # was 1 — small N bump, years still green
vpMinBarGap: 1         # was 3 — non-binding under regime gates; loosen anyway
# keep: HTF 0.5%, weakBear 0.8%, prior60d VAL ≤ −5%
```

Full confirm: **34t / +61.5% / ~0.16/wk** — still far below ≥2/wk target.
Further N requires new setups/TF (VAH reopen already REJECTED), not more gate cuts.

## Why ETH ≫ BTC on the “same” setup

Same engine (`VOLUME_PROFILE` + auction setups); **different coin presets and market behaviour**:

| | ETH FREQ | BTC FREQ |
|--|----------|----------|
| Allowed setups | Open funnel incl. **VAH longs** | **Shorts only** (VAH banned — longs bleed −13…−33%) |
| Good-year engine | VAL follow-through in clean bear **and** structured VAH | Mostly **va_rejection** (+$37–50); VAL is net drag unless deep-bear gated |
| Bad-year pathology | Vacuum VAH path≥2%; shallow bull shorts | Shallow-HTF / non-deep-bear **VAL shorts** in grind |
| What works | Adaptive long+short behaviour | Tighter short quality; fewer valid auctions |
| Realized N (honest) | ~160–200 / 4y after locks | ~30–34 / 4y after locks |

BTC 15m auction structure simply produces fewer high-quality short continuations than ETH
produces long+short auctions. Loosening BTC gates recreates the −72% baseline; it does
not unlock ETH-like frequency.

## Status

Preset + frontend updated. Still research-only (not WF+MC). Frequency gap is structural.
