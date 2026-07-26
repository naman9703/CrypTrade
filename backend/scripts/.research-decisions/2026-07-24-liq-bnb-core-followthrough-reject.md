# BNB LIQ_CORE RequireFollowThrough A/B — REJECT (2026-07-24)

Coin: **BNBUSDT** 15m. Baseline: `INTRADAY_PRO_LIQ_CORE_15M` (X4+T1+P1+X5).  
Window: 2023-07-01 → 2026-07-01. Artifact: `.liq-bnb-core-followthrough-ab.json`.  
Script: `research-liq-bnb-core-followthrough-ab.mjs`.

## Hypothesis

CORE enters on reclaim (+2 hold bars) without displacement proof. Soft oracle (keep MFE≥0.5%) shows latent edge; ~75% of loss $ are `never_green` / `sl_no_follow`.  
**One change:** `intradayLiqRequireFollowThrough: true` with `0.5 ATR / 2 bars` — should keep the survivor cohort if “missing confirm” is the gap.

## Hard A/B (fees + slip)

| Window | CORE n / tw / ret / PF | FT 0.5/2 n / tw / ret / PF | Δ |
|--------|------------------------|----------------------------|---|
| FULL | 1034 / 6.6 / **−99.7%** / 0.654 | 1001 / 6.39 / **−99.7%** / 0.656 | −33t, PF≈flat |
| Y2023 | 167 / 6.4 / −59.1 / 0.65 | 162 / 6.2 / −59.5 / 0.65 | noop |
| Y2024 | 377 / 7.2 / −36.7 / 0.65 | 369 / 7.1 / −36.3 / 0.67 | noop |
| Y2025 | 343 / 6.6 / −3.0 / 0.75 | 329 / 6.3 / −2.9 / 0.73 | noop |
| Y2026 | 147 / 5.7 / −0.9 / 0.48 | 141 / 5.5 / −0.9 / 0.46 | noop |
| H12m | 329 / 6.3 / −1.9 / 0.66 | 315 / 6.0 / −1.7 / 0.67 | noop |

Death-loss share FULL: 75.5% → 75.3% (unchanged).

## Gates

Target: FULL PF≥1 + Y25 ret>0 + H12m ret>0 + tw≥2.  
**FAIL** — FT still PF 0.66 / Y25 −2.9 / H12 −1.7; tw still ≥2 but no edge.

## Verdict

**REJECT.** Guide follow-through at 0.5 ATR / 2 bars is a **near no-op on CORE fade** (~97% of setups already pass). Same pattern as ACCEPT follow-through wire (`2026-07-24-liq-bnb-stoprun-reject.md`).

Interpretation: “missing confirm” is **not** the lever at this threshold. Either:

1. Displacement already happens mechanically on almost every pierce+reclaim within 2 bars (gate too loose for BNB 15m), or  
2. The latent MFE≥0.5% cohort is **not** separable by post-sweep ATR travel before entry — survivors and death trades both “follow through” briefly then reverse.

Do **not** promote CORE_FT. Do **not** stack tighter FT multiples as the next “one change” without a soft cohort proof that survivors fail a stricter bar while death trades pass.

## Next (honest)

1. Soft counterfactual: among CORE trades, does `guideFollowThrough(mult, bars)` at entry separate MFE≥0.5% vs never_green? If AUC≈coin-flip → abandon FT family on CORE.  
2. Else if soft clears at stricter mult (e.g. 1.0 ATR / 3) → one hard A/B only.  
3. Parallel architecture fork (not CORE filter): Liquidity Map / SMC FVG-retrace entry timing — different identification + fill price.
