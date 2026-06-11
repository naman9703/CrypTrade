# Strategy Research — Handoff / Context

> Persistent context so any new chat (or after a Cursor crash) can continue
> without re-deriving everything. Last updated: 2026-06-03.
> **A new chat should read this file first.** Reference it with `@STRATEGY_RESEARCH_HANDOFF.md`.

## Goal

Find/build a profitable, automated intraday crypto trading strategy with the
**maximum honest, repeatable risk-adjusted return** (originally framed as
"50%+/month" — see the reality check below).

## TL;DR verdict (what we actually found)

- **50%/month is not achievable** with any honest, repeatable strategy. Any
  backtest showing it is overfit, ignores fees/slippage, or uses ruinous leverage.
- We rigorously tested **all 18 registered strategies** across BTC/ETH/BNB,
  multiple timeframes, and up to 18 months of data with realistic costs.
- **`SUPERTREND_ELITE` is the ONLY strategy that passes out-of-sample validation**
  (all 4 acceptance gates: OOS>0, Monte-Carlo p5>0, Calmar>1, walk-forward
  degradation<35%). Everything else is net-negative OOS after costs.
- **Honest expectation: ~10–21% CAGR (≈1–1.5%/month) at moderate risk, with
  15–30% drawdowns.** The flashy 40–300% CAGR numbers came from a favorable
  5-month window (2026 H1) and do **not** repeat over a full cycle.

## The deployable algo

**`SUPERTREND_ELITE` — multi-coin portfolio.**
5-gate trend-follower: Supertrend flip + ADX≥20(rising) + volume≥1.5× + 1H EMA21/50
alignment + 4H Supertrend alignment + ATR expansion. **Trailing-Supertrend exit /
exit-on-flip** (lets winners run — this exit is why it survives where fixed-TP
strategies bled out).

Uniform config (no per-coin tuning):
```
manualStrategy: SUPERTREND_ELITE, strategyMode: MANUAL
supertrendPeriod: 10, supertrendMultiplier: 3.0, supertrendWilderAtr: true
eliteStMinAdx: 20, eliteStRequireAdxRising: true, eliteStMinVolumeVsAvg: 1.5
eliteStRequireHtf1hEmaAlign: true, eliteStRequireHtf4hAlign: true, eliteStRequireAtrExpansion: true
trailingStopLossAuto: true, futuresTrailingStopMode: SUPERTREND, supertrendFuturesExitOnFlip: true
supertrendFuturesFixedSlPct: 0, supertrendFuturesFixedTpPct: 0
backtestPositionSizing: RISK_AT_SL, riskPerTrade: 10 (PCT), futuresLeverage: 25
```
Portfolio coins: BTCUSDT, BNBUSDT, ETHUSDT, LINKUSDT, XRPUSDT (15m).
Trade frequency is the limiter (~1.3 trades/coin/month) → run many coins to deploy capital.

### Validated numbers (full 17-month BTC+BNB, the trustworthy figure)
| risk% | monthly% | CAGR% | maxDD% | Calmar |
|---|---|---|---|---|
| 10 | 0.9 | 11.0 | 15.9 | 0.69 |
| 20 | 1.4 | 18.4 | 30.6 | 0.60 |

(BTC alone passes ALL gates: +3.3% over 17mo @2% risk, PF 2.42, maxDD 0.8%, Calmar 2.88, all 4 WF folds positive.)

## Scripts created (all in `backend/scripts/`, run from `backend/`)

- `backtest-strategy-compare.mjs` — compare every strategy, ranked by return.
  `ONLY=HTF_RSI SYMBOLS=BNBUSDT FROM=2026-01-01 node scripts/backtest-strategy-compare.mjs`
- `backtest-validate-supertrend.mjs` — SUPERTREND_ELITE param sweep + WF + MC + gates per symbol.
- `backtest-portfolio-supertrend.mjs` — multi-coin portfolio, shared-account compounding + risk scaling.
  `SYMBOLS=BTCUSDT,BNBUSDT FROM=2025-01-01 node scripts/backtest-portfolio-supertrend.mjs`
- `backtest-validate-regime.mjs` / `backtest-validate-mc.mjs` — generic OOS validation harness.
- `backtest-regime-sweep.mjs` — REGIME_ADAPTIVE config sweep (strategy REJECTED, kept for reference).
- `backfill-taker-volume.mjs` — backfills real aggressor (taker) volume from Binance futures.
- `REGIME_ADAPTIVE_VALIDATION.md` — why the regime-adaptive strategy was rejected.

## Important data / infra state

- **Real order-flow data:** 1m candles had ZERO taker volume (order flow ran on a
  weak OHLC proxy — a big reason order-flow backtests were rubbish). Backfilled
  **BTC + ETH 15m** taker volume (`dataTier=taker`, ~100% coverage). 1m + BNB 15m
  still need backfilling (each symbol takes ~7 min due to Timescale compression).
- **Backfill gotcha:** the hypertable is compressed; bulk UPDATE needs
  `SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0` on the client.
- **DB runs in Docker** (TimescaleDB on `localhost:54333`). If you get
  `ECONNREFUSED 127.0.0.1:54333`, Docker Desktop stopped — run `open -a Docker`,
  wait for the daemon, then `docker compose up -d` from repo root. Data persists in
  the `trading_trading-data` volume.
- **`metrics.js` fix:** R-multiples now use entry-time risk (`initialRiskUsd` /
  `initialSlPrice`, recorded in `runner.js`) so breakeven-trailing no longer
  inflates R to infinity. Trades also carry `regime`.
- **Risk overlay** (in `runner.js` + `bot.js`): `riskScale`, vol-target sizing,
  `riskKillSwitchDdPct`, `riskConsecutiveLossLimit`, `riskWeeklyMaxLossPct` — built,
  tested, NOT yet wired into live execution.

## Rejected approaches (don't re-chase these)

- REGIME_ADAPTIVE (trend/range/breakout router): negative OOS, entries below random hit-rate.
- Mean-reversion, EMA cross, breakout-vol, momentum-surge: all net-negative; high-frequency ones lose 90%+ to fees.
- HTF_RSI: UI claimed ~125% but honest backtest is −17.8% (overfit).
- Order-flow engine on real data: over-gated (0–6 trades), no edge as currently written.

## Open next steps

1. Backfill taker volume for remaining coins/1m (`backfill-taker-volume.mjs`).
2. Expand SUPERTREND_ELITE portfolio validation across more coins + full history.
3. Wire the SUPERTREND_ELITE portfolio config into the live bot with the
   kill-switch / cooldown / DD-cap risk overlay.
4. Paper-trade before real capital.

## Environment gotchas

- The sandbox cannot list/kill processes (`pkill`/`pgrep` fail) — avoid launching
  multiple long backtests at once; they contend for CPU and can't be killed.
- Run heavy backtests on the small 2026 window first; full 49k-bar history is slow.
- Some strategies (ENSEMBLE/CONFLUENCE/HTF aggregators) can be O(n²) and hang on 49k bars.
