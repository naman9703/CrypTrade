/**
 * LIQ + S/R (institutional A+) — BEST tuning from the Jan-2025→Jun-2026 sweep.
 *
 * Winner of scripts/backtest-liqsr-tune.mjs (robustness-weighted): the A+ stack
 * (HTF zone + liquidity sweep + BOS + confirmation candle + volume) with min R:R
 * raised to 2.5. Across BTC/ETH/BNB @ 1.5% risk it was 3/3 coins positive
 * (mean ~+6.6%, BTC +3.5% / ETH +6.2% / BNB +10.2%), PF 1.1–1.9, maxDD 4–9%.
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
  // The single knob that improved both return and robustness in the sweep.
  intradayLiqMinRr: 2.5,
};

export const LIQSR_BEST_BNB_15M = { ...LIQSR_BEST_15M, symbol: "BNBUSDT" };
export const LIQSR_BEST_BTC_15M = { ...LIQSR_BEST_15M, symbol: "BTCUSDT" };
export const LIQSR_BEST_ETH_15M = { ...LIQSR_BEST_15M, symbol: "ETHUSDT" };
