# LIQ_CASCADE — 30-day signal audit (2026-07-31)

**Status:** `REJECT` — not deployable; 0 signals in replay window; data + gate stack block validation.
**Script:** `research-liq-cascade-last10h-signals.mjs` with `HOURS=720 LIQ_SOURCE=force_orders`
**Output:** `backend/scripts/.liq-cascade-last30d-signals.json`

## Window requested vs data reality

| Metric | Requested | Actual |
|--------|-----------|--------|
| Replay window | 30 days (Jun 30 → Jul 30 UTC) | Full 43,200 1m candles per coin ✓ |
| force_orders ticks | 30 days | **~1.5 days only** (Jul 29 02:20 → Jul 30 19:23) |
| BTC ticks | — | 128 |
| ETH ticks | — | 106 |
| BNB ticks | — | 28 |
| Non-zero 5m liq bars / 8640 | — | BTC 47, ETH 43, BNB 10 |

**Conclusion:** The “30-day” replay is effectively a **~1.5-day liq sample** padded with zero-liq bars. Do not treat this as a 30-day edge test until `force_orders` has ≥8 weeks per coin (`accurateReplayReady` in coverage script).

## Signal result

| Coin | ≥min$ bars | Z-pass | Cascade-eligible* | Raw signals | Adapter signals |
|------|------------|--------|-------------------|-------------|-----------------|
| BTC | 23 | 11 | 0 | 0 | 0 |
| ETH | 27 | 15 | 5 | 0 | 0 |
| BNB | 4 | 3 | 0 | 0 | 0 |

\*All cascade detection gates at liq bar close (z, $, OI drop, displacement, ATR).

## Gate funnel (named root causes)

Among threshold-sized liq bars (`nearMisses`):

| Blocker | BTC | ETH | BNB | Notes |
|---------|-----|-----|-----|-------|
| Z-score | 12 | 12 | 1 | Baseline normalizes after cluster; trailing bars fail |
| **OI drop** | **11** | **10** | **3** | **Primary killer** — peak liq bars often show OI **rise** (negative dropPct), not unwind |
| Displacement | 0 | 0 | 0 | Rarely the first failure when $+z pass |
| ATR floor | 0 | 0 | 0 | Rarely blocks |

**ETH cascade-eligible (5 bars, Jul 29 03:20–04:05 UTC):** passed liq+z+OI+disp+ATR but **0 entries** — failed **stall/reclaim** within 5-bar confirm window (price did not pause/reclaim after cascade).

**Largest missed spike (all coins):** Jul 30 13:45 UTC — BTC $8.2M / ETH $1.8M / BNB $60k short liq, z≥23, disp≥4 ATR — blocked by **OI rise ~0.25–0.49%** on same 5m bar.

## Prior validation context (still applies)

From `2026-07-29-liq-cascade-phase0-validate.md`:

- Fade direction has correct **sign** at event level but raw edge **0.02–0.07%/event < ~0.13% round-trip costs** at 1hour granularity.
- OI gate off on 1h BNB sim: still **REJECT** OOS (−6.4%, PF 0.28).
- Widening brackets for frequency → OOS **−27.8%** (87 trades) — do not “solve” via bracket stretch.

## Disposition — ordered fixes (one change per experiment)

1. **Data (P0, blocking):** Keep `force_orders` WS + migration 036 live; run `research-liq-cascade-force-orders-coverage.mjs` weekly. No promote language until ≥8 weeks ticks/coin.
2. **OI gate (P1, hypothesis):** Split modes — `backtest_off` / `live_on` / optional `window_drop` (3-bar OI delta, not same-bar). Re-run 30d replay + full sim with OI off **once**; compare signal count + OOS PF — do not stack with confirm change.
3. **Confirm (P2, hypothesis):** ETH 5 eligible events → test `exhaustionDecayRatio` (already on liq bars) vs strict `stallReclaimBar` — one A/B only after P1 result logged.
4. **Edge vs cost (P3):** At 5min force_orders coverage, re-run phase0 fade15/fade60; require mean event return **> 0.13%** before bracket work.
5. **Deploy bar:** ≥30 OOS trades, PF≥1, OOS return > 0, WF+MC + 4-gate harness — same as rulebook.

## Do not do

- Deploy LIQ_CASCADE live on capital (presets are research-only).
- Re-tweak z/$ thresholds to force signals on 1.5 days of data.
- Stack OI-off + confirm-loosen + wider TP in one PR.
- Use Coinalyze 1hour liq for cascade validation.
