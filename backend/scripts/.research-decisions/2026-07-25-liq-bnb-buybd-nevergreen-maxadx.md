# 2026-07-25 — LIQ BNB BUYBD never-green SL → maxAdx stand-down

**Status:** `ACCEPT_RESEARCH_SLEEVE` — **4-gate PASS** at `intradayLiqMaxAdx: 50` on top of compression 0.75. Frequency still under ≥2/wk (FULL ~1.7, OOS ~1.5). Mild red half 2025H1 meanR −0.056.
**Config:** `INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M` now includes `intradayLiqRangeCompressionMin: 0.75` + `intradayLiqMaxAdx: 50`.
**Scripts:** `research-liq-buybd-nevergreen-sl-autopsy.mjs`, `research-liq-buybd-maxadx-ab.mjs`
**Artifacts:** `.liq-buybd-nevergreen-sl-autopsy.json`, `.liq-buybd-maxadx-ab.json`

## Hypothesis

Exit/risk economics REJECTED: dominant narrative was never-green SL, but autopsy showed
never-green (MFE&lt;0.25R + SL) is only **−45R / 40 trades**; other losers are **−102R**.
Still, strong-trend fades are a named failure mode. Soft entry-time screens: **ADX&gt;45 / ADX&gt;50**
lift meanR without turning HOLD red (soft).

Mechanism: when ADX is high, sweep→reclaim fades get run over by the trend → full SL
with little MFE. Stand down above an ADX ceiling (relative, causal, bar-level).

## Hard A/B (BUYBD+comp≥0.75 base)

| Variant   | HOLD ret | OOS ret | FULL ret | FULL calmar | FULL tw | Notes |
|-----------|----------|---------|----------|-------------|---------|-------|
| baseline  | +5.3%    | +46%    | +64%     | 0.69        | 2.02    | gates FAIL |
| maxAdx45  | +1.5%    | +75%    | +89%     | 0.94        | 1.56    | MC p5 +18%; no red half n≥10 |
| **maxAdx50** | **+15%** | **+64%** | **+108%** | **1.17** | **1.70** | **4-gate PASS**; 2025H1 −0.056 |

### Gates (maxAdx50)

| Gate            | Result |
|-----------------|--------|
| oosPositive     | PASS (+64%) |
| mcP5Positive    | PASS (+8.5%) |
| calmarOver1     | PASS (1.17) |
| wfDegradationOk | PASS |
| Frequency ≥2/wk | FAIL (FULL 1.7 / OOS 1.5) |

## Caveats (not live-certified)

1. Trade frequency under deploy floor (~1.5–1.7/wk vs ≥2).
2. 2025H1 meanR −0.056 (n=29) — mild red half; do not hide.
3. BNB-only so far — multi-coin check still outstanding.
4. Not a claim of unlimited live readiness; paper / small size only until freq + multi-coin clear.

## What the edge is (updated)

Prepared-mit BUYBD works when (1) the market has enough **range fuel** (compression≥0.75)
and (2) trend strength is not extreme (**ADX≤50**). Outside those regimes, stand down.

## Engine

`passesLiqMarketActivation`: if `intradayLiqMaxAdx > 0` and `ctx.adx > max`, return false.
