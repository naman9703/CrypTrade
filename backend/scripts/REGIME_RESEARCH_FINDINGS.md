# Phase 1 — Edge diagnosis & cost-aware baseline

Reproduce: `node backend/scripts/backtest-regime-research.mjs` (uses DB candles, `OFFLINE=1` by default).

Data: BTCUSDT / ETHUSDT / BNBUSDT, 15m, futures, windows Q1 (Jan–Mar), Q2 (Mar–May), full (Jan–18 May) 2026.
Cost model: taker 5 bps/side, 5 bps slippage/side, 5× leverage, 1% risk/trade, RR ≈ 2.

## What was tested

The legacy AND-gated engine (`SR_INTRADAY` / order-flow / composite) was confirmed to **barely trade** — sweeping `srIntradayMinScore` 6→10 and toggling the 4H filter produced ≤1 trade across whole windows. The gate stack is the bottleneck, not the score. So diagnosis pivoted to three **transparent, classic baselines** measured directly (no legacy gates):

- `trend_pullback` — EMA20/50/200 stack + ADX≥18, buy pullback-to-EMA20 reclaim.
- `mean_reversion` — fade Bollinger(20,2)/RSI extremes when ADX≤25 (range behaviour).
- `donchian_break` — 20-bar channel breakout with ADX≥18.

## Findings

1. **Costs are the #1 killer.** Fee drag is **15–41% of equity** per window and routinely 2–3× the gross loss (e.g. BTC full `trend_pullback`: gross −16.5%, fees −36.4%, net −52.7%). At 5× leverage with a 0.6% stop the position notional is ~1.7× equity, so every round trip burns ≈0.12% in fees + ≈0.17% in slippage. At 2–3 trades/day this compounds into ruin. **High-frequency 15m trading is structurally unprofitable with taker fills.**

2. **No always-on raw edge.** Even **gross** (pre-cost) PnL is negative for nearly every technique×regime cell. Win rates sit at 25–41% against an RR≈2 breakeven of ~33%. As naively coded, these textbook signals are roughly random-to-negative on this period.

3. **Best relative performer = mean reversion.** Lowest trade count (least cost), best win rate, and the only near-breakeven net (BTC Q2: net −6.6%, PF 0.70, WR 44%). It is the cheapest signal to run.

4. **Regime dependence is real but weak in the naive form.** `donchian_break` is the only gross-positive cell (MIXED, +$34 over 251 trades ≈ breakeven) and ETH Q1 (a trending quarter) showed gross +5.6% for donchian — i.e. breakout pays only in expansion/trend windows, exactly as theory predicts.

## Conclusions that drive the build

- **Best instrument:** BTCUSDT (cleanest, lowest-drag, best mean-reversion behaviour); ETH secondary.
- **There is no naive always-on edge** → a **regime router** that runs at most one playbook per regime, plus **extreme selectivity** (A/B grade only, 2–3 trades/day cap), is mandatory — not optional.
- **Cost reduction is a first-class design goal:** fewer/higher-quality trades, wider RR, maker/limit entries where possible, and a hard trade-count cap. The cost model fee-override bug (`resolveCostModel` now honours `openFeeRate`/`closeFeeRate`) is fixed so all of this is measured honestly.
- **Validation must precede belief:** because gross edges are thin, any "winning" config must clear Monte-Carlo and purged walk-forward gates (Phase 2) before it is trusted.
