# BNB LIQ_CORE adaptive autopsy / relative FT / continuous soft — REJECT (2026-07-24)

Coin: **BNBUSDT** 15m. Baseline: `INTRADAY_PRO_LIQ_CORE_15M`.  
Window: 2023-07-01 → 2026-07-01.  
Artifacts: `.liq-bnb-core-adaptive-autopsy.json`, `.liq-bnb-core-adaptive-hard-ab.json`.  
Scripts: `research-liq-bnb-core-adaptive-autopsy.mjs`, `research-liq-bnb-core-adaptive-hard-ab.mjs`.

## Phase 1 — Autopsy

| Metric | Value |
|--------|-------|
| FULL | 1034t / 6.6/wk / −99.7% / PF 0.65 |
| Primary failure | **instant_no_follow** (death-loss share **75.5%**) |
| Fake-reversal loss share | **36.9%** of loss $ |

Worst cells: `sl_no_follow|breakout`, `never_green|range`, `never_green|breakout`, `sl_no_follow|range`.  
Oracle keep `mfe≥0.5%`: FULL PF **2.63** / +115% @ 3.9/wk (look-ahead only).

## Phase 2 — Flexible FT soft (modes wired in `passesGuideFollowThrough`)

| Mode | FULL PF / ret / tw | Y25 | H12 | Soft pass? |
|------|--------------------|-----|-----|------------|
| fixed 0.5/2 | 0.66 / −92 / 6.1 | −2.8 | −1.9 | no |
| fixed 1.0/2 | 0.66 / −78 / 5.0 | −1.9 | −1.6 | no |
| fixed 1.0/3 | 0.67 / −81 / 5.4 | −2.4 | −1.6 | no |
| atrPct | 0.65 / −86 / 5.3 | −2.0 | −1.6 | no |
| volSpike | 0.65 / −90 / 5.9 | −2.7 | −1.8 | no |
| regime | 0.69 / −78 / 5.4 | −2.1 | −1.5 | no (best FT) |
| regime_strict | 0.67 / −77 / 5.1 | −2.2 | −1.6 | no |

## Phase 3 — Continuous relative abstains soft

Best FULL PF among continuous: `room_and_not_fake` **0.75** (−34% @ 2.9/wk) — still Y25/H12 ≤ 0.  
`abstain_fakeReversal` 0.72; `impulse_x_room` 0.70. **No softPasser.**

## Phase 4 — Hard A/B

**SKIP_HARD_SOFT_EXHAUST** — plan forbids hard-gating without soft clear.

## Verdict

**REJECT** CORE adaptive filter path for returns+freq. Relative FT is implemented (opt-in modes) but does not separate latent MFE survivors causally. Continuous room / fake-reversal soft improves PF modestly but never clears gates.

## Next

Architecture fork: BNB **Liquidity Map** + **SMC FVG-retrace** same window (Phase 5).
