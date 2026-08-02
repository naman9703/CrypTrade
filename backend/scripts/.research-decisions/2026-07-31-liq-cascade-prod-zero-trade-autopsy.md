# LIQ_CASCADE production 0-trade autopsy + param sweep (2026-07-31)

**Window:** max force_orders archive ~58h (2026-07-29 → 2026-07-31)  
**Script:** `research-liq-cascade-prod-autopsy-optimize.mjs`

## User question: 198 / 354 nonzero bars but 0 trades?

**Nonzero liq bar ≠ trade signal.** Each bar is a 1m/5m liquidation bucket. Production requires **simultaneous** pass on 6+ gates, then confirm, then bracket geometry.

### Prod 5m funnel (204 nonzero bars)

| Stage | Count | % of nonzero |
|-------|-------|--------------|
| Nonzero liq | 204 | 100% |
| Pass min $ (50k) | ~100 | ~49% |
| Pass z ≥ 2.0 | ~57 | ~28% |
| Pass displacement ≥ 1 ATR | ~130 | ~64% |
| Pass OI window drop | ~47 | ~23% |
| **All trigger gates** | **9** | **4.4%** |
| Confirm hit | 9 | 100% of triggers |
| **Bracket built (sim)** | **0** | **0%** |
| **Trades** | **0** | |

### Prod 1m funnel (362 nonzero bars)

| Stage | Count |
|-------|-------|
| Nonzero | 362 |
| **All trigger gates** | **3** |
| Confirm hit | 3 |
| Bracket built | 0 |
| **Trades** | **0** |

## Root cause (actual, traced per cascade event)

1. **OI window gate** — kills ~77% of bars on 5m (`failOi: 157/204`). Coinalyze OI rarely shows ≥12% drop aligned with liq spike on this archive. **Winners' OI pass rate only ~15–20%.**

2. **Strict z + min $ + disp** — prod 5m needs z≥2, $50k, disp≥1 ATR together → only **9** bars in 58h.

3. **Bracket killer (the real 0-trade bug after trigger)** — all 9 (5m) and 3 (1m) cascade events **confirm successfully**, then **`buildBrackets()` returns null** because:
   - SL at sweep extreme (wide)
   - TP = **1.25× ATR** (default prod)
   - **minRr 0.8** requires TP/SL ≥ 0.8 → **rejected silently**
   - Trace label: `buildBrackets_null` (includes minRr rejection)

**Not a missing HFT engine — production preset cannot place orders given its own SL/TP/minRr math.**

## Fade winners on raw bars (hypothetical, no brackets)

| | 5m bars | 1m bars |
|--|---------|---------|
| Nonzero dom bars | 203 | 362 |
| Fade win (>0.18% cost @ 15–60m) | **79 (39%)** | **131 (36%)** |
| Median winner z | **0.96** | **2.30** |
| Median winner liq $ | **$99k** | **$50k** |
| Median winner disp | **1.48 ATR** | **0.52 ATR** |
| Winners passing prod OI | **~20%** | **~15%** |

There **is** fade edge on many bars, but **production gates + bracket math filter all of it out**.

## Parameter grid (portfolio sim, same costs)

| Rank | Config | Trades | Net P&L |
|------|--------|--------|---------|
| 1 | **1m prod + OI off + confirm 2 + minRr 0 + tp 5×** | 23 | **+$1.29** |
| 2 | 1m prod + minRr 0 + tp 5× only | 3 | +$0.95 |
| 3 | Selective z1.5 1m | 23 | +$0.90 |
| — | **Prod 5m/1m as-shipped** | **0** | **$0** |
| — | 5m prod + OI off + minRr 0 + tp 5× | 27 | −$4.03 |

**Best combo still only +1.3% on $100 / 58h / 23 trades — not HFT, not certified.**

## Required production fixes (evidence-based)

| Issue | Fix |
|-------|-----|
| OI blocks winners | `oiGateMode: off` for backtest; live-only OI or lower threshold |
| minRr + tight TP blocks all triggers | `minRr: 0` + `tpAtrMult: 5` (or structure TP) |
| 1m confirm too long | `confirmLiqBars: 2` not 5 |
| z too high vs winners | 5m: z **1.5**; 1m: z **1.5–1.8** |
| min $ vs winners | Keep ~$50k 5m / $10–15k 1m |

## Disposition

- **Production presets as shipped: broken for this archive** (0 trades by design of bracket gate).
- **Not an HFT system** — bar-close cascade on 1m chart, ~12–38 trades/day max in smoke tuning.
- Ship **`LIQ_CASCADE_PORTFOLIO_1M_PROD_TUNED`** for research only; accumulate ≥8wk ticks before promote language.

Artifact: `.liq-cascade-prod-autopsy-optimize.json`
