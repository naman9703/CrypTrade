# REGIME_ADAPTIVE — Out-of-Sample Validation Report

**Verdict: REJECTED. Do not deploy live.**

The regime-adaptive strategy and every classic-TA baseline tested fail the
acceptance gates on out-of-sample data across multiple coins, timeframes, and
windows. This is the *correct* output of a trustworthy validation harness: it
refuses to greenlight a strategy that does not have a real edge.

## How it was tested

Harness: `scripts/backtest-validate-regime.mjs` (real `REGIME_ADAPTIVE`
adapter) + `scripts/backtest-validate-mc.mjs` (baselines).

Each run does: full-window backtest with realistic costs (taker fees +
0.05% slippage + funding) → Monte Carlo bootstrap on entry-risk-normalized
R-multiples → purged walk-forward (4 folds, 1-day embargo) → acceptance gates.

Acceptance gates (all must pass): OOS sum return > 0, Monte-Carlo 5th-pctile
return > 0, Calmar > 1, walk-forward expectancy degradation < 35%.

## Results

| Universe / window | Trades | Net | WR | Calmar | OOS | Gates |
|---|---|---|---|---|---|---|
| BTC 15m, Jan–May 2026 | 234 | −14.3% | 28–31%* | −1.81 | −14.4% | ❌ |
| ETH 15m, Jan–May 2026 | 213 | −13.7% | 28–33%* | −1.48 | −16.8% | ❌ |
| BTC 1h, May 2025–May 2026 | 204 | −12.0% | 27–29%* | −0.67 | +0.5% | ❌ |
| BTC 15m, **full** Jan 2025–Jun 2026 | **839** | **−78.0%** | **25–26%*** | −0.83 | −108.6% | ❌ |
| BTC 15m mean-reversion baseline, full | 299 | −57.3% | — | −0.78 | −63.5% | ❌ |

\* Per-position win rate by regime (the headline "WR ~52%" counts each TP1
partial leg as a separate win, which is misleading — the real per-trade hit
rate is the by-regime number).

## Root cause — this is a signal problem, not just a cost problem

With a 2R target and a 1R stop, a **random** entry hits +2R before −1R roughly
**33%** of the time. The trend-pullback playbook wins only **25–31%** — i.e.
its entries are *worse than random*. Buying pullbacks to EMA20 in a 15m crypto
"uptrend" systematically catches continuation-down moves. Costs then make a
slightly-negative edge decisively negative.

Supporting facts:
- Regime distribution on BTC 15m (49k bars): TREND_UP 39.8%, TREND_DOWN 38.1%,
  RANGE 11.0%, SQUEEZE 10.2%, VOLATILE_AVOID 0.9%. The router is sane; the
  playbooks routed-to are the problem.
- The mean-reversion baseline — Phase-1's "best relative performer" — is also
  net **−57%** over the full history. None of trend / mean-reversion / breakout
  has a positive raw edge on liquid crypto 15m after costs.
- Walk-forward fold 0 is often positive then later folds collapse → the only
  "good" stretches are luck in a specific window, not a stable edge.

## What IS trustworthy and reusable (built in Phases 1–6)

- `regimeEngine.js` — unified, hysteresis-stabilized regime classifier.
- `runner.js` risk overlay — vol-target sizing, `riskScale`, account-DD kill
  switch, consecutive-loss cooldown, weekly DD cap (all verified working).
- `metrics.js` — Calmar/CAGR/honest R-multiples (entry-risk based, immune to
  breakeven-trail inflation)/per-regime breakdown.
- `validation.js` — Monte Carlo + purged walk-forward + acceptance gates.
- Full config + UI wiring for `REGIME_ADAPTIVE`.

The validation harness is the asset here: it correctly **rejected** a
non-edge. Any future strategy can be run through the same gates.

## Why live-readiness is intentionally NOT done

Wiring a strategy with negative out-of-sample expectancy into live execution
would lose money. The kill-switch/cooldown/regime-standdown plumbing exists and
is tested, but it must wrap a strategy that first passes the gates.

## Where a real edge is more likely to live (evidence-based next steps)

The classic-TA-on-15m-close-prices space is efficient for the most liquid
coins. Edges that have survived costs in published/practitioner work generally
come from data the current pipeline does not yet exploit:

1. **Microstructure / order-flow on sub-minute data** (we have 1m back to mid-
   2025; 528k–535k bars per major coin): CVD divergence, aggressive-trade
   imbalance, liquidation-cascade fades. Trade *fewer*, higher-conviction
   setups to beat fees.
2. **Cross-sectional / relative-value** across the alt universe (XRP, ADA,
   DOGE, LINK, BNB) rather than single-asset directional TA.
3. **Funding / basis carry** and funding-extreme mean reversion (we already
   ingest funding rates).
4. **Maker-only execution** to flip the fee sign — at ~30% hit-rate, fees are
   the difference between −14% and roughly breakeven.
5. **Event/volatility regime filters** (only trade the 10% of the day with the
   real expected move), drastically cutting trade count and cost drag.

Recommendation: keep the validation harness as the gatekeeper, and aim the next
research cycle at (1) and (5) on 1m data, with maker execution.
