# BNB LIQ — progress-confirm + discriminator archive (2026-07-23)

Coin: **BNBUSDT**. Baseline: CORE X4+T1+P1+X5.  
Hypothesis: require minR favorable progress before fill to skip instant no-follow (oracle upper bound PF~2.5).

---

## Soft results (misleading)

Optimistic keep-original-PnL if path later confirms → FULL PF **2.0+**, Y25 PF≥1, tw~2.

Honest later-entry soft (recompute PnL at confirm price, fixed wick SL):

| Cell | FULL PF / ret | Y25 | H12 |
|------|---------------|-----|-----|
| w8_r0.5 | ~1.00 / −0.2 | 0.85 / −0.4 | 0.75 / −0.4 |
| w8_r0.5 + PDH/PDL only | **1.16 / +4.8** | 0.88 / −0.2 | 0.76 / −0.2 |

Near-flat only — **not** a validated edge.

No-progress flat early exit: **REJECT** (clips winner $ 188→76).  
BE-at-confirm / progressive BE: **REJECT** (worse than H0).

---

## Hard sim (runner `pendingLiqProgress`)

Wired: `intradayLiqProgressConfirm` + waitBars + minR; research preset `INTRADAY_PRO_LIQ_BNB_PROGRESS_15M`.

| Variant | FULL PF / ret | Y25 | H12 | Verdict |
|---------|---------------|-----|-----|---------|
| H0 | 0.65 / −99.7 | 0.75 / −3.0 | 0.66 / −1.9 | baseline |
| PC_pdh w8_r0.5 | 0.69 / −79.6 | **0.53 / −33.7** | 0.56 / −22.6 | **REJECT** |

Hard is **much worse** than honest soft (avg loss ballooned; Y25 destroyed). Soft path filter ≠ live stop-fill economics.

Cancel-on-rebreak `continue` fix did not change outcome.

---

## Discriminator conclusion

Instant no-follow is **not** stably separable at entry with relative LIQ features tested to date. Path rules that look good in soft / oracle counterfactuals fail honest hard sim (same family as soft-mitigation false positive).

---

## Verdict

1. **REJECT** progress-confirm as CORE / BNB promote path. Plumbing stays **opt-in research only** (off on CORE).
2. **Archive classical fade CORE as BNB primary stream** for profitability work — EDGE FAIL after exits (X4/T1/P1/X5), ACCEPT, hybrid, year-regime, progress-confirm.
3. **Next for BNB profitability:** lift **VP FREQ BNB** Calmar 0.96→>1 (already +260% / MC+ / no catastrophic year) — nearest honest profitable sleeve — then revisit LIQ only as a **new** stop-run family with coin-native prepared matrix, not more fade knobs.

Artifacts: `.liq-bnb-progress-confirm-soft.json`, `.liq-bnb-progress-confirm-honest.json`, `.liq-bnb-progress-confirm-hard.json`.
