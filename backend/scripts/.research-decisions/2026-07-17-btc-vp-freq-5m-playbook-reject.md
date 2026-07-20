# 2026-07-17 — BTC VP FREQ 5m playbook REJECT

## Experiment

- **Baseline:** `VOLUME_PROFILE_FREQ_BTC_15M`, BTCUSDT, futures, 2025-06-01 → 2026-05-31
- **Hypothesis:** BTC 15m is profitable but sparse; 5m with duration-scaled macro/profile lookbacks may increase valid auction frequency without loosening the 15m edge gates.
- **Single change:** timeframe 15m → 5m, with equivalent real-time lookbacks (`vpLookbackBars` 384→1152, gap 1×15m→3×5m, vacuum prior lookback 60d).
- **Script:** `backtest-vp-freq-btc-5m-playbook.mjs`
- **Artifact:** `.vp-freq-btc-5m-playbook.json`

## Results

| Variant | N | Trades/wk | Return | DD | Verdict |
|---------|--:|----------:|-------:|---:|---------|
| 15m locked window | 13 | 0.25 | +31.1% | 9.1% | Baseline |
| 5m same scaled | 21 | 0.40 | -39.8% | 39.8% | Reject |
| 5m gap1 | 21 | 0.40 | -39.8% | 39.8% | Reject |
| 5m + `poc_bounce` | 21 | 0.40 | -40.3% | 40.3% | Reject |
| 5m max/day 3 | 21 | 0.40 | -39.8% | 39.8% | Reject |

5m failure was broad, not one setup only:

- BUY `vah_breakout`: 6 trades / -$8.6
- SELL `val_breakdown`: 14 trades / -$29.0
- SELL `va_rejection`: 1 trade / -$2.2

## Verdict

**REJECT 5m VP FREQ for BTC.** It raised frequency only slightly and destroyed expectancy on the same 2025-26 window where the 15m lock is positive. Do not backfill multi-year BTC 5m for this exact playbook unless a new 5m-specific failure-mode hypothesis is written first.

