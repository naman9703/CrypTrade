# Backtesting panel — how it works & why it helps

This document describes the **Backtest** view in the trading app: what it does under the hood, how to use it, and how it supports safer strategy development.

---

## Why the backtesting panel is helpful

1. **Test before you risk capital**  
   You replay a **saved strategy version** (signal logic + parameters from the database) on **historical candles**, with **fees, slippage, and (for futures) funding** applied. You see return, drawdown, trade list, and distributions *before* turning the bot on live or paper.

2. **Same core logic as live (where it matters)**  
   Supertrend uses the same `computeSupertrendSeries` implementation as live trading. Baseline strategies (EMA cross, RSI, breakout volume, etc.) reuse the same signal paths as the existing backtest/strategy layer. That reduces “backtest looks great, live is different” drift from duplicated indicators.

3. **Honesty guardrails**  
   The simulator is built to avoid common cheating patterns: signals on the **closed** bar, fills on the **next** bar’s open (no peeking ahead), costs on by default, optional **approximate intelligence gate** replay, and **walk-forward** metrics when you enable optimization splits.

4. **Tuning loop in one place**  
   You can run **parameter sweeps**, see a **Sharpe heatmap**, compare **train vs test** Sharpe for walk-forward runs, **compare up to three runs** side by side, and **promote** a strong run to a **new strategy version + bot instance** (with server-side promotion thresholds).

5. **Data visibility**  
   The **coverage calendar** shows whether you actually have enough bars (and related series) for the range you chose, and offers a **sync** action to backfill from public APIs.

---

## How to open it

1. Log in and start the app as usual (e.g. frontend at `http://localhost:5173`).
2. Open the **sidebar** (menu).
3. Click **Backtest** (third main view alongside Overview and instance trading).

The UI is scoped to your **logged-in user**: runs and optimizations are stored per user in Postgres.

---

## High-level architecture

```text
BacktestPage (React)
    │
    ├─ POST /api/backtest/runs          → creates `backtest_runs` row, status `queued`
    ├─ GET  /api/backtest/runs          → list runs
    ├─ GET  /api/backtest/runs/:id      → run detail + metrics JSON
    ├─ GET  /api/backtest/runs/:id/trades
    ├─ GET  /api/backtest/runs/:id/equity-curve
    ├─ POST /api/backtest/data/sync     → backfill klines / funding / F&G / OI
    ├─ GET  /api/backtest/data/coverage
    ├─ POST /api/backtest/optimize      → many child runs + `backtest_optimizations`
    └─ POST /api/backtest/promote/:runId → new `strategy_versions` + `bot_instances`

Worker pool (Node worker_thread)
    ├─ Loads candles + funding (futures) from DB (with lazy ingest from Binance APIs)
    ├─ Runs `runner.js` simulation
    ├─ Writes trades, equity points, final metrics
    └─ Emits WebSocket: backtest_progress | backtest_complete | backtest_failed

Frontend store merges `backtest_progress` into `backtestProgress` for live progress bars.
```

Heavy work runs **off the main API thread** so HTTP and WebSockets stay responsive.

---

## UI layout (three columns)

| Area | Purpose |
|------|--------|
| **Left** | **New backtest** form (strategy version, symbol, timeframe, date range, starting USDT, slippage, gate mode, walk-forward toggle). **Runs history** with status, cancel/delete, progress. |
| **Center** | **Results** (selected run): KPI grid + tabs. **Optimization** (sweeps + heatmap + walk-forward column). **Compare** (up to 3 runs, overlaid equity). |
| **Right** | **Data coverage** for symbol/timeframe, monthly grid, **Sync 1y backfill** button. |

---

## Creating a run

1. Pick a **strategy** and **version** (same versions you use for live instances).
2. Set **symbol**, **timeframe**, **from / to** dates, and **starting USDT**.
3. Optional **advanced** behaviour:
   - **Slippage** (as % of price per fill).
   - **Intel gate**: `off` or `approx` (see below).
   - **Walk-forward**: when enabled, the server stores a train/test split; after the run, **metrics include `walkForward.train` and `walkForward.test`** for out-of-sample-style diagnostics (first `trainPct` of bars vs remainder).

4. Click **Run backtest**.  
   The run is **queued**; progress updates arrive over the existing WebSocket hub.

---

## What the simulator does (rules of the game)

- **No look-ahead**  
  The signal is evaluated on the bar that just **closed**. Entries and exits use the **next** bar’s prices (typically **open**), consistent with “decide after the candle closes.”

- **Costs**  
  Maker/taker-style fee rates and slippage come from the resolved cost model (defaults aligned with live bot-style assumptions). Futures paths can apply **funding** from stored historical funding rates.

- **Strategies**  
  Engine type is derived from the version’s config (e.g. Supertrend, EMA cross, RSI, breakout volume, SURF_PULSE_ML when wired). **SUPERTREND** uses the shared Supertrend series computation.

