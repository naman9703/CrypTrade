# 2026-07-27 — XAUUSDT VP FREQ reject

## Verdict

**`REJECT_PHASE0`** — no viable VP FREQ stack on XAUUSDT. Do not optimize further on
this symbol with the current VP FREQ entry model.

## Why this coin was picked

User request. XAUUSDT is Binance USDT-M gold futures (`TRADING`, onboard 2025-12-11).

## Data constraint

Only **~7 months** of futures history (2025-12-11 → 2026-05-31, ~16k 15m bars).
Multi-year walk-forward / MC certification is **impossible** on this symbol today.
Any result is an exploratory checkpoint only.

## Phase 0 baseline (2025-11-01 → 2026-05-31, 15m)

| Funnel | n | tw | FULL ret | OOS ret | Notes |
|--------|---|-----|----------|---------|-------|
| F3_rej_only | 0 | 0 | 0% | 0% | HTF gates kill all va_rejection |
| F0_open | 14 | 0.46 | **−25%** | −20% | all months red |
| F1_val_rej | 7 | 0.23 | −22% | −19% | |
| F2_poc | 2 | 0.07 | +0.17% | +0.17% | tiny N, not actionable |

## Optimize ladder (coin-native levers)

Tested: loosen HTF (0.0003–0.0015), drop HTF, lower score, minAtr, sellExtDown,
buyBody, drop vacuum, side-only, setup pruning, 5m/1h timeframes.

**Best positive variant: NONE** (n≥3).

| Variant | n | ret | cal | oosRet |
|---------|---|-----|-----|--------|
| 15m F0_open | 13 | −22% | −1.65 | −17% |
| 15m F3 no HTF | 23 | −36% | −1.38 | −3% |
| 5m rej no HTF | 31 | −19% | −1.02 | −4% |
| 1h rej no HTF | 29 | −50% | −1.29 | −16% |
| 15m poc_only | 2 | +0.46% | 0.28 | +0.46% |

## Root cause (technical)

1. **Coin-strategy misfit:** Gold futures on Binance have lower intraday volatility
   and smoother trending behavior than crypto alts. VP rejection / breakdown setups
   that work on NEAR/DOGE do not translate — `va_rejection` either fires zero times
   (with HTF) or bleeds (without HTF).

2. **Setup-level bleed:** `val_breakdown` is the worst bleeder (6 trades, −18.5 net
   on F0 autopsy). `vah_breakout` also negative. Only `poc_bounce` is near flat but
   at 2 trades — noise.

3. **HTF over-filter on low-vol asset:** Crypto-default `vpMinHtfSepPct: 0.0015` +
   `vpRequireHtfAlign: true` eliminates all F3 signals on gold. Loosening HTF does not
   help because the underlying rejection edge is negative.

4. **Insufficient history:** Even if a tiny positive pocket existed, ~7mo / ≤31 trades
   cannot pass ≥30 OOS / WF / MC gates.

## Artifacts

- `research-vp-freq-xau-phase0-screen.mjs`
- `research-vp-freq-xau-optimize.mjs`
- `research-vp-freq-xau-round2.mjs`
- `.vp-freq-xau-phase0.json`, `.vp-freq-xau-optimize.json`, `.vp-freq-xau-round2.json`

## Next

Do **not** wire a XAUUSDT VP FREQ preset. Reopen only if:
- ≥2yr history accumulates **and**
- a new causal hypothesis (different entry model / exit / timeframe) shows positive
  OOS on ≥30 trades.

Alternative gold exposure: **PAXGUSDT** has longer history (onboard 2025-03-27) but
was not requested; still crypto-pegged gold, same VP model risk.
