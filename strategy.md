# Strategy Reference — Every Registered Strategy

> Context for all trading strategies in this codebase. Registry:
> `backend/src/strategy/strategies.js`. Backtest adapters wired in
> `backend/src/backtest/engine/signals/baselines.js`.
> Companion docs: `STRATEGY_RESEARCH_HANDOFF.md` (research verdict), `AGENTS.md`.
> Last updated: 2026-06-03.

## How to read the "Status"

Backtests below use realistic costs (taker fees + 0.05% slippage + funding),
`RISK_AT_SL` sizing. Validation = walk-forward (purged, embargo) + Monte Carlo +
acceptance gates (OOS>0, MC p5>0, Calmar>1, WF degradation<35%).

**No strategy is currently certified deployable.** Prior “only SUPERTREND_ELITE
passes OOS” claims are **revoked** (wrong trailing in those runs). See
`STRATEGY_RESEARCH_HANDOFF.md` and
`backend/scripts/.research-decisions/2026-07-14-supertrend-elite-deployability-revoked.md`.
Many high-frequency baselines are still net-negative OOS after costs.

## Headline comparison (ETH+BNB 15m, Jan–Jun 2026, 2% risk, 25× — normalized)

| strategy | mean net% | trades | verdict |
|---|---|---|---|
| SUPERTREND_ELITE | +3.3 | 10 | **stale** — re-validate with correct trail before any deploy claim |
| TREND_PULLBACK | −5.2 | 19 | negative |
| HTF_RSI | −15.1 | 57 | negative (UI's 125% claim is overfit) |
| SMART_REVERSAL | −21.2 | 233 | negative |
| RSI_MEAN | −48.1 | 204 | negative |
| MOMENTUM_SURGE | −65.4 | 328 | negative (fee bleed) |
| BREAKOUT_VOL | −95.3 | 1044 | catastrophic (fee bleed) |
| EMA_CROSS | −97.3 | 992 | catastrophic (fee bleed) |

Key lesson: **trade frequency is inversely correlated with survival** — high-frequency
TA strategies are destroyed by fees; selectivity alone is not proof of a deployable edge.

---

## Simple / baseline strategies (inline in `strategies.js`)

### SUPERTREND
- **Name:** Supertrend (spot — trades on candle close via WebSocket).
- **Logic:** Event-driven Supertrend flip on spot; `signal()` is a placeholder
  (`HOLD`), real logic is the live WebSocket path / `SUPERTREND_ELITE` for backtest.
- **Status:** Not a standalone backtest strategy (use `SUPERTREND_ELITE`).

### CONFLUENCE
- **Name:** Multi-Indicator Confluence (scored 0–100).
- **Logic:** Weighted score from trend (EMA), momentum (RSI), volume spike, MACD
  histogram, Bollinger position + multi-TF (5m/15m) alignment bonus. Fires when
  score ≥ `MIN_SIGNAL_SCORE` (default 65).
- **Config:** `MIN_SIGNAL_SCORE` env.
- **Status:** Not separately validated; composite of weak components.

### EMA_CROSS
- **Name:** Trend Following (EMA 12/26).
- **Logic:** BUY when fast EMA > slow EMA, SELL when below. Pure crossover.
- **Status:** **−97%** — over-trades, pure fee bleed. Do not use.

### RSI_MEAN
- **Name:** Mean Reversion (RSI 14).
- **Logic:** BUY RSI ≤ 30, SELL RSI ≥ 70.
- **Status:** **−48%** — no edge after costs.

### BREAKOUT_VOL
- **Name:** Breakout (Volume spike + range).
- **Logic:** On volume spike ≥ 1.5×, BUY if close > prev high, SELL if close < prev low.
- **Status:** **−95%** — over-trades, fee bleed.

### MOMENTUM_SURGE
- **Name:** Momentum Surge (multi-signal confirmation).
- **Logic:** Trend (EMA) + RSI band + volume>1.3× + MACD sign + Bollinger position
  must align for BUY/SELL.
- **Status:** **−65%** — no edge after costs.

### ENSEMBLE
- **Name:** Ensemble (2+ signals must agree).
- **Logic:** Polls EMA_CROSS, RSI_MEAN, BREAKOUT_VOL, MOMENTUM_SURGE; trades when ≥2 agree.
- **Status:** Inherits weak components; can be O(n²) / slow on long histories. Not recommended.

### BTC_CONSENSUS
- **Name:** BTC trend consensus (2+ of Trend+ST / Leg Rider / Momentum).
- **Logic:** Polls TREND_HTF_ST, HTF_LEG_RIDER, MOMENTUM_SURGE; trades when ≥2 agree.
- **Status:** Not separately validated; BTC-only consensus wrapper.

---

## Advanced / dedicated strategies (own modules)

### SUPERTREND_ELITE (research candidate — not certified)
- **File:** `supertrendElite.js`. **Name:** Supertrend Elite (5-gate: ADX+Vol+1H+4H+ATR).
- **Logic:** Supertrend flip entry that must pass 5 gates: (1) ADX strength + rising,
  (2) volume ≥ 1.5× avg, (3) 1H EMA21/50 structural alignment, (4) 4H Supertrend
  direction, (5) ATR expansion. Optional liquidity-sweep bonus. Exit intended as
  trailing Supertrend / exit-on-flip — **must match live trailing for any re-validation**.
- **Config:** `supertrendPeriod` (10), `supertrendMultiplier` (2.5–3.5),
  `eliteStMinAdx` (20–25), `eliteStRequireAdxRising`, `eliteStMinVolumeVsAvg` (1.5),
  `eliteStRequireHtf1hEmaAlign`, `eliteStRequireHtf4hAlign`, `eliteStRequireAtrExpansion`,
  `trailingStopLossAuto: true`, `futuresTrailingStopMode: SUPERTREND`,
  `supertrendFuturesExitOnFlip: true`.
- **Status:** **NOT CERTIFIED.** Older “VALIDATED / ~10–21% CAGR” tables used **wrong
  trailing** and are revoked (2026-07-14). Re-run portfolio + WF + MC + gates with
  correct exits before any deploy language. Script: `backtest-portfolio-supertrend.mjs`.

### HTF_RSI
- **File:** `htfRsi.js`. **Name:** HTF-Filtered RSI Mean Reversion (1h trend + 15m RSI exhaustion).
- **Logic:** Trade 15m RSI exhaustion only in the direction of the 1H trend.
- **Config:** SL/TP fixed pct, HTF trend separation threshold.
- **Status:** **−15% to −18%.** The UI's claimed ~125% is overfit and does NOT hold.

### TREND_PULLBACK
- **File:** `trendPullback.js`. **Name:** Trend-Pullback Scalper (HTF trend + RSI oversold bounce).
- **Logic:** Buy pullbacks (RSI oversold bounce) in an HTF uptrend; mirror for shorts.
- **Status:** **−5%.** Best of the negatives but still no edge; pullback-continuation
  on 15m crypto is below random hit-rate.

### SMART_REVERSAL
- **File:** `smartReversal.js`. **Name:** Smart Reversal (Liquidity Sweep + HTF Trend + RSI Exhaustion).
- **Logic:** Fade liquidity sweeps with HTF-trend + RSI-exhaustion confirmation.
- **Status:** **−21%** over ~233 trades; no edge after costs.

### TREND_HTF_ST
- **File:** `trendHtfSt.js`. **Name:** HTF Trend + Supertrend (regime-gated).
- **Logic:** Supertrend entries gated by higher-TF trend + regime filter.
- **Config:** `supertrendPeriod`, `supertrendMultiplier`, quality opts.
- **Status:** Not separately validated (HTF aggregation can be slow on full history).

### ELITE_HTF
- **File:** `eliteHtf.js`. **Name:** ELITE HTF (RSI pullback + regime gate).
- **Logic:** RSI pullback entries with an HTF regime gate.
- **Status:** Not separately validated.

### HTF_LEG_RIDER
- **File:** `htfLegRider.js`. **Name:** HTF trend + range breakout (ride large legs).
- **Logic:** Enter on range breakouts aligned with the HTF trend to ride large legs.
- **Config:** `htfLegRiderLookback` (32).
- **Status:** Not separately validated.

### APEX_TREND
- **File:** `apexTrend.js`. **Name:** Apex Trend v2 (3-TF + ST flip + strict RSI pullback zone).
- **Logic:** Supertrend flip + 3-timeframe alignment + strict RSI pullback-zone entry.
- **Config:** `apexAdxMin` (22), `apexHtf1hSep`, `apexHtf4hSep`, `apexFlipOnly`.
- **Status:** Not separately validated.

### SURF_PULSE_ML
- **File:** `surfPulseMl.js`. **Name:** SurfPulse ML (trend + pullback + XGBoost gate).
- **Logic:** Trend + pullback rules gated by an XGBoost model (live HTTP). Backtest uses
  rules-only unless `surfPulseMlGateEnabled`.
- **Status:** Not validated here (requires ML service).

### SR_INTRADAY / INTRADAY_PRO
- **File:** `intradayPro.js`. **Names:** "SR Intraday Pro — multi-technique confluence",
  "Intraday Pro — sweep + fib + VP + order flow + session S/R".
- **Logic:** Multi-technique confluence: liquidity sweeps, Fibonacci, volume profile,
  **order flow** (delta/CVD/absorption at key levels), session S/R, killzones.
- **Config:** large `intradayOf*` / `intraday*` set (see `intradayPanelKeys.js`).
- **Status:** Over-gated — on REAL taker data the order-flow solo path fired 0–6 trades
  and lost. Note: order flow needs real `taker_buy_volume` (backfilled for BTC/ETH 15m only).

### VOLUME_PROFILE
- **File:** `volumeProfileStrategy.js`. **Name:** Volume Profile — POC / VAH / VAL / HVN / LVN structure.
- **Logic:** Structure setups around volume-profile levels (POC, value-area high/low, HVN/LVN).
- **Status:** Slow per-bar (rebuilds VP each bar); not separately validated.

### REGIME_ADAPTIVE
- **File:** `regimeAdaptive.js`. **Name:** Regime-Adaptive — one playbook per market regime.
- **Logic:** Unified regime engine (TREND_UP/DOWN, RANGE, SQUEEZE, VOLATILE_AVOID) routes
  to one playbook: trend-pullback / mean-reversion / breakout / stand-down. A/B grade,
  killzones, 2–3 trades/day, structure brackets + partial TP. Has a UI control panel.
- **Config:** `regimeAdaptive*` keys (grade, confidence floor, max trades/day, RR, etc.)
  + risk overlay (`riskScale`, `volTargetSizing`, kill switch, cooldown, weekly cap).
- **Status:** **REJECTED.** Negative OOS; trend entries below random hit-rate.
  See `REGIME_ADAPTIVE_VALIDATION.md`.

---

## AUTO mode
Not a strategy — mirrors live `strategyMode: AUTO`: detect regime → pick a strategy →
use that path's signal. Adapter in `baselines.js` (`buildAutoAdapter`).

## Risk overlay (applies to any strategy, in `runner.js` + `bot.js`)
`riskScale` (aggressiveness dial), `volTargetSizing` (constant risk across regimes),
`riskKillSwitchDdPct` (account-DD halt), `riskConsecutiveLossLimit` (cooldown),
`riskWeeklyMaxLossPct` (weekly DD cap). Built + tested; not yet wired into live execution.
