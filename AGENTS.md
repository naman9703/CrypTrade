---
description: 
alwaysApply: true
---

# AGENTS.md

Crypto trading bot (backend Node/Express + Timescale, frontend React/Vite).

## Active work: trading-strategy research

**Read `@STRATEGY_RESEARCH_HANDOFF.md` and `docs/STRATEGY_OPTIMIZATION_RULEBOOK.md`
before doing any strategy work.**

**Aim:** maximize **validated** returns (OOS CAGR / Calmar / portfolio return) **and
deployable frequency** (~≥2 trades/week/coin target) — not random experiments,
in-sample curve fitting, or “profit” on a handful of trades/year. If targets are
missed, iterate (autopsy → hypothesis → re-test); do not satisfy goals by crushing
trade count. Hypothesis → one change → full sim → holdout → WF + MC + gates. See
the rulebook for banned patterns and decision log.

Summary:

- **No strategy is currently certified deployable.** Prior `SUPERTREND_ELITE`
  “only validated / ~10–21% CAGR” claims are **revoked** (wrong trailing). Honesty
  re-val under locked trail (2026-07-14): **REJECT** — see
  `2026-07-14-elite-st-honesty-reval-reject.md`. Next: Phase 2 disaster-SL
  hypothesis (`2026-07-14-phase2-hypothesis-after-st-reject.md`). Do not cite
  ST Elite as the default answer.
- **50%/month is not real** — do not chase it or present overfit/short-window
  numbers as if repeatable. Be honest about costs (fees+slippage) and out-of-sample
  results. Always validate with walk-forward + Monte Carlo + acceptance gates.
- Context filters / informational data are **research-only** until full sim shows
  positive OOS **and** passes gates — not “promising” from harvest abstention alone.
- **Funding-rate arb CLOSED NO-GO** on BTC/ETH (Phase 2a/2b: fees > funding even
  after anti-churn). Do **not** tweak thresholds again. Reopen only for extreme
  ≥50%+ episodes, more symbols, or real spot+basis (not perp-as-spot). See
  `2026-07-14-funding-arb-phase2b-nogo.md`. LIQ SWEEP_RECLAIM remains on hold.

## Infra gotchas

- DB is Docker TimescaleDB on `localhost:54333`. `ECONNREFUSED`? → `open -a Docker`,
  wait for daemon, `docker compose up -d` from repo root. Data persists in the
  `trading_trading-data` volume.
- Backtest scripts live in `backend/scripts/`, run from `backend/` (they load `../.env`).
- Run one heavy backtest at a time; the sandbox can't kill runaway processes, and
  full 49k-bar history is slow — prefer the 2026 window for quick iteration.
- **Multi-year portfolio backtests:** candle reads/backfills are sliced in 90-day
  windows to avoid Timescale `out of shared memory`. If you still see that error,
  recreate the DB container so `docker-compose.db.yml` Postgres tuning applies:
  `docker compose -f docker-compose.db.yml up -d --force-recreate`

## Conventions

- **Trading vocabulary:** `docs/TRADING_GLOSSARY.md` — terms, definitions, and use cases for strategy design.
- **Safe intraday:** `docs/SAFE_INTRADAY_SETUP.md` — research target (~1%/month), not a certified live deploy.
- Use specialized file tools, not shell `cat`/`sed`. Verify backtests with realistic
  costs. Never deploy a strategy live until it passes the validation gates **with
  correct trailing/exits**.
