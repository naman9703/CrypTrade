# BTC LIQ sweep+reclaim — full setup autopsy (2025)

**Window:** 2025-01-01 → 2026-01-01 | **Symbol:** BTCUSDT 15m | **Config:** `INTRADAY_PRO_LIQ_15M` baseline, no context filter, no CHoCH/killzone/breakdown preset gates

**Script:** `research-liq-btc-setup-autopsy.mjs`

## Results summary

| Metric | Value | Target |
|--------|-------|--------|
| Trades | 22 | ~365 (1/day) |
| Trades/day | 0.06 | ~1.0 |
| Return @ 2% risk | +8.0% | — |
| PF | 0.78 | >1 |
| Win rate | 50% | — |

**Verdict:** Marginal positive return with **negative per-trade expectancy** (PF<1). Frequency is **not** capped by `onePickPerDay` — the bottleneck is **setup qualification funnel** + **wrong playbook on trend days**.

---

## Root cause 1 — Wrong playbook on trend days (main PnL leak)

| Toxic pattern | Trades | Net PnL |
|---------------|--------|---------|
| Long PDL fade on **breakdown days** | 11/14 longs | −$424 |
| Short PDH fade on **breakout days** | 8/8 shorts | −$170 |

The strategy **always fades** PDH/PDL. On BTC 2025, **most taken trades are counter-trend fades on trend days** — the exact failure mode from loser autopsy.

`intradayLiqBreakdownDayBias: true` fixes quality (3 trades, PF 1.55) but **kills frequency** — it vetoes instead of routing to continuation.

**Solution (structural):** Day-type router — fade on range days; trend continuation (`pdh_break`/`pdl_break`) on breakdown/breakout days. Not more threshold filters.

---

## Root cause 2 — Frequency funnel (not onePickPerDay)

| Stage | Count | Per day |
|-------|-------|---------|
| Raw PDH/PDL reclaim events | 109 | 0.28 |
| Days with ≥1 reclaim | 91 | 0.25 |
| Picked signals | 26 | 0.07 |
| Executed closed trades | 22 | 0.06 |

**`intradayLiqOnePickPerDay: false` → still 22 trades.** Pick logic is NOT the bottleneck.

Funnel killers (109 reclaims):
- **Reclaim body ratio 0.35** + must close bullish/bearish — largest setup filter
- **Bracket null** (~40) — min R:R 1.5 when day range is tight, or invalid SL geometry
- Same-bar reclaim reject — 6

**`intradayLiqMinSweepExtensionPct: 0.008` (BNB-tuned)** — does NOT block BTC (p25 extension 0.96%, all reclaims pass). Not the frequency issue.

Lowering extension to 0.4% → 84 trades but **−11% return, PF 0.50** — proves loosening filters adds noise, not edge.

---

## Root cause 3 — Payoff structure (50% WR, PF 0.78)

| Exit | Trades | Role |
|------|--------|------|
| `time_stop` | 11 | 9 winners — small wins, carry PnL |
| `sl` | 8 | Full losses |
| `tp2` | 2 | Rare full target at opposing pool |
| `be` | 1 | — |

Winners and losers similar WR by side, but **SL losses > time_stop wins**. Partial @ 1R + TP2 at opposing pool rarely completes; most trades drift to 48-bar (12h) time stop.

**Solution:** Exit architecture for BTC (trail after partial, or dynamic hold by regime) — not entry score tightening.

---

## Root cause 4 — Entry score does not discriminate

`intradayLiqMinEntryScore: 52` — disabling changes 22→23 trades, same PF. Confirmed prior autopsy (~61 for winners and losers).

**Hardcoding that doesn't solve the issue:** entry score gate, CHoCH gate (0 trades if on), context filters.

---

## Root cause 5 — BNB-centric preset hardcoding

| Field | Value | Issue |
|-------|-------|-------|
| `symbol` | BNBUSDT in preset | BTC inherits via override only |
| `intradayLiqMinSweepExtensionPct` | 0.008 | Tuned BNB Jan–May 2026; harmless on BTC but wrong default narrative |
| `intradayLiqMinReclaimBodyRatio` | 0.35 | Blocks ~55% of reclaims; BNB comment-driven |
| `intradayLiqRequireHtfAlign` | true | **Bypassed for PDH/PDL** in code — misleading config |
| `fillLiqSoloPresetDefaults(BTC)` | injects BTC preset | Can silently add gates if keys undefined |

---

## Regime at entry (2025 BTC)

| Regime | Trades | Net PnL |
|--------|--------|---------|
| TREND_DOWN | 10 | −$92 |
| TREND_UP | 9 | +$7 |
| RANGE | 3 | −$379 |

RANGE days have fewest trades but worst PnL/trade — fade model may be wrong even on “range” label when day becomes breakdown intraday.

---

## Counterfactuals (single knob — do NOT combine)

| Change | Trades | t/day | Return | PF |
|--------|--------|-------|--------|-----|
| Baseline | 22 | 0.06 | +8.0% | 0.78 |
| No entry score | 23 | 0.06 | +8.9% | 0.78 |
| No min R:R | 44 | 0.12 | +4.7% | 0.69 |
| No body ratio | 25 | 0.07 | +6.4% | 0.73 |
| Extension 0.4% | 84 | 0.23 | −11.2% | 0.50 |
| No onePickPerDay | 22 | 0.06 | +8.0% | 0.78 |
| Breakdown veto only | 3 | 0.01 | +4.1% | 1.55 |

**Loosening filters increases trades but destroys edge.** Quality fix (breakdown veto) slashes frequency.

---

## Recommended solution path (BTC, ~1/day target)

1. **Day-type router** — fade only when day situation is range/compression; continuation playbook on breakdown/breakout (use existing `liquidityTrendContinuation.js`, not binary veto).
2. **Side-specific trend gate** — minimum fix: block long PDL on breakdown + short PDH on breakout (removes ~19/22 toxic trades); then add continuation entries to recover frequency.
3. **Expand level universe for frequency** — session clusters + weekly on range days only (not blind expansion).
4. **Exit redesign** — reduce time_stop drift; trail or tighten TP logic for BTC volatility.
5. **BTC-specific preset** — decouple from BNB `INTRADAY_PRO_LIQ_15M` defaults; do not enable CHoCH/killzone without validation.
6. **Do not** chase 1/day by lowering extension/body/R:R — autopsy proves that adds losing trades.

**Honest frequency ceiling:** PDH/PDL-only fade on 15m BTC ≈ **0.25 reclaim events/day**, **~0.06 trades/day** after quality gates. Reaching 1/day requires **additional playbooks or levels**, not parameter tightening.
