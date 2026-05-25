/**
 * SR_INTRADAY — re-exports Intraday Pro engine (multi-technique confluence).
 */

export {
  precomputeIntraday as precomputeSrIntraday,
  evaluateIntradayBar as evaluateSrIntradayBar,
  evaluateIntradayBar,
  selectIntradayPicks as selectDailyTopPicks,
  selectIntradayPicks,
  buildIntradayOptsFromCfg as buildSrIntradayOptsFromCfg,
  buildIntradayBacktestAdapter as buildSrIntradayBacktestAdapter,
  buildIntradayBacktestAdapter,
  mergeAdaptiveCfg,
  signal,
  SR_INTRADAY,
  INTRADAY_PRO,
} from "./intradayPro.js";

export {
  buildIntradayEntryContext,
  classifyTradeOutcome,
} from "./intradayEntryContext.js";
export {
  INTRADAY_VETO_RULES,
  applyIntradayVetoes,
  discoverVetoRules,
  isBigMoveCandidate,
} from "./intradayLearnedRules.js";

import { selectIntradayPicks } from "./intradayPro.js";

export function buildSrIntradaySignalSeries(candles, opts = {}) {
  return selectIntradayPicks(candles, opts).series;
}
