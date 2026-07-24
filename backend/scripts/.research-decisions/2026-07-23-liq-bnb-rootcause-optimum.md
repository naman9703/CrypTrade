# BNB LIQ_CORE — root cause + optimum attempt (2026-07-23)

Coin: **BNBUSDT** only. Window: 2023-07-01 → 2026-07-01. Holdout: 2025-07-01+.  
Baseline: CORE X4+T1+P1. Artifacts: `.liq-bnb-rootcause-optimum.json`, `.liq-bnb-beoff-mitigation.json`.

---

## Root problem (why results are bad)

1. **Instant no-follow dominates loss $**  
   `never_green` + `sl_no_follow` ≈ **−$176** vs winners **+$114** (full 3y).  
   Oracle skip of that cohort → PF **~3.0** / holdout **+1%** (latent edge exists).

2. **Exit doctrine bug (new finding)**  
   X4 turned TP1 partials **off**, but `intradayLiqBreakevenAfterPartial` stayed **true** → engine arms **`beAt1RWithoutPartial`**.  
   On BNB 3y: **154 BE exits** clipping runners that X4 was meant to keep full-size to TP2.

3. **Entry/liquidity hard gates still fail holdout**  
   same-bar / body / maxSl / post-disp / rebreak-exit / ACCEPT — lift IS PF or cut N; **holdout ret worsens**.

4. **Soft mitigation was a false positive**  
   Midpoint limit-at-level soft sim showed PF>1 / holdout +52%, but ignored BE + used idealized path. Hard sim does **not** confirm profitability.

---

## Optimum solutions tested

| Change | FULL PF / ret / tw | HOLD PF / ret | Verdict |
|--------|-------------------|---------------|---------|
| H0 CORE | 0.53 / −99.9 / 6.7 | 0.60 / −1.0 | baseline |
| Level rebreak exit | ≤0.49 | worse / more N | **REJECT** (refill noise) |
| Entry piles (body/ext/disp/…) | ≤0.67 | holdout worse | **REJECT** |
| **X5 BE off** | **0.65** / −99.7 / 6.6 | **0.66** / −1.9 | **Wired** (exit doctrine). Still EDGE FAIL |
| Mitigation mid0.5 + BE off | **0.81** / −97 / 5.8 | 0.74 / **−7.2** | **REJECT promote** (best FULL PF; holdout ret fails) |
| Mitigation stacks (+noSame/body/…) | ≤0.84 | holdout −8…−16 | **REJECT** |

Frequency cuts accepted; none produced holdout-valid PF≥1 + ret>0.

---

## What was implemented

1. **X5 on CORE preset:** `intradayLiqBreakevenAfterPartial: false` — stops 1R BE clip when TP1 is off.  
2. **Mitigation entry plumbing** (off by default): pending limit toward swept pool (`intradayLiqMitigationFrac` / `WaitBars`) in `liquidity.js` + `runner.js`. Research-only until holdout passes.  
3. **Level-rebreak exit** plumbing (off by default) — tested REJECT.

---

## Verdict

**Root cause:** false-reclaim / no-follow path + runner amputation via accidental 1R BE.  
**Partial optimum wired:** X5 BE-off (PF 0.53→0.65).  
**Not solved:** still **EDGE FAIL** — no holdout-valid path to PF≥1. Soft “profitable” mitigation did not survive hard sim.

**Next (BNB):** need a **holdout-safe** way to approximate oracle skip of instant-death (path rule that does not refill into worse fades), or a different BNB-native liquidity family — not more IS entry stacks.
