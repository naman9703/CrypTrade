/**
 * SITUATION_INTRADAY — data-driven multi-playbook situation router for BNB 15m.
 */

import { precomputeIntraday } from "./intradayPro.js";
import { utcDayId } from "./techniques/liquidity.js";
import { buildSituationSeries } from "./situation/situationEngine.js";
import { DaySituationTracker, resolveActiveSituations } from "./situation/daySituationRouter.js";
import { SituationDayState } from "./situation/situationState.js";
import { SITUATIONS } from "./situation/situationConstants.js";
import { loadRouteTable, isStandDown } from "./situation/routeTable.js";
import { strategyForSituation } from "./situation/strategyRegistry.js";
import { passesEntryFilters } from "./situation/entryFilters.js";
import { scanBreakdownBear } from "./situation/playbooks/breakdownBear.js";
import { scanBreakoutBull } from "./situation/playbooks/breakoutBull.js";
import { scanRangeBalance } from "./situation/playbooks/rangeBalance.js";
import { scanSqueezePlaybook } from "./situation/playbooks/squeezeBreak.js";
import { BNB_SITUATION_ROUTER_15M } from "./presets/bnbSituationRouter.js";

const WARMUP = 100;

/** Keys preserved from user/instance cfg; everything else comes from the situation preset. */
const SITUATION_USER_KEYS = [
  "symbol",
  "timeframe",
  "marketMode",
  "market",
  "futuresLeverage",
  "leverage",
  "futuresLeverageMode",
  "backtestPositionSizing",
  "riskPerTrade",
  "riskPerTradeUnit",
  "situationMaxTradesPerDay",
  "situationMinBarGap",
  "situationMinScore",
  "situationMaxLossStreak",
  "situationMaxExhaustionPerDay",
  "situationExhaustionMinBarsFromOpen",
  "situationPhaseLock",
  "situationRouteTable",
  "situationRouteTablePath",
  "situationMaxDayRangeAtEntry",
  "situationMaxAdx",
  "intradayLiqPartialTp",
  "intradayLiqTp1Enabled",
  "intradayLiqTp2Enabled",
  "intradayLiqBreakevenAfterPartial",
];

/** Strip SR_INTRADAY pollution — stale intraday gate keys break situation simulation. */
export function resolveSituationRouterCfg(cfg = {}) {
  const out = { ...BNB_SITUATION_ROUTER_15M };
  for (const k of SITUATION_USER_KEYS) {
    if (cfg[k] !== undefined) out[k] = cfg[k];
  }
  out.manualStrategy = "SITUATION_INTRADAY";
  out.strategyMode = cfg.strategyMode ?? "MANUAL";
  return out;
}

export const DEFAULT_SITUATION_OPTS = Object.freeze({
  maxTradesPerDay: 2,
  minBarGap: 4,
  minScore: 7,
  maxLossStreak: 2,
  maxDispDayRangePct: 0.03,
  maxExhaustionDayRangePct: 0.035,
  maxExhaustionPerDay: 2,
  exhaustionMinBarsFromOpen: 20,
  situationMaxDayRangeAtEntry: 0.04,
  situationMaxAdx: 70,
  partialR: 1.5,
  tp2R: 2.5,
});

function liqBracketsFromSetup(setup) {
  return {
    slPct: setup.slPct,
    tpPct: setup.tpPct,
    tp1Pct: setup.tp1Pct,
    slPrice: setup.slPrice,
    tpPrice: setup.tp2Price ?? setup.tpPrice,
    tp1Price: setup.tp1Price,
    tp2Price: setup.tp2Price ?? setup.tpPrice,
    tpMode: setup.tpMode,
    rr: setup.rr,
    partialTp: setup.partialTp !== false,
    tp2Enabled: setup.tp2Enabled !== false,
    partialFrac: setup.partialFrac ?? 0.5,
    liqQuality: setup.score ?? 0,
  };
}

function scanPlaybook(candles, idx, pre, dayState, situation, routeTable, scanOpts) {
  const enabled = routeTable.routes[situation] || [];
  if (!enabled.length) return [];

  if (situation === SITUATIONS.BREAKDOWN_BEAR) {
    return scanBreakdownBear(candles, idx, pre, dayState, scanOpts, enabled);
  }
  if (situation === SITUATIONS.BREAKOUT_BULL) {
    return scanBreakoutBull(candles, idx, pre, dayState, scanOpts, enabled);
  }
  if (situation === SITUATIONS.RANGE_ABOVE_PDL || situation === SITUATIONS.RANGE_BELOW_PDH) {
    return scanRangeBalance(candles, idx, pre, dayState, situation, scanOpts, enabled);
  }
  if (situation === SITUATIONS.SQUEEZE) {
    return scanSqueezePlaybook(candles, idx, pre, dayState, scanOpts, enabled);
  }
  return [];
}

