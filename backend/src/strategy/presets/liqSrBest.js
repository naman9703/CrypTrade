/**
 * LIQ + S/R (institutional A+) — BEST tuning from the Jan-2025→Jun-2026 sweep.
 *
 * Winner of scripts/backtest-liqsr-tune.mjs (robustness-weighted) after the
 * liquidity correctness fixes: the A+ stack (HTF zone + liquidity sweep + BOS +
 * confirmation candle + volume) with the volume gate raised to 1.3x. Across
 * BTC/ETH/BNB @ 1.5% risk it was 3/3 coins non-negative on Jan-2025→Jun-2026
 * (mean ~+3.8%, BTC +6.7% / ETH +0.0% / BNB +4.8%), PF 1.0–2.2, maxDD 2–8%.
 *
 * Validation rejected it for deployment: Monte Carlo p5 stayed negative on all
 * three coins, and BTC/ETH walk-forward OOS was not positive. Treat this as a
 * research candidate, not a live-approved strategy.
 *
 * Removing BOS or the confirmation candle turns it negative — the confluence is
 * load-bearing, not decoration. Loosening the sweep (ext<0.4%) or over-trading
 * also kills it (costs). Keep it selective.
 */
import { INTRADAY_PRO_SR_APLUS_15M } from "./srIntradayOptimized.js";

export const LIQSR_BEST_15M = {
  ...INTRADAY_PRO_SR_APLUS_15M,
  marketMode: "FUTURES",
  slippagePct: 0.0005,
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: 1.5,
  riskPerTradeUnit: "PCT",
  // The single knob that improved both return and cross-coin robustness in the corrected sweep.
  intradaySrMinVolRatio: 1.3,
};

export const LIQSR_BEST_BNB_15M = { ...LIQSR_BEST_15M, symbol: "BNBUSDT" };
export const LIQSR_BEST_BTC_15M = { ...LIQSR_BEST_15M, symbol: "BTCUSDT" };
export const LIQSR_BEST_ETH_15M = { ...LIQSR_BEST_15M, symbol: "ETHUSDT" };
