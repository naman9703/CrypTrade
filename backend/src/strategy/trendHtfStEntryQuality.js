/**
 * @deprecated Use trendHtfStRegime.js — re-exports for backward compatibility.
 */
import {
  evaluateTrendHtfStRegime,
  classifyTrendHtfStTradeOutcome,
  buildTrendHtfStRegimeOpts,
  shouldAllowTrendHtfStEntry,
  isTrendHtfStRegimeGateEnabled,
} from "./trendHtfStRegime.js";

export {
  evaluateTrendHtfStRegime as evaluateTrendHtfStEntryQuality,
  classifyTrendHtfStTradeOutcome as classifyTradeOutcome,
  buildTrendHtfStRegimeOpts as buildTrendHtfStChopFilterOpts,
  shouldAllowTrendHtfStEntry,
  isTrendHtfStRegimeGateEnabled,
};

export function shouldBlockTrendHtfStChopEntry(candles, signalIdx, direction, cfg = {}) {
  return !shouldAllowTrendHtfStEntry(candles, signalIdx, direction, {
    trendHtfStRegimeGate: true,
    ...cfg,
  });
}
