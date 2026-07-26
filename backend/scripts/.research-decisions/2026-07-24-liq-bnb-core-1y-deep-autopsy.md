# BNB LIQ_CORE 1-year deep trade autopsy — REJECT promote (2026-07-24)

**Scope:** Liquidity setup **only** (no SMC / Liquidity Map).  
Coin: BNBUSDT 15m CORE.  
Y1: 2025-07-01 → 2026-07-01. Holdout: 2024-07-01 → 2025-07-01.  
Artifacts: `.liq-bnb-core-1y-deep-autopsy.json`, `.liq-bnb-core-1y-minsl-ab.json`.  
Scripts: `research-liq-bnb-core-1y-deep-autopsy.mjs`, `research-liq-bnb-core-1y-minsl-ab.mjs`.

## Method

For each of **329** Y1 trades, reconstruct OHLC path ±16 bars before / up to 32 after entry:

- Path class from realized MFE/MAE/SL touch timing  
- Day situation, session, level, prior returns, entry candle shape  
- Issue label: **entry** vs **exit** vs regime  

Then soft abstains (causal at entry) → hard A/B → MinSl hypothesis from survivor contrast.

## Baseline Y1

| n | tw | ret | PF | WR |
|---|----|-----|----|----|
| 329 | 6.31 | −85.8%* | 0.656 | 39.5% |

\*Y1-only sim from $100 (sizing path differs from 3y slice; **PF/WR** are the stable compare).

## Path taxonomy (the real failure pattern)

| Path | n | $ pnl | PF | Meaning |
|------|---|-------|----|---------|
| **micro_mfe_then_sl** | 100 | **−118** | ~0 | Tiny green (&lt;0.5%) then SL — **largest loss cell** |
| never_green_slow | 26 | −38 | 0 | Never green, SL after &gt;2 bars |
| mfe_not_captured | 22 | −29 | ~0 | Had MFE, exit missed it |
| immediate_sl | 6 | −10 | 0 | SL within 2 bars |
| **ok_path** | 112 | **+70** | **2.63** | Follow-through cohort |
| **gave_back_after_green** | 62 | **+39** | **5.0** | Had progress (often still net win) |

**Primary failure mode:** ENTRY / early-path — auction never delivers follow-through (`micro_mfe_then_sl` on **range** days is worst $: 58t / −72).  
Exit-labeled cohort is **net positive** — exit tuning is not the first lever on this year.

Entry vs exit loss share (among losers): entry+regime **~38%** of loss $, pure exit **~16%** (rest mixed micro-path).

Worst path×day cells: `never_green_slow|breakout`, `micro_mfe_then_sl|breakout`, `micro_mfe_then_sl|range`.

## Soft (look-ahead vs causal)

| Rule | PF / ret / tw | Causal? |
|------|---------------|---------|
| oracle keep `had_follow` / mfe≥0.5% | **2.06 / +83 / 3.6** | no |
| oracle drop entry-issue labels | **1.06 / +9 / 4.9** | no |
| best causal (body≥0.35, dailyUsed, PDH/PDL-only) | ≤0.75 / still red | yes |

**No causal softPasser** at PF≥1 + ret>0 + tw≥2.

## Hard A/B (causal soft tops)

body≥0.35, continuation dailyUsed&lt;0.7, session-ext off — all **REJECT** on Y1 and HOLD (PF still ~0.64–0.75).

## Survivor contrast → MinSl hypothesis

`had_follow` vs death paths at entry:

| Feature | Death mean | Follow mean |
|---------|------------|-------------|
| **distSlPct** | 0.96% | **1.31%** |
| atrPct | 0.38% | 0.52% |
| Other (vol, score, RR, absorb) | weak lift | |

**One change:** reject tight structural stops (`intradayLiqMinSlPct`) / ATR SL buffer.

| Variant | Y1 PF / ret / tw | HOLD PF / ret | Verdict |
|---------|------------------|---------------|---------|
| CORE | 0.66 / −86 / 6.3 | 0.67 / −83 | |
| minSl 0.8% | 0.76 / −56 / 4.5 | 0.80 / −51 | improve, still red |
| minSl 1.0% | 0.84 / −34 / 3.5 | 0.74 / −49 | |
| **minSl 1.2%** | **0.90 / −14 / 2.8** | **0.89 / −20** | best; **still FAIL gates** |
| atrBuf 0.2 / 0.35 | ~0.64–0.67 | ~0.68–0.70 | noop-ish |

## Verdict

**REJECT** promote. Deep candle autopsy confirms:

1. Edge exists in the **follow-through path cohort** (ok_path / gave_back).  
2. Bleed is **micro-MFE then SL**, especially range + breakout fades.  
3. At-entry LIQ features + MinSlPct move PF toward 1.0 but **do not clear** profitable Y1+HOLD at tw≥2.  
4. Exits are not the primary Y1 problem.

`intradayLiqMinSlPct` remains available as research opt-in (wired); **not** on CORE default.

## Next (LIQ-only)

1. Soft: side-aware prior16 fade-alignment + MinSl interaction (not binary toxic again).  
2. Or entry **timing**: wait for first post-reclaim displacement bar before fill (progress-confirm family already hard-failed — only reopen with new candle-path evidence).  
3. Stay on LIQ; do not fork SMC/Map unless user asks.
