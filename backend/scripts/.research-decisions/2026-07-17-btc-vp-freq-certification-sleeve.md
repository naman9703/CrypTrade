# 2026-07-17 — BTC VP FREQ certification = research sleeve, not standalone deploy

## Experiment

- **Baseline:** locked `VOLUME_PROFILE_FREQ_BTC_15M`
- **Window:** BTCUSDT futures 15m, **2020-01-01 → 2026-05-31**
- **Script:** `backtest-validate-vp-freq-btc.mjs`
- **Single change:** none — frozen-lock validation only

## Validation result

- Full window: **75 trades / +145.4% / CAGR 15.0% / Calmar 1.10 / DD 13.7% / PF 2.17**
- Jun→May year buckets: **all positive**
  - 2019-20 +3.5%
  - 2020-21 +12.1%
  - 2021-22 +1.3%
  - 2022-23 +8.0%
  - 2023-24 +6.4%
  - 2024-25 +33.9%
  - 2025-26 +35.5%
- Monte Carlo (1% risk): **p5 +13.2%**, ruin 0.0%
- Expanding purged walk-forward: **OOS sum +86.9% on 61 OOS trades**
- Core gates: **PASS**
  - OOS > 0
  - MC p5 > 0
  - Calmar > 1
  - WF degradation < 35%

## Frequency reality

- Full-window frequency: **~0.22 trades/week**
- This **fails** the deployable-frequency target (≥2 trades/week/coin)

Passing the robustness gates does **not** override the frequency doctrine. This is
not a standalone deployable BTC stream.

## Stress summary

- Costs remain positive at **slip×2** and **slip×4**
- **Liquidity crunch** (slippage ×8, taker-only) turns sharply negative

## Verdict

**PROMOTE only as `RESEARCH_SLEEVE_LOW_FREQ`.**

Meaning:

1. The lock is honest and robust enough to keep as a **portfolio sleeve**
2. It is **not** enough activity to deploy as the main BTC strategy
3. Next work must come from:
   - a new BTC-native positive setup family / timeframe with its own prepared matrix, or
   - portfolio breadth (ETH next), not looser BTC vacuum gates