function scanBarCandidates(candles, idx, pre, situationInfo, dayState, dayTracker, routeTable, opts) {
  const barSituation = situationInfo.situation;
  if (isStandDown(barSituation)) return [];

  const scanOpts = { ...opts, ...routeTable.thresholds };
  const bar = candles[idx];
  dayState.updateBias(candles, idx, pre, bar, scanOpts);

  const activeSituations = resolveActiveSituations(
    candles,
    idx,
    pre,
    barSituation,
    dayTracker,
    routeTable,
    opts,
    dayState,
  );
  const seen = new Set();
  let candidates = [];

  for (const situation of activeSituations) {
    if (isStandDown(situation)) continue;
    for (const c of scanPlaybook(candles, idx, pre, dayState, situation, routeTable, scanOpts)) {
      const key = `${c.trigger}|${c.side}|${c.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const strat = strategyForSituation(situation);
      candidates.push({ ...c, strategy: strat.id, strategyLabel: strat.label });
    }
  }

  return candidates.filter((c) => {
    const trigger = c.trigger;
    if (c.side === "SELL" && !dayState.canShort(trigger, idx, scanOpts)) return false;
    if (c.side === "BUY" && !dayState.canLong(trigger, idx, scanOpts)) return false;
    if ((c.score ?? 0) < opts.minScore) return false;
    if (!passesEntryFilters(candles, idx, pre, dayState, c, c.situation, { ...opts, ...scanOpts })) return false;
    return true;
  });
}

export function buildSituationIntradaySeries(candles, cfg = {}) {
  const opts = optsFromCfg(resolveSituationRouterCfg(cfg));
  const pre = precomputeIntraday(candles);
  const routeTable = opts.routeTable || loadRouteTable(opts.routeTablePath);
  const { series: situationSeries } = buildSituationSeries(candles, pre, opts);
  const n = candles.length;
  const rawSeries = new Array(n).fill(null);
  const situationLabels = new Array(n);

  const byDay = new Map();
  const dayStates = new Map();
  const dayTrackers = new Map();

  for (let i = WARMUP; i < n; i++) {
    const bar = candles[i];
    const day = utcDayId(bar.ts);
    const barSituation = situationSeries[i]?.situation || SITUATIONS.CHOP_NEUTRAL;
    situationLabels[i] = barSituation;

    if (!dayStates.has(day)) dayStates.set(day, new SituationDayState(opts));
    if (!dayTrackers.has(day)) dayTrackers.set(day, new DaySituationTracker());
    const dayState = dayStates.get(day);
    const dayTracker = dayTrackers.get(day);
    dayTracker.ensureDay(day);
    dayTracker.update(barSituation, i, candles, pre, opts);
    dayState.ensureDay(bar, i);

    const cands = scanBarCandidates(candles, i, pre, situationSeries[i], dayState, dayTracker, routeTable, opts);
    for (const c of cands) {
      const list = byDay.get(day) || [];
      list.push({
        idx: i,
        day,
        score: c.score + (situationSeries[i]?.confidence ?? 0) * 3,
        sig: {
          action: c.action,
          reason: `sit_${c.situation}_${c.trigger}`,
          situation: c.situation,
          playbook: c.playbook,
          trigger: c.trigger,
          strategy: c.strategy,
          strategyLabel: c.strategyLabel,
          score: c.score,
          liqBrackets: liqBracketsFromSetup(c),
        },
      });
      byDay.set(day, list);
    }
  }

  for (const [, list] of byDay) {
    list.sort((a, b) => b.score - a.score);
    const bySituation = new Map();
    for (const c of list) {
      const sit = c.sig.situation;
      const arr = bySituation.get(sit) || [];
      arr.push(c);
      bySituation.set(sit, arr);
    }

    let pool;
    if (bySituation.size <= 1) {
      pool = list;
    } else {
      pool = [...bySituation.values()].map((arr) => arr[0]).sort((a, b) => b.score - a.score);
    }

    const chosen = [];
    for (const c of pool) {
      if (chosen.length >= opts.maxTradesPerDay) break;
      if (chosen.some((x) => Math.abs(x.idx - c.idx) < opts.minBarGap)) continue;
      chosen.push(c);
    }
    for (const c of chosen) rawSeries[c.idx] = c.sig;
  }

  return { series: rawSeries, situationLabels, routeTable };
}

export function buildSituationIntradayBacktestAdapter(candles, cfg = {}, _tf = "15m") {
  const resolved = resolveSituationRouterCfg(cfg);
  const opts = optsFromCfg(resolved);
  const { series } = buildSituationIntradaySeries(candles, resolved);
  let lastSignalIdx = -Infinity;
  let tradesToday = 0;
  let curDay = null;

  return function situationIntradayAdapter(bar, idx) {
    const day = utcDayId(bar.ts);
    if (day !== curDay) {
      curDay = day;
      tradesToday = 0;
    }
    const sig = series[idx];
    if (!sig) return null;
    if (tradesToday >= opts.maxTradesPerDay) return null;
    if (idx - lastSignalIdx < opts.minBarGap) return null;

    lastSignalIdx = idx;
    tradesToday += 1;
    return {
      action: sig.action,
      reason: sig.reason,
      liqBrackets: sig.liqBrackets,
      situation: sig.situation,
      playbook: sig.playbook,
      trigger: sig.trigger,
      strategy: sig.strategy,
      strategyLabel: sig.strategyLabel,
    };
  };
}

export function optsFromCfg(cfg = {}) {
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  const o = { ...DEFAULT_SITUATION_OPTS };
  o.maxTradesPerDay = num(cfg.situationMaxTradesPerDay, o.maxTradesPerDay);
  o.minBarGap = num(cfg.situationMinBarGap, o.minBarGap);
  o.minScore = num(cfg.situationMinScore, o.minScore);
  o.maxLossStreak = num(cfg.situationMaxLossStreak, o.maxLossStreak);
  o.maxDispDayRangePct = num(cfg.situationMaxDispDayRangePct, o.maxDispDayRangePct);
  o.maxExhaustionDayRangePct = num(cfg.situationMaxExhaustionDayRangePct, o.maxExhaustionDayRangePct);
  o.maxExhaustionPerDay = num(cfg.situationMaxExhaustionPerDay, o.maxExhaustionPerDay);
  o.exhaustionMinBarsFromOpen = num(cfg.situationExhaustionMinBarsFromOpen, o.exhaustionMinBarsFromOpen);
  o.situationMaxDayRangeAtEntry = num(cfg.situationMaxDayRangeAtEntry, o.situationMaxDayRangeAtEntry);
  o.situationMaxAdx = num(cfg.situationMaxAdx, o.situationMaxAdx);
  o.phaseLock = cfg.situationPhaseLock !== false;
  if (cfg.situationRouteTable) {
    try {
      o.embeddedRouteTable =
        typeof cfg.situationRouteTable === "string" ? JSON.parse(cfg.situationRouteTable) : cfg.situationRouteTable;
    } catch {
      o.embeddedRouteTable = null;
    }
  }
  if (cfg.situationRouteTablePath) o.routeTablePath = String(cfg.situationRouteTablePath);
  // Always load route table from disk when a path is set (avoids stale embedded snapshots).
  if (o.embeddedRouteTable) {
    o.routeTable = {
      routes: o.embeddedRouteTable.routes || {},
      strategies: o.embeddedRouteTable.strategies || {},
      thresholds: o.embeddedRouteTable.thresholds || {},
      meta: o.embeddedRouteTable.meta || {},
    };
  } else if (o.routeTablePath) {
    o.routeTable = loadRouteTable(o.routeTablePath);
  } else {
    o.routeTable = loadRouteTable();
  }
  return o;
}

export function signal({ candles, cfg } = {}) {
  if (!candles?.length) return { action: "HOLD", reason: "no_candles" };
  const { series, situationLabels } = buildSituationIntradaySeries(candles, resolveSituationRouterCfg(cfg || {}));
  const idx = candles.length - 1;
  const sig = series[idx];
  if (!sig) {
    return { action: "HOLD", reason: "sit_no_setup", situation: situationLabels[idx] };
  }
  return {
    action: sig.action,
    reason: sig.reason,
    situation: sig.situation,
    playbook: sig.playbook,
    trigger: sig.trigger,
    strategy: sig.strategy,
    strategyLabel: sig.strategyLabel,
    brackets: sig.liqBrackets,
  };
}

export { strategyForSituation, listRoutableStrategies } from "./situation/strategyRegistry.js";

export const SITUATION_INTRADAY = {
  name: "Situation Router — multi-strategy intraday (BNB 15m)",
  signal,
};
