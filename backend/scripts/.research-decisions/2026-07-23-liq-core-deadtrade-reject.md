# LIQ_CORE — dead-trade A/B + refined sweep (2026-07-23)

Window: BNBUSDT 15m, 2025-01 → 2026-06 · baseline = CORE + X4 (no TP1 partial)  
Scripts: `research-liq-core-rootcause-deadtrade.mjs` · artifacts `.liq-core-rootcause-deadtrade.json`, `.liq-core-deadtrade-r2.json`

## Promotion rule

Promote only if PF **and** ret improve vs H0_x4 **and** freq ≥60% of CORE. Do not promote N-only or noise.

## Round 1 (planned D* grid)

| Variant | n | /wk | Ret% | PF | Instant $ | Winner $ | Verdict |
|---------|---|-----|------|----|-----------|----------|---------|
| **H0_x4** | 544 | 7.38 | −99.42 | **0.495** | −154 | +97 | baseline |
| D1 b4/0.5R/0.55 | 582 | 7.90 | −99.57 | 0.433 | −143 | +76 | **REJECT** — clips winners |
| D2 b8/0.5/0.55 | 571 | 7.75 | −99.59 | 0.469 | −150 | +88 | REJECT |
| D3 b4/0.3/0.4 | 592 | 8.03 | −99.57 | 0.451 | −149 | +82 | REJECT |
| D4 b6/0.5/0.4 | 594 | 8.06 | −99.52 | 0.462 | −152 | +85 | REJECT |
| T1 maxTpRr=2 | 554 | 7.52 | −99.31 | **0.534** | −168 | +114 | mild **PROMOTE** (exit geometry) |
| T2 maxTpRr=1.5 | 561 | 7.61 | −99.32 | 0.518 | −164 | +107 | weaker than T1 |
| X D1+tpRr2 | 591 | 8.02 | −99.52 | 0.465 | −152 | +87 | REJECT |

## Round 2 (refined dead-trade — longer wait / never-green-only)

| Variant | PF | Ret | better vs H0? | Note |
|---------|----|----|---------------|------|
| D5–D7, D10 | ≤0.49 | ≈H0 | no | still clip or flat |
| D8 b16/0.5/0.4 | 0.508 | −99.29 | tiny yes | noise-level; instant $ **worse** |
| D9 b24/0.5/0.55 | 0.499 | −99.31 | tiny yes | noise |
| **T1 maxTpRr=2** | **0.534** | −99.31 | **yes** | best clear lift; WR 24→28% |
| T1+D6 | 0.520 | −99.34 | yes | worse than T1 alone |

## Why dead-trade fails on CORE (the why of the why)

Hypothesis was correct that **instant no-follow** dominates loss $. Compression after 4–8 bars with MFE &lt; 0.5R **does** shrink some dead-path losses — but many **true stop-runs also print &lt;0.5R MFE early** and only pay after 12–33+ bars. Early SL pull-in amputates that cohort (winner $ 97 → 76 on D1). Longer waits / lower MFE thresholds collapse to near-H0 noise.

**Conclusion:** Layer-4 dead-trade is the right *class* of idea for LIQUIDITY_MAP-style engines, but **not an optimum fix for classical PDH/PDL fade CORE** under this window — it cannot separate “never green” from “slow runner” with bar-count × MFE alone.

## Actions

1. **Do not** enable `intradayLiqDeadTrade*` on CORE defaults.
2. **Wire T1:** `intradayLiqMaxTpRr: 2` (closer structural TP — banks more winners without cutting entries).
3. Keep X4 (no TP1 partial).
4. Still **EDGE FAIL** (PF ~0.53). Next = new playbook / non-fade liquidity edge — not more entry filters, not more D* tuning.

## Verdict

**DEAD-TRADE REJECT** on LIQ_CORE.  
**T1 EXIT GEOMETRY PROMOTE** (mild).  
Classical fade + path management still insufficient for PF≥1 at deployable frequency on BNB 2025–mid-2026.
