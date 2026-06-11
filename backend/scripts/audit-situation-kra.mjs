#!/usr/bin/env node
/**
 * KRA audit — did each market situation route to its sub-strategy when required?
 * Usage: node scripts/audit-situation-kra.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-05";
const RISK = Number(process.env.RISK || 2);

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { buildSituationSeries } = await import("../src/strategy/situation/situationEngine.js");
const { DaySituationTracker, resolveActiveSituations } = await import("../src/strategy/situation/daySituationRouter.js");
const { SituationDayState } = await import("../src/strategy/situation/situationState.js");
const { SITUATIONS } = await import("../src/strategy/situation/situationConstants.js");
const { loadRouteTable } = await import("../src/strategy/situation/routeTable.js");
const { strategyForSituation, listRoutableStrategies } = await import("../src/strategy/situation/strategyRegistry.js");
const { passesEntryFilters } = await import("../src/strategy/situation/entryFilters.js");
const { scanBreakdownBear } = await import("../src/strategy/situation/playbooks/breakdownBear.js");
const { scanRangeBalance } = await import("../src/strategy/situation/playbooks/rangeBalance.js");
const { scanSqueezePlaybook } = await import("../src/strategy/situation/playbooks/squeezeBreak.js");
const { buildSituationIntradayBacktestAdapter, optsFromCfg, resolveSituationRouterCfg } = await import(
  "../src/strategy/situationIntraday.js"
);
const { BNB_SITUATION_ROUTER_15M } = await import("../src/strategy/presets/bnbSituationRouter.js");
const { utcDayId } = await import("../src/strategy/techniques/liquidity.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const candles = await readCandles(SYMBOL, TF, fromMs, toMs, { market: "futures" });
const pre = precomputeIntraday(candles);
const WARMUP = 100;

const KRA_ROUTES = {
  BREAKDOWN_BEAR: ["exhaustion_long"],
  RANGE_ABOVE_PDL: ["displacement_short"],
  RANGE_BELOW_PDH: ["retest_short"],
  SQUEEZE: ["lh_fade_long"],
  BREAKOUT_BULL: [],
  VOLATILE_AVOID: [],
  CHOP_NEUTRAL: [],
};

function scanPlaybook(candles, idx, pre, dayState, situation, routeTable, scanOpts) {
  const enabled = routeTable.routes[situation] || [];
  if (!enabled.length) return [];
  if (situation === SITUATIONS.BREAKDOWN_BEAR) return scanBreakdownBear(candles, idx, pre, dayState, scanOpts, enabled);
  if (situation === SITUATIONS.RANGE_ABOVE_PDL || situation === SITUATIONS.RANGE_BELOW_PDH) {
    return scanRangeBalance(candles, idx, pre, dayState, situation, scanOpts, enabled);
  }
  if (situation === SITUATIONS.SQUEEZE) return scanSqueezePlaybook(candles, idx, pre, dayState, scanOpts, enabled);
  return [];
}

async function runBacktest(routeTable, label) {
  const cfg = {
    ...BNB_SITUATION_ROUTER_15M,
    symbol: SYMBOL,
    timeframe: TF,
    riskPerTrade: RISK,
    situationRouteTable: JSON.stringify({ ...routeTable, routes: routeTable.routes }),
  };
  delete cfg.situationRouteTablePath;
  const adapter = buildSituationIntradayBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    candles,
    strategyKey: "SITUATION_INTRADAY",
    cfg: { ...cfg, symbol: SYMBOL },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    adapters: { SITUATION_INTRADAY: adapter },
    symbol: SYMBOL,
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: 100 });
  const entries = new Map();
  for (const t of sim.trades.filter((tr) => tr.entryTs >= fromMs && tr.entryTs < toMs)) {
    const k = `${t.entryTs}_${t.direction}`;
    if (!entries.has(k)) {
      entries.set(k, {
        ts: t.entryTs,
        situation: t.situation || "?",
        trigger: t.trigger || "?",
        strategy: t.strategy || strategyForSituation(t.situation).id,
        net: 0,
      });
    }
    entries.get(k).net += Number(t.netPnl);
  }
  return { label, ret: m.totalReturnPct, trades: [...entries.values()], n: entries.size, wr: m.winRate };
}

function auditRouting(routeTable, opts) {
  const { series: situationSeries } = buildSituationSeries(candles, pre, opts);
  const dayStates = new Map();
  const dayTrackers = new Map();

  const phaseBars = { pre_structure: 0, breakdown: 0, breakout: 0 };
  const activeSitCounts = {};
  const rawCandidates = [];
  const filteredOut = { noRoute: 0, canTrade: 0, minScore: 0, entryFilter: 0, noSignal: 0 };

  for (let i = WARMUP; i < candles.length; i++) {
    if (candles[i].ts < fromMs || candles[i].ts >= toMs) continue;
    const bar = candles[i];
    const day = utcDayId(bar.ts);
    const barSit = situationSeries[i]?.situation || SITUATIONS.CHOP_NEUTRAL;

    if (!dayStates.has(day)) dayStates.set(day, new SituationDayState(opts));
    if (!dayTrackers.has(day)) dayTrackers.set(day, new DaySituationTracker());
    const dayState = dayStates.get(day);
    const dayTracker = dayTrackers.get(day);
    dayTracker.ensureDay(day);
    dayTracker.update(barSit, i, candles, pre, opts);
    dayState.ensureDay(bar, i);

    const tracker = dayTracker;
    const breakdown = tracker.breakdownLocked(candles, i, pre, opts);
    const breakout = tracker.breakoutLocked(candles, i, pre, opts);
    if (breakdown) phaseBars.breakdown++;
    else if (breakout) phaseBars.breakout++;
    else phaseBars.pre_structure++;

    const active = resolveActiveSituations(candles, i, pre, barSit, dayTracker, routeTable, opts, dayState);
    for (const sit of active) {
      activeSitCounts[sit] = (activeSitCounts[sit] || 0) + 1;
      const routes = routeTable.routes[sit] || [];
      if (!routes.length) {
        filteredOut.noRoute++;
        continue;
      }
      const scanOpts = { ...opts, ...routeTable.thresholds };
      dayState.updateBias(candles, i, pre, bar, scanOpts);
      const cands = scanPlaybook(candles, i, pre, dayState, sit, routeTable, scanOpts);
      if (!cands.length) filteredOut.noSignal++;
      for (const c of cands) {
        const trigger = c.trigger;
        let blocked = null;
        if (c.side === "SELL" && !dayState.canShort(trigger, i, scanOpts)) blocked = "canTrade";
        if (c.side === "BUY" && !dayState.canLong(trigger, i, scanOpts)) blocked = "canTrade";
        if ((c.score ?? 0) < opts.minScore) blocked = "minScore";
        if (!passesEntryFilters(candles, i, pre, dayState, c, sit, { ...opts, ...scanOpts })) blocked = "entryFilter";
        if (blocked) {
          filteredOut[blocked]++;
          rawCandidates.push({ ts: bar.ts, situation: sit, trigger, blocked, score: c.score });
        } else {
          rawCandidates.push({ ts: bar.ts, situation: sit, trigger, blocked: null, score: c.score });
        }
      }
    }
  }

  const byDay = new Map();
  for (const c of rawCandidates.filter((x) => !x.blocked)) {
    const day = utcDayId(c.ts);
    const list = byDay.get(day) || [];
    list.push(c);
    byDay.set(day, list);
  }

  let daysWithMultiSit = 0;
  let daysWithOnlyBreakdown = 0;
  let daysWithPreOnly = 0;
  for (const [, list] of byDay) {
    const sits = new Set(list.map((x) => x.situation));
    if (sits.size > 1) daysWithMultiSit++;
    if (sits.size === 1 && sits.has(SITUATIONS.BREAKDOWN_BEAR)) daysWithOnlyBreakdown++;
    if ([...sits].every((s) => s !== SITUATIONS.BREAKDOWN_BEAR)) daysWithPreOnly++;
  }

  return {
    phaseBars,
    activeSitCounts,
    filteredOut,
    validCandidates: rawCandidates.filter((x) => !x.blocked).length,
    daysWithSignals: byDay.size,
    daysWithMultiSit,
    daysWithOnlyBreakdown,
    daysWithPreOnly,
    blockedByReason: Object.fromEntries(
      Object.entries(
        rawCandidates.filter((x) => x.blocked).reduce((acc, x) => {
          acc[x.blocked] = (acc[x.blocked] || 0) + 1;
          return acc;
        }, {}),
      ),
    ),
  };
}

const diskTable = loadRouteTable();
const kraTable = { ...diskTable, routes: KRA_ROUTES };
const deployTable = diskTable;
const opts = optsFromCfg(resolveSituationRouterCfg(BNB_SITUATION_ROUTER_15M));

console.log(`\n=== SITUATION ROUTER KRA AUDIT ${FROM} → ${TO} ===\n`);

console.log("--- KRA requirements (design intent) ---");
console.log("  1. Each situation routes to its sub-strategy when that condition is active");
console.log("  2. Phase lock: pre-structure (range/squeeze) BEFORE breakdown/breakout same day");
console.log("  3. Max 2 trades/day, best per situation when multiple fire");
console.log("  4. Only year-study positive cells enabled in routes\n");

console.log("--- Deployed routes (disk) ---");
for (const s of listRoutableStrategies(deployTable)) {
  console.log(`  ${s.situation} → ${s.id}: [${s.activeTriggers.join(", ")}]`);
}
const deployedCount = Object.values(deployTable.routes).filter((r) => r?.length).length;
console.log(`  Active situation routes: ${deployedCount}/4 KRA cells\n`);

console.log("--- Backtest: deployed vs full KRA routes ---");
const deployed = await runBacktest(deployTable, "deployed");
const fullKra = await runBacktest(kraTable, "full_kra");
console.log(`  Deployed (${deployedCount} routes): ${(deployed.ret ?? 0).toFixed(2)}% | ${deployed.n} trades | WR ${(deployed.wr ?? 0).toFixed(0)}%`);
console.log(`  Full KRA (4 routes):     ${(fullKra.ret ?? 0).toFixed(2)}% | ${fullKra.n} trades | WR ${(fullKra.wr ?? 0).toFixed(0)}%`);

const bySitDeploy = {};
for (const t of deployed.trades) bySitDeploy[t.situation] = (bySitDeploy[t.situation] || 0) + 1;
const bySitKra = {};
for (const t of fullKra.trades) {
  bySitKra[t.situation] = bySitKra[t.situation] || { n: 0, net: 0, triggers: {} };
  bySitKra[t.situation].n++;
  bySitKra[t.situation].net += t.net;
  bySitKra[t.situation].triggers[t.trigger] = (bySitKra[t.situation].triggers[t.trigger] || 0) + 1;
}

console.log("\n--- Trades by situation (deployed) ---");
console.log(bySitDeploy);

console.log("\n--- Trades by situation (full KRA) ---");
for (const [sit, v] of Object.entries(bySitKra)) {
  console.log(`  ${sit}: ${v.n} trades, net $${v.net.toFixed(2)}, triggers: ${JSON.stringify(v.triggers)}`);
}

console.log("\n--- Routing audit (full KRA routes) ---");
const audit = auditRouting(kraTable, opts);
console.log("  Phase bars:", audit.phaseBars);
console.log("  Active situation scans:", audit.activeSitCounts);
console.log("  Valid raw candidates:", audit.validCandidates);
console.log("  Days with any signal:", audit.daysWithSignals);
console.log("  Days multi-situation signals:", audit.daysWithMultiSit);
console.log("  Days pre-structure only signals:", audit.daysWithPreOnly);
console.log("  Blocked candidates:", audit.blockedByReason);
console.log("  Skipped (no route enabled):", audit.filteredOut.noRoute);

// Sample days where both phases had signals
console.log("\n--- Sample multi-phase days (full KRA, first 8) ---");
let shown = 0;
const { series } = buildSituationSeries(candles, pre, opts);
const dayPhases = new Map();
const dayTrackers2 = new Map();
for (let i = WARMUP; i < candles.length; i++) {
  const bar = candles[i];
  const day = utcDayId(bar.ts);
  if (!dayTrackers2.has(day)) dayTrackers2.set(day, new DaySituationTracker());
  const dt = dayTrackers2.get(day);
  dt.ensureDay(day);
  const barSit = series[i]?.situation;
  dt.update(barSit, i, candles, pre, opts);
  const phase = dt.breakdownLocked(candles, i, pre, opts) ? "breakdown" : "pre";
  if (!dayPhases.has(day)) dayPhases.set(day, new Set());
  dayPhases.get(day).add(phase);
}

for (const [day, phases] of dayPhases) {
  if (phases.has("breakdown") && phases.has("pre") && shown < 8) {
    const d = new Date(day * 86400000).toISOString().slice(0, 10);
    const kraTrades = fullKra.trades.filter((t) => new Date(t.ts).toISOString().slice(0, 10) === d);
    console.log(`  ${d}: phases pre+breakdown | trades: ${kraTrades.map((t) => `${t.situation}/${t.trigger}`).join(", ") || "none"}`);
    shown++;
  }
}

// Last DB run comparison
const pool = (await import("../src/db/pool.js")).getPool();
const lastRun = (await pool.query(`SELECT id, final_capital, initial_capital, config_snapshot FROM backtest_runs ORDER BY created_at DESC LIMIT 1`)).rows[0];
if (lastRun) {
  const cfg = typeof lastRun.config_snapshot === "string" ? JSON.parse(lastRun.config_snapshot) : lastRun.config_snapshot;
  const bot = cfg?.bot || cfg;
  const ret = ((Number(lastRun.final_capital) / Number(lastRun.initial_capital) - 1) * 100).toFixed(2);
  console.log(`\n--- Last UI run ${lastRun.id.slice(0, 8)} ---`);
  console.log(`  Return: ${ret}% | risk: ${bot.riskPerTrade}% | routes: disk table`);
}

await closePool();
