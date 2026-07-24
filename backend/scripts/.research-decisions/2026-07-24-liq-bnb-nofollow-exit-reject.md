# BNB LIQ — no-follow exit proxy A/B REJECT (2026-07-24)

Coin: **BNBUSDT**. Baseline: CORE X4+T1+P1+X5.  
Window: 2023-07-01 → 2026-07-01. Artifact: `.liq-bnb-nofollow-exit-ab.json`.

## Hypothesis

Soft exit oracle (`.liq-bnb-core-exit-oracle.json`): keep trades with MFE ≥ 0.5% → FULL PF **~2.63** / **+115%** @ **~3.9/wk**.  
Causal proxies from CORE without Asia session crush:
1. Dead-trade SL compress (`intradayLiqDeadTrade*`) — regrid vs prior CORE reject params
2. Progress-confirm stop fill (`intradayLiqProgressConfirm`) — softer than prior reject cell
3. Mild guide vol 1.2 stacked on dead-trade

Target: FULL PF≥1 + H12/Y25 ret>0 + **tw≥2**.

## Hard results (summary)

| Variant | Y25 PF/ret | H12 ret | FULL PF/ret | tw | Verdict |
|---------|------------|---------|-------------|----|---------|
| H0 | 0.75 / −3.0 | −1.9 | 0.65 / −99.7 | 6.6 | baseline |
| D* grid (6 cells) | ~0.71–0.77 / −2…−4 | −1.6…−2.7 | ≤0.67 / ~−99.7 | 6.9–7.3 | **REJECT** |
| D8 + vol12 ± atr/follow | ~0.71 / −7…−9 | −4…−7 | ≤0.72 / ~−98 | 5.8–6.0 | **REJECT** |
| PC_r03_w8 | 0.64 / −10.9 | −8.9 | 0.63 / −98.7 | 4.6 | **REJECT** |
| PC_r05_w8 | **0.52 / −27** | −15.9 | 0.65 / −92.4 | 3.1 | **REJECT** (Y25 destroyed) |
| PC_r05_w12_vol12 | 0.63 / −22 | −16.7 | 0.68 / −81 | 2.6 | **REJECT** |

Best FULL PF among dead-trade stacks (~0.72) is still deep red and holdout-worse. Progress-confirm again fails hard economics (same family as `2026-07-23-liq-bnb-progress-confirm-reject.md`).

## Interpretation

Soft MFE keep ≠ live dead-trade / delayed fill. Compressing SL or waiting for minR before fill does **not** separate never-green from slow runners on BNB CORE; PC worsens Y25.

## Verdict

**REJECT** dead-trade regrid and progress-confirm as promote path for returns+freq.  
Do **not** wire on CORE. Do **not** re-promote Asia-only ~0.2/wk sleeve as the answer.

## Next (ordered)

1. Soft **at-entry feature discriminator** for `mfe≥0.5%` survivors vs `never_green`/`sl_no_follow` — universal across Y24+Y25+H12, tw≥2 soft floor. Hard A/B only if soft clears.
2. If (1) fails → **LIQ_BNB_STOPRUN** new playbook (with-trend displacement continuation on weekly+PDH), Y25→H12 first — not more fade vetoes / exit compress.