- **Approximate intelligence gate (`gate_mode = approx`)**  
  The gate is **not** a full replay of live order-book / options / liquidation feeds (those aren’t historically available). It **approximates** a score from:
  - Fear & Greed history  
  - Funding z-score over a rolling window  
  - Open interest change + long/short ratio  
  - Multi-timeframe Supertrend alignment on aggregated candles  

  The UI labels this as approximate so you don’t treat it as identical to production intelligence.

- **SURF_PULSE_ML**  
  Uses the AI service **`POST /predict_batch`** to score many bars in one call. The service returns a **`training_cutoff_ts`**; if your backtest starts **before** that time, the adapter treats predictions as unsafe (look-ahead risk) and the UI should surface that concern.

---

## Results tabs (selected run)

| Tab | Content |
|-----|--------|
| **Summary** | Return, win rate, profit factor, Sharpe, max drawdown, trade count, expectancy, avg hold, plus **gross / fees / funding / slippage / net** breakdown. |
| **Equity** | Equity curve from stored `backtest_equity_points`. |
| **Drawdown** | Drawdown series from the same points. |
| **Monthly heatmap** | PnL by month from closed trades. |
| **Trades** | Per-trade **gross**, **funding**, **net**, MAE/MFE, exit reason, gate action. |
| **Distributions** | PnL histogram and MAE vs MFE scatter. |
| **Gate ON/OFF** | For `approx` runs, spawn a **shadow** run with gate off to compare metrics side by side. |

**Promote to instance** (completed runs) opens a modal: destination mode, label, capital; the server enforces **promotion thresholds** (e.g. minimum trades, win rate, profit factor, max drawdown, Sharpe, non-zero taker fee) unless you explicitly override.

---

## Optimization tab

- Define a **parameter grid** (e.g. Supertrend `period` and `multiplier` ranges).
- The API creates a **`backtest_optimizations`** header and many **child runs**.
- The UI shows:
  - A **Sharpe heatmap** when two parameters are swept.
  - A table including **WF train → test** Sharpe when walk-forward was enabled on those runs (helps spot **overfit islands** vs **broad plateaus**).

---

## Compare tab

Pick up to **three finished** runs: table of key metrics plus **overlaid equity curves** (different colours).

---

## Data coverage & sync

- **Coverage** reads `ohlcv_candles` for the symbol/timeframe and optional date range; monthly cells show full vs partial vs weak coverage.
- **Sync** calls **`POST /api/backtest/data/sync`** to pull klines (spot or futures), funding (futures), Fear & Greed, and open interest into the historical tables used by the engine and gate replay.

CLI equivalent (from repo):

```bash
npm --workspace backend run backtest:sync -- --symbol BTCUSDT --tf 15m --from 2023-01-01
```

---

## Persistence (database)

Runs live in **`backtest_runs`** (status, metrics JSON, config snapshot, gate mode, walk-forward split, etc.).  
Trades in **`backtest_trades`**.  
Equity samples in **`backtest_equity_points`**.  
Optimization headers in **`backtest_optimizations`**.  
Historical macro series in **`historical_funding_rates`**, **`historical_fear_greed`**, **`historical_open_interest`**.

Schema is applied by migration **`026_backtesting_v2.sql`** (and earlier **`011_backtesting.sql`**).

---

## Limitations (be aware)

- **Approx gate** ≠ full live intelligence (no historical order book, options chain, or full liquidation replay).
- **One symbol per run**; portfolio-level backtests are out of scope for v1.
- **Coverage**: very sparse data produces unreliable stats; use coverage + sync first.
- **Promotion** is a workflow convenience; it does not guarantee future performance.

---

## Quick reference: main API routes

| Method | Path | Role |
|--------|------|------|
| POST | `/api/backtest/runs` | Create & queue run |
| GET | `/api/backtest/runs` | List runs |
| GET | `/api/backtest/runs/:id` | Run + metrics |
| GET | `/api/backtest/runs/:id/trades` | Paginated trades |
| GET | `/api/backtest/runs/:id/equity-curve` | Downsampled curve |
| POST | `/api/backtest/runs/:id/cancel` | Cancel |
| DELETE | `/api/backtest/runs/:id` | Delete run + related rows |
| GET | `/api/backtest/data/coverage` | Coverage + monthly |
| POST | `/api/backtest/data/sync` | Backfill historical data |
| POST | `/api/backtest/optimize` | Start sweep |
| GET | `/api/backtest/optimize/:id` | Sweep status + runs |
| POST | `/api/backtest/promote/:runId` | New version + instance |

All require an authenticated UI session (`requireDbUserSession`).

---

In short: the backtesting panel is your **sandbox for strategy versions**—measurable, persisted, and wired toward **optimization and promotion**—while calling out **where the model is approximate** so you can interpret results responsibly.
