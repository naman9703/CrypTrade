# Decision — Funding arb Phase 2b (anti-churn)

Date: 2026-07-14
Window: 2025-01-01 → 2026-06-01
Symbols: BTCUSDT, ETHUSDT
Notional: $10k / symbol · Leverage: 5×
Proxy: perp close as spot (DB PK overwrites futures — basis ≈ 0)

## Changes vs Phase 2a (FAILED)

- Raised entry threshold (tested 8 → 25% ann)
- Stability: consecutive settlements *above* threshold (not only same sign)
- Min hold before soft yield-decay exit (flips still exit immediately)
- Default fee path: **maker** (spot ~10bps, perp maker ~2bps, slip ~1bp/leg)

Round-trip maker cost ≈ **0.28% notional** (~$28 on $10k). Break-even funding:

| Min hold (settlements) | ≈ days | Rate needed to cover fees |
| --- | --- | --- |
| 9 | ~3 | ~34% ann average over hold |
| 21 | ~7 | ~15% ann |
| 45 | ~15 | ~7% ann |

## Grid (all honesty FAIL)

| Config | Trades | Gross fund | Fees | Net | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| 8% / stab1 / hold0 / **taker** (2a) | ~95 | ~$580 | high | **−$4.2k** | churn baseline |
| 25% × 6 consec / hold9 / maker | 0 | 0 | 0 | 0 | no lasting ≥25% streaks |
| 12% / stab2 / hold9 / maker (BTC) | 1 | ~$4 | ~$24 | **−$24** | churn fixed; fee > fund |
| 15% / stab2 / hold21–45 / maker | 2 | $4.4 | $47.6 | **−$51** | flip exits kill amortization |
| 12% / stab2 / hold45 / maker | 5 | $8.5 | $119.5 | **−$131** | |
| 8% / stab2 / hold45 / maker | 77 | $711 | $1845 | **−$1441** | still overtrades |
| 8% / stab2 / hold90 / maker | 76 | $714 | $1821 | **−$1410** | longer hold ≠ enough |

## Root cause (post anti-churn)

1. **Fee barrier > episode persistence.** Streaks that meet a fee-covering annualized rate are rare/short on BTC+ETH in this window; hard flips exit before funding amortizes dual-leg costs.
2. **Maker helps vs taker** (same setup: ~−$24 vs ~−$46 on the 12%/stab2 path) but does not flip sign.
3. Raising threshold alone → **0 trades**; lowering it → fees again dominate.

## Verdict

Honesty FAIL / NO-GO for Phase 3. Do **not** promote funding arb. Do **not**
substitute a different strategy as “the answer” by default — there is currently
**no certified deployable stream** (SUPERTREND_ELITE deploy claims also revoked;
see `2026-07-14-supertrend-elite-deployability-revoked.md`).

Defaults in code now favor maker + higher gates (see `resolveFundingArbCfg`) for any follow-up research; economics remain failed on this sample.

## Closed — do not reopen with threshold tweaks

Anti-churn thresholds / holds / maker-vs-taker were exhaustively probed and hit the
same fee wall. **Banned as next steps:** another pass that only raises/lowers
`minAnnualizedYieldPct`, stab count, or min hold on BTC+ETH moderate funding.

## Reopen criteria only (fundamentally different premise)

1. **Extreme funding episodes (≥50%+ annualized)** — harvest rare spikes, not
   common moderate regimes; must beat fee math above on full dual-leg sim.
2. **More symbols** — beyond BTC/ETH (smaller caps often have more sustained
   extreme funding); same honesty gates.
3. **Real spot + basis** — fix `ohlcv_candles` so spot does not overwrite futures
   (basis ≈ 0 under current proxy); retest with true basis PnL, not perp-as-spot.

Until one of those three is in place with a written hypothesis: **park funding arb**.

Artifacts: `.funding-arb-backtest.json`, `.funding-arb-backtest.md` (latest CLI run may show 0-trade 25%/stab6 profile).
