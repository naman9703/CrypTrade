# Decision — LIQ FREQ_EDGE stream (classical only, no trend continuation)

Date: 2026-07-14  
Window: **2025-01-01 → 2026-06-01** (~17 months)  
Script: `backtest-liq-freq-edge.mjs`  
Artifact: `backend/scripts/.liq-freq-edge-results.json`

## Hypothesis

Replace VP-style ultra-low frequency with **liquidity sweep classical fade only**:
- No `evaluateTrendContinuationSetup` (day-router trend leg failed at PF ~0.09–0.25)
- Coin-routed presets: BNB partial @1R, ETH trail + session levels
- Breakdown/breakout veto on toxic counter-trend fades (BTC autopsy)

Target: **2–5 trades/week/coin** with **ret>0, PF≥1**.

## Results (FREQ_EDGE vs legacy)

| Symbol | Variant | Trades | tr/wk | WR% | Return% | PF |
|--------|---------|-------:|------:|----:|--------:|---:|
| BNB | legacy LIQ_15M | 75 | **1.02** | 61.0 | −3.06 | 0.96 |
| BNB | FREQ_EDGE v2 | 11 | 0.15 | 23.1 | −17.55 | 0.22 |
| ETH | legacy | 6 | 0.08 | 44.4 | −3.59 | 0.56 |
| ETH | FREQ_EDGE | 16 | 0.22 | 18.8 | −4.00 | 0.16 |
| BTC | FREQ_EDGE | 0 | 0 | — | 0 | — |

Portfolio FREQ_EDGE (BNB+ETH): **27 trades / 17mo** (~0.37/wk) — **FAIL** frequency and edge.

## One-change follow-ups (same day)

| Change | BNB n | tr/wk | Return% | PF | Verdict |
|--------|------:|------:|--------:|---:|---------|
| Baseline hold 48 bars | 75 | 1.02 | −3.06 | 0.96 | Best full-window |
| Max hold 24 bars | 75 | 1.02 | −12.98 | 0.78 | REJECT |
| Max hold 16 bars | 75 | 1.02 | −3.42 | 0.94 | REJECT |
| onePickPerDay off | 75 | 1.02 | −16.12 | 0.81 | REJECT |

## Why FREQ_EDGE failed

1. **BNB ≠ BTC on breakdown veto** — veto collapses BNB frequency and removes profitable breakdown-day fades (quant: BNB breakdown days 70% WR). Coin-specific veto required; blanket FREQ_EDGE_CORE was wrong for BNB.
2. **ETH trail path** — 15/16 exits `trail`, 19% WR; trail-only LIQ on ETH bleeds (matches prior `research-liq-bnb-btc-quant` BTC trail −26% finding).
3. **Trend continuation remains banned** — naive router already REJECTED (`2026-07-12-btc-day-router-test.md`).
4. **2–5 trades/week/coin is not in the data** — best honest frequency is **BNB legacy ~1/wk** at **PF≈1, slightly negative** on full 17mo window. Loosening picks (`onePickPerDay off`) **increases losses**, not edge.

## Verdict

**REJECT** FREQ_EDGE as deployable stream. Presets remain in codebase for research/UI (`intradayLiqPlaybook: FREQ_EDGE`) — **do not promote**.

## What actually works best (provisional, not certified)

| Path | Frequency | Edge (17mo) | Notes |
|------|-----------|-------------|-------|
| BNB `INTRADAY_PRO_LIQ_15M` legacy | ~1/wk | −3%, PF 0.96, 61% WR | Near breakeven; exit/time_stop drag |
| BNB LIQ Jun25–Jun26 only | ~1.3/wk | +7.7%, PF 1.19 | Regime-dependent — not full-window |
| BTC legacy (BNB preset on BTC) | ~0.04/wk | +5.2%, PF 2.38 | **3 trades** — anecdotal |
| VP Tier-A | ~0.2/mo | BNB+ETH positive | Absurdly low N |

**Honest frequency ceiling for classical PDH/PDL 15m:** ~**0.25 reclaim events/day** raw → **~0.06–1.0 trades/week** after quality gates, depending on coin. **2–5/week with positive expectancy was not found.**

## Next experiment (one change only)

**Stream: BNB classical legacy — exit architecture only**

- Baseline: `INTRADAY_PRO_LIQ_15M` unchanged entries
- Single change: runner exit — e.g. tighten time_stop giveback, partial→runner trail after TP1 (LIQ_MAP `PARTIAL_RUNNER` pattern), or dynamic hold by `dayRegime`
- Do **not** stack: breakdown veto on BNB, onePickPerDay off, ETH trail, or trend continuation

Alternate parallel track (Phase 2): Elite disaster SL — separate stream, not LIQ.

## Code shipped (research infra)

- Presets: `INTRADAY_PRO_LIQ_FREQ_EDGE_*` in `srIntradayOptimized.js`
- UI: **★ BNB+ETH FREQ_EDGE** button in SR_INTRADAY strip
- Script: `npm run backtest:liq-freq-edge`
