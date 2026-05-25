/**
 * BTC_CONSENSUS — multi-strategy vote for BTC trend legs.
 * Requires `minAgree` of `keys` to fire the same direction (reduces chop entries).
 */

import { buildBaselineAdapters } from "./baselines.js";
import { buildHtfRsiBacktestAdapter } from "../../../strategy/htfRsi.js";
import { buildTrendHtfStBacktestAdapter } from "../../../strategy/trendHtfSt.js";
import { buildHtfLegRiderBacktestAdapter } from "../../../strategy/htfLegRider.js";

const DEFAULT_KEYS = ["TREND_HTF_ST", "HTF_LEG_RIDER", "MOMENTUM_SURGE"];
const DEFAULT_MIN_AGREE = 2;

/**
 * @param {object} opts
 * @param {Array} opts.candles
 * @param {string} [opts.tf]
 * @param {object} [opts.cfg]
 * @param {string[]} [opts.keys]
 * @param {number} [opts.minAgree]
 */
export function buildBtcConsensusAdapter(candles, opts = {}) {
  const tf = opts.tf ?? "15m";
  const cfg = opts.cfg ?? {};
  const keys = opts.keys ?? DEFAULT_KEYS;
  const minAgree = Math.max(1, opts.minAgree ?? DEFAULT_MIN_AGREE);

  const base = buildBaselineAdapters();
  if (keys.includes("HTF_RSI")) base.HTF_RSI = buildHtfRsiBacktestAdapter(candles, tf);
  if (keys.includes("TREND_HTF_ST")) {
    base.TREND_HTF_ST = buildTrendHtfStBacktestAdapter(candles, {
      period: Number(cfg.supertrendPeriod ?? 10),
      multiplier: Number(cfg.supertrendMultiplier ?? 3),
    });
  }
  if (keys.includes("HTF_LEG_RIDER")) {
    base.HTF_LEG_RIDER = buildHtfLegRiderBacktestAdapter(candles, {
      lookback: Number(cfg.htfLegRiderLookback ?? 32),
    });
  }

  let lastDir = 0;
  const warmup = 80;

  return function btcConsensusAdapter(bar, idx, ctx) {
    if (idx < warmup) return null;
    let buys = 0;
    let sells = 0;
    for (const k of keys) {
      const sub = base[k];
      if (!sub) continue;
      const sig = sub(bar, idx, ctx);
      if (!sig) continue;
      if (sig.action === "BUY") buys++;
      else if (sig.action === "SELL") sells++;
    }
    if (buys >= minAgree && lastDir !== 1) {
      lastDir = 1;
      return { action: "BUY", reason: `btc_consensus_${buys}` };
    }
    if (sells >= minAgree && lastDir !== -1) {
      lastDir = -1;
      return { action: "SELL", reason: `btc_consensus_${sells}` };
    }
    return null;
  };
}
