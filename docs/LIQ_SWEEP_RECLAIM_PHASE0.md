# Phase 0 — Liquidity Sweep + Reclaim Definitions (locked)

> Locked 2026-07-25 for the Phase 0–7 rebuild audit.  
> Source of truth for code: `liquidity.js`, `INTRADAY_PRO_LIQ_CORE_15M`, `docs/LIQ_CORE_PLAYBOOK.md`.  
> **Do not change strategy logic until Phase 4 root-cause audit is complete.**

Instrument / TF for this audit: **BNBUSDT · 15m · FUTURES**.  
Window: **2025-07-01 → 2026-07-01** (Y1), holdout later **2024-07-01 → 2025-07-01**.

---

## Sweep

Price **intra-candle** pierces a **named liquidity level** by a minimum extension:

| Level | Side | Pierce |
|-------|------|--------|
| Previous day low (PDL) | BUY (SSL) | `low < level × (1 − 0.1%)` |
| Previous day high (PDH) | SELL (BSL) | `high > level × (1 + 0.1%)` |
| Session equal-low cluster (≥3 touches) | BUY | pierce `0.05%` |
| Session equal-high cluster (≥3 touches) | SELL | pierce `0.05%` |

- Multi-bar sweeps allowed (deepest wick tracked until reclaim).
- Same-bar poke+reclaim allowed.
- **Not** required on baseline: swing fractal significance, wick/body ratio, volume spike.

## Reclaim

- **Definition:** close back on the correct side of the swept level  
  BUY: `close > level` · SELL: `close < level`.
- **Hold:** `reclaimHoldBars = 2` — every bar from reclaim through entry must stay on that side.
- Same-bar reclaim **allowed** on baseline.

## Displacement

- Measured as impulse ATR / momentum between sweep and entry (`displacement` feature vector).
- **Baseline hard gate: OFF.** Displacement is logged for audit only until Phase 4 proves it is the dominant loser class.

## Entry trigger

- Signal bar = reclaim index + `reclaimHoldBars` (entry exactly **2 bars after reclaim close**).
- Fill = that bar’s **close** (`intradayLiqEntryAtSignalClose: true`).
- No mitigation retest, no progress-confirm wait on baseline.

## Invalidation (pre-entry)

- Hold fails (price closes back through the level before entry bar).
- Bracket geometry fails (`minRr < 1` or `maxSlPct` exceeded).

## Risk (baseline)

- SL: beyond deepest sweep wick ± **0.15%** of fill.
- Full size → TP2 = min(opposing pool, **2R**) or SL or `time_stop` at **48** bars.
- No TP1 partial, no breakeven-after-partial, no dead-trade compress.

## Explicitly OFF on baseline (research sleeves pinned off)

`daySituationBias`, mitigation entry, RequireDisplacementV2, follow-through gate,
marketStateGate, killzone, CHoCH, entry score, toxic one-sided modes, BUYBD/SELLBO sleeves.

---

## Edge thesis (to be confirmed or rejected by Phase 4)

After a clear stop-run of a **named** pool, fade toward the opposing pool has expectancy
**if** the auction actually displaces away from the pool (follow-through path).  
Prior autopsies: ok_path PF≈2.6; bleed is micro-MFE→SL. Entry filters that only cut N
without lifting expectancy are **banned** (rulebook).
