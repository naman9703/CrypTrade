# AGENTS.md

Crypto trading bot (backend Node/Express + Timescale, frontend React/Vite).

## Active work: trading-strategy research

**Read `@STRATEGY_RESEARCH_HANDOFF.md` before doing any strategy work.** It has the
full context, validated results, scripts, configs, and data/infra state. Summary:

- Rigorously tested all 18 strategies. **`SUPERTREND_ELITE` is the only one that
  passes out-of-sample validation.** Realistic return: **~10–21% CAGR (~1–1.5%/mo)**
  at moderate risk, 15–30% drawdowns. Deploy it as a **multi-coin portfolio**.
- **50%/month is not real** — do not chase it or present overfit/short-window
  numbers as if repeatable. Be honest about costs (fees+slippage) and out-of-sample
  results. Always validate with walk-forward + Monte Carlo + acceptance gates.

## Infra gotchas

- DB is Docker TimescaleDB on `localhost:54333`. `ECONNREFUSED`? → `open -a Docker`,
  wait for daemon, `docker compose up -d` from repo root. Data persists in the
  `trading_trading-data` volume.
- Backtest scripts live in `backend/scripts/`, run from `backend/` (they load `../.env`).
- Run one heavy backtest at a time; the sandbox can't kill runaway processes, and
  full 49k-bar history is slow — prefer the 2026 window for quick iteration.

## Conventions

- **Trading vocabulary:** `docs/TRADING_GLOSSARY.md` — terms, definitions, and use cases for strategy design.
- **Safe intraday deploy:** `docs/SAFE_INTRADAY_SETUP.md` — `SAFE_INTRADAY` strategy (~1%/month target, not 1%/day).
- Use specialized file tools, not shell `cat`/`sed`. Verify backtests with realistic
  costs. Never deploy a strategy live until it passes the validation gates.
