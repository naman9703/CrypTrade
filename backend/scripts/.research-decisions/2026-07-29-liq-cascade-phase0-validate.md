# LIQ_CASCADE — implementation audit, look-ahead fix, corrected validation (2026-07-29)

**Status:** `REJECT` (bar-close sleeve at 1hour granularity) — implementation now correct; edge is real in sign but below cost floor at available data granularity.
**Symbols:** BNBUSDT primary (longest liq coverage, 18.2wk); BTC/ETH phase0 only (9.4wk).
**Scripts:** `backtest-validate-liq-cascade.mjs`, `research-liq-cascade-phase0.mjs`, `src/strategy/techniques/liqCascade.test.mjs`

## Audit findings (initial implementation was NOT correct)

1. **Look-ahead bias (critical).** Coinalyze bars are stamped at interval START; the old
   `sumLiqInWindow(t <= candle_ts)` let a 1m candle at 14:03 see liquidations occurring up to
   15:00. The earlier "continuation slightly positive" phase0 result was this leak — forward
   returns were correlated with future liquidations inside the same hourly bar.
2. **Granularity mismatch.** Cascade window (3×1m) and z lookback (48×1m = 48min) were defined
   in candle bars but applied to 1hour liq/OI data → hour-boundary z artifacts, OI drop ≈ 0
   almost everywhere (why only 8–9 trades fired).
3. **Phase0 metrics inflated.** One hourly spike counted as an event on many consecutive 1m
   candles; events/week divided by the requested 2y window instead of actual ~10–18wk coverage.

## Fix (single concept: causal liq-bar timeline)

`liqCascade.js` rewritten: `prepareLiqBars`/`prepareOiBars` key every Coinalyze bar at its
**close time** (ts + intervalMs = first moment it is observable), z-score per liq bar vs prior
liq bars only, OI drop bar-over-bar, displacement measured across the bar span on candles,
max one signal per liq bar, stall/reclaim candle confirm within one liq interval.
Unit test asserts causality explicitly (signal index ≥ liq-bar close index) — PASS.

## Corrected Phase 0 (causal, 1hour bars, z≥1.8, ≥$30k)

| Symbol | events | /wk (coverage) | fade15 | cont15 | fade60 | cont60 |
|--------|--------|----------------|--------|--------|--------|--------|
| BTC | 106 | 11.2 (9.5wk) | +0.017 | −0.017 | −0.002 | +0.002 |
| ETH | 97 | 10.4 (9.3wk) | +0.039 | −0.039 | +0.060 | −0.060 |
| BNB | 130 | 7.2 (18.2wk) | +0.068 | −0.068 | +0.070 | −0.070 |

**Sign flipped after leak removal: FADE is the positive side, continuation negative** (the
economically sensible direction — fade the forced-flow overshoot). But raw edge is
0.02–0.07%/event vs ~0.13% round-trip costs (0.08% fees + 0.05% slippage) → below cost floor.

## Full sim A/B (BNB, 2026-01-01→07-29, IS/OOS 60/40, 1m TF, 10x, realistic costs)

| Variant | n | tw | IS ret | OOS ret | OOS PF(R) | Verdict |
|---------|---|----|--------|---------|-----------|---------|
| fade, preset brackets, OI gate on | 7 | 0.2 | 0% (n=0) | −4.4% | 0.25 | REJECT |
| fade, OI gate off | 13 | 0.4 | +0.5% | −6.4% | 0.28 | REJECT |
| continuation, OI gate off | 5 | 0.2 | −1.8% | −4.8% | 0.00 | REJECT |
| fade, event-scaled brackets (TP 12×ATR, hold 240, minRr 0.5) | 87 | 2.9 | +1.2% | **−27.8%** | 0.43 | REJECT |

- OI gate is unusable historically: Coinalyze OI history is only days deep → blocks nearly all
  of the window. Keep it live-only (OI streams in real time).
- Frequency target reachable (2.9/wk) but only by widening brackets, which loses badly OOS.

## Root cause of REJECT (named)

At 1hour event granularity the fade edge (~0.07%/event, decaying after 15–60m) is smaller than
round-trip costs (~0.13%). No bracket geometry can extract a sub-cost edge; wider TP/hold just
adds drift exposure (OOS −27.8%). This is a **data-granularity limitation, not a premise
failure** — the premise (fade liquidation overshoot) has the right sign on all 3 symbols.

## Disposition

- Bar-close LIQ_CASCADE presets: research-only, do NOT deploy. UI presets stay but no promote language.
- Live tick executor stays paper-gated (`liqCascadeLiveTickEnabled` + `LIQ_CASCADE_LIVE_ALLOW=1` for live).
- `force_orders` hypertable (migration 036) is now persisting tick-level liquidations.
  **Reopen condition:** ≥8–12 weeks of own tick data → rebuild at 1min/5min bars where the
  overshoot is captured near its peak (edge per event should exceed cost floor at that
  granularity, as sophisticated-retail practice suggests). Re-run this same harness unchanged.
- Do not re-tweak thresholds on 1hour bars — the cost-floor math cannot be filtered around.
