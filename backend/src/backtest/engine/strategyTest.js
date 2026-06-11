/**
 * Strategy testing battery — orchestrates the full validation suite for one
 * completed backtest run ("seed run"):
 *
 *   1. baseline reproducibility (re-run seed config on full history)
 *   2. purged walk-forward (4 folds, 1-day embargo)
 *   3. Monte Carlo bootstrap on trade R-multiples
 *   4. parameter sensitivity (±10% / ±20% on key numeric params)
 *   5. cost stress (slippage ×2/×4, fees ×2)
 *   6. black-swan stress (synthetic shocks + real crash windows when data exists)
 *   7. live-fidelity score (0–100, per-factor rubric)
 *   8. grade A/B/C/F (acceptance gates + stress survival + param stability)
 *   9. suggestion engine (best config within standard safety limits)
 *
 * Runs inside the backtest worker thread (DB pool already initialized).
 * Results persist as JSONB on `backtest_strategy_tests`.
 */

import { query } from "../../db/query.js";
import { readCandles, ensureKlines } from "../data/klineIngest.js";
import { readFundingRates } from "../data/fundingIngest.js";
import { getCoverage } from "../data/dataCoverage.js";
import { runSimulation } from "./runner.js";
import { computeAllMetrics, rMultipleStats } from "./metrics.js";
import { monteCarloBootstrap, purgedWalkForwardSplits, acceptanceGates } from "./validation.js";
import { portfolioReplay, tradesToREvents } from "./portfolioReplay.js";
import { SYNTHETIC_SCENARIOS, REAL_CRASH_WINDOWS } from "./stressScenarios.js";
import { BACKTEST_ENGINE_VERSION } from "./version.js";

/* ────────────────────────── persistence helpers ────────────────────────── */

export async function markTestRunning(testId) {
  await query(
    `UPDATE backtest_strategy_tests
        SET status = 'running', started_at = NOW(), progress_pct = 0
      WHERE id = $1`,
    [String(testId)],
  );
}

export async function updateTestProgress(testId, pct, phase) {
  await query(
    `UPDATE backtest_strategy_tests
        SET progress_pct = $2, current_phase = $3
      WHERE id = $1`,
    [String(testId), Math.min(99.9, Math.max(0, Number(pct) || 0)), phase ?? null],
  ).catch(() => {});
}

export async function failTest(testId, err) {
  await query(
    `UPDATE backtest_strategy_tests
        SET status = 'failed', error_message = $2, finished_at = NOW()
      WHERE id = $1`,
    [String(testId), String(err?.message || err).slice(0, 1000)],
  ).catch(() => {});
}

export async function cancelTest(testId) {
  await query(
    `UPDATE backtest_strategy_tests
        SET status = 'cancelled', finished_at = NOW()
      WHERE id = $1 AND status IN ('queued','running')`,
    [String(testId)],
  ).catch(() => {});
}

async function finalizeTest(testId, { report, grade, fidelityScore, suggestion }) {
  await query(
    `UPDATE backtest_strategy_tests
        SET status = 'done',
            progress_pct = 100,
            current_phase = 'done',
            report = $2::jsonb,
            grade = $3,
            live_fidelity_score = $4,
            suggestion = $5::jsonb,
            finished_at = NOW()
      WHERE id = $1`,
    [
      String(testId),
      JSON.stringify(report),
      grade,
      fidelityScore,
      suggestion ? JSON.stringify(suggestion) : null,
    ],
  );
}

/* ──────────────────────────── cfg materialization ───────────────────────── */

function pickBotCfg(snapshot, fallback) {
  const root =
    snapshot && typeof snapshot === "object"
      ? snapshot
      : fallback && typeof fallback === "object"
        ? fallback
        : {};
  if (root && typeof root.bot === "object" && root.bot) return root.bot;
  return root;
}

/** Mirror of worker.js pickStrategyKey — keep in sync. */
function pickStrategyKey(cfg, engineType) {
  const mmUp = String(cfg?.marketMode || cfg?.market || "").toUpperCase();
  const stSpot = Boolean(cfg?.supertrendSpotAuto);
  const stFut = Boolean(cfg?.supertrendFuturesAuto);
  const supertrendAutoOn =
    (mmUp === "SPOT" && stSpot) ||
    (mmUp === "FUTURES" && stFut) ||
    (mmUp === "AUTO" && (stSpot || stFut));
  if (supertrendAutoOn) return "SUPERTREND";
  const stratMode = String(cfg?.strategyMode ?? "").toUpperCase();
  if (stratMode === "MANUAL") {
    const m = String(cfg?.manualStrategy ?? "").toUpperCase();
    if (m && m !== "MANUAL" && m !== "AUTO") return m;
    return "SUPERTREND";
  }
  if (stratMode === "AUTO") return "AUTO";
  const et = String(engineType ?? "").toUpperCase();
  if (et && et !== "AUTO" && et !== "MANUAL") return et;
  return "SUPERTREND";
}

/** Mirror of worker.js cfg materialization — same engine resolution as a normal run. */
async function materializeCfg(run) {
  let cfg = pickBotCfg(run.config_snapshot, run.strategy_cfg_raw);
  try {
    const { materializeIntradayEngineCfgSync } = await import("../../strategy/presets/srIntradayOptimized.js");
    const { materializeIntradayPanelOnCfg } = await import("../../strategy/intradayPanelKeys.js");
    const { ensureBacktestMarketMode, applyInstanceOperationalToBot } = await import("../../lib/strategyInstanceSplit.js");
    const { normalizeEliteStRunCfg } = await import("../../strategy/supertrendElite.js");
    const stratEarly = String(cfg.manualStrategy ?? "").toUpperCase();
    if (stratEarly === "SITUATION_INTRADAY") {
      const { resolveSituationRouterCfg } = await import("../../strategy/situationIntraday.js");
      cfg = resolveSituationRouterCfg(cfg);
      cfg._intradayEngineMaterialized = true;
    } else if (stratEarly === "CRT_TBS") {
      const { resolveCrtTbsCfg } = await import("../../strategy/crtTbsIntraday.js");
      cfg = resolveCrtTbsCfg(cfg);
      cfg._intradayEngineMaterialized = true;
    } else if (stratEarly === "TOKYO_SESSION") {
      const { resolveTokyoSessionCfg } = await import("../../strategy/tokyoSessionIntraday.js");
      cfg = resolveTokyoSessionCfg(cfg);
      cfg._intradayEngineMaterialized = true;
    } else if (stratEarly === "SUPERTREND_ELITE" || stratEarly === "UNIFIED_ELITE") {
      cfg._intradayEngineMaterialized = true;
    } else if (!cfg._intradayEngineMaterialized) {
      cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
    }
    if (run.instance_operational_snapshot && typeof run.instance_operational_snapshot === "object") {
      applyInstanceOperationalToBot(cfg, run.instance_operational_snapshot);
    }
    cfg = ensureBacktestMarketMode(cfg);
    const strat = String(cfg.manualStrategy ?? "").toUpperCase();
    if (strat === "SUPERTREND_ELITE" || strat === "UNIFIED_ELITE") {
      Object.assign(cfg, normalizeEliteStRunCfg(cfg));
    }
  } catch {
    /* optional */
  }
  return cfg;
}

/* ───────────────────────────── data loading ──────────────────────────────── */

/** Binance futures launched Sep 2019; nothing exists before this floor. */
const HISTORY_FLOOR_MS = Date.UTC(2019, 0, 1);
/** TimescaleDB lock budget: unbounded reads across years of chunks exhaust
 *  max_locks_per_transaction, so full history is read in bounded slices. */
const HISTORY_SLICE_MS = 180 * 24 * 60 * 60 * 1000;

async function readFullHistory(symbol, tf, market) {
  const out = [];
  const now = Date.now();
  for (let from = HISTORY_FLOOR_MS; from < now; from += HISTORY_SLICE_MS) {
    const to = Math.min(now, from + HISTORY_SLICE_MS);
    const part = await readCandles(symbol, tf, from, to, { market });
    if (part.length) out.push(...part);
  }
  return out;
}

/* ───────────────────────────── simulation helper ─────────────────────────── */

async function prepareEliteSimCfg(baseCfg, symbol, candles, strategyKey) {
  const sk = String(strategyKey ?? "").toUpperCase();
  if (sk !== "SUPERTREND_ELITE" && sk !== "UNIFIED_ELITE") return baseCfg;
  const { prepareEliteRunCfg } = await import("../../strategy/supertrendElite.js");
  return prepareEliteRunCfg(baseCfg, symbol, candles);
}

/** PASS | MARGINAL | SKIP — honest deploy guidance for a single coin. */
export function gradeCoinSuitability({ grade, oosReturnPct, mcP5ReturnPct, maxDrawdownPct }) {
  const oos = Number(oosReturnPct);
  const dd = Number(maxDrawdownPct);
  const mcP5 = Number(mcP5ReturnPct);
  if (grade === "F" || (Number.isFinite(oos) && oos <= 0)) return "SKIP";
  if (grade === "A" || (Number.isFinite(oos) && oos > 5 && dd <= 15 && mcP5 > 0)) return "PASS";
  if (grade === "B" || (Number.isFinite(oos) && oos > 0)) return "MARGINAL";
  return "SKIP";
}

async function buildAdapters({ strategyKey, cfg, symbol, tf, candles, fromMs }) {
  try {
    const { buildBacktestAdapters } = await import("./signals/baselines.js");
    if (typeof buildBacktestAdapters === "function") {
      return await buildBacktestAdapters({ strategyKey, cfg, symbol, tf, candles, fromMs });
    }
  } catch {
    /* adapters optional for some strategies */
  }
  return {};
}

/**
 * Run one variant of the battery: optional cfg patch, cost-model patch, and
 * candle transform. Handles single-coin and portfolio seeds.
 */
async function simulateVariant(ctx, { cfgPatch = null, costPatch = null, candleTransform = null, candlesOverrideBySym = null } = {}) {
  const { symbols, tf, strategyKey, startingUsdt, shouldCancel, isPortfolio } = ctx;
  const cfg = cfgPatch ? { ...ctx.cfg, ...cfgPatch } : ctx.cfg;
  const costModelOverride = costPatch ? { ...ctx.costModelOverride, ...costPatch } : ctx.costModelOverride;
  const riskPct = Math.max(0.01, Number(cfg?.riskPerTrade ?? 5));

  if (!isPortfolio) {
    const sym = symbols[0];
    const base = candlesOverrideBySym?.[sym] ?? ctx.candlesBySym[sym];
    const candles = candleTransform ? candleTransform(base) : base;
    if (!candles?.length) return null;
    const runCfg = await prepareEliteSimCfg(cfg, sym, candles, strategyKey);
    const adapters = await buildAdapters({
      strategyKey,
      cfg: runCfg,
      symbol: sym,
      tf,
      candles,
      fromMs: candles[0].ts,
    });
    const sim = await runSimulation({
      strategyKey,
      candles,
      cfg: runCfg,
      costModelOverride,
      gateMode: "off",
      fundingRates: ctx.fundingBySym[sym] ?? [],
      startingUsdt,
      timeframe: tf,
      symbol: sym,
      adapters,
      shouldCancel,
    });
    const metrics = computeAllMetrics({
      trades: sim.trades,
      equityCurve: sim.equityCurve,
      tf,
      startingEquity: startingUsdt,
    });
    return { metrics, trades: sim.trades, equityCurve: sim.equityCurve };
  }

  // Portfolio: per-symbol unit sims → R events → shared-account replay.
  const UNIT_START = 1000;
  const allEvents = [];
  let firstTs = null;
  for (const sym of symbols) {
    if (shouldCancel?.()) throw new Error("cancelled");
    const base = candlesOverrideBySym?.[sym] ?? ctx.candlesBySym[sym];
    const candles = candleTransform ? candleTransform(base) : base;
    if (!candles?.length) continue;
    if (firstTs == null) firstTs = candles[0].ts;
    const runCfg = await prepareEliteSimCfg(cfg, sym, candles, strategyKey);
    const adapters = await buildAdapters({
      strategyKey,
      cfg: runCfg,
      symbol: sym,
      tf,
      candles,
      fromMs: candles[0].ts,
    });
    const sim = await runSimulation({
      strategyKey,
      candles,
      cfg: runCfg,
      costModelOverride,
      gateMode: "off",
      fundingRates: ctx.fundingBySym[sym] ?? [],
      startingUsdt: UNIT_START,
      timeframe: tf,
      symbol: sym,
      adapters,
      shouldCancel,
    });
    allEvents.push(...tradesToREvents(sym, sim.trades, riskPct));
  }
  const replay = portfolioReplay({
    events: allEvents,
    startingUsdt,
    riskFrac: riskPct / 100,
    startTs: firstTs,
  });
  const metrics = computeAllMetrics({
    trades: replay.trades,
    equityCurve: replay.equityCurve,
    tf,
    startingEquity: startingUsdt,
  });
  return { metrics, trades: replay.trades, equityCurve: replay.equityCurve };
}

/* ─────────────────────────────── report pieces ────────────────────────────── */

const slim = (m) =>
  m
    ? {
        totalTrades: m.totalTrades ?? 0,
        winRate: m.winRate ?? 0,
        profitFactor: m.profitFactor ?? null,
        expectancy: m.expectancy ?? 0,
        totalReturnPct: m.totalReturnPct ?? 0,
        maxDrawdownPct: m.maxDrawdownPct ?? 0,
        sharpe: m.sharpe ?? 0,
        calmar: m.calmar ?? null,
        cagrPct: m.cagrPct ?? 0,
        totalFees: m.totalFees ?? 0,
        totalGrossPnl: m.totalGrossPnl ?? 0,
        totalNetPnl: m.totalNetPnl ?? 0,
        finalEquity: m.finalEquity ?? null,
      }
    : null;

/** Params worth perturbing, in priority order. Only ones present on cfg are used. */
const PERTURBABLE_KEYS = [
  "supertrendPeriod",
  "supertrendMultiplier",
  "eliteStMinAdx",
  "eliteStMinVolumeVsAvg",
  "emaFastPeriod",
  "emaSlowPeriod",
  "rsiPeriod",
  "adxPeriod",
  "atrPeriod",
  "breakoutLookback",
];
const INTEGER_PARAMS = new Set([
  "supertrendPeriod",
  "emaFastPeriod",
  "emaSlowPeriod",
  "rsiPeriod",
  "adxPeriod",
  "atrPeriod",
  "breakoutLookback",
]);

function pickPerturbableParams(cfg, maxParams = 4) {
  const out = [];
  for (const key of PERTURBABLE_KEYS) {
    const v = Number(cfg?.[key]);
    if (Number.isFinite(v) && v > 0) out.push({ key, base: v });
    if (out.length >= maxParams) break;
  }
  return out;
}

function perturbValue(key, base, pct) {
  const raw = base * (1 + pct / 100);
  return INTEGER_PARAMS.has(key) ? Math.max(1, Math.round(raw)) : raw;
}

/**
 * Variant produced bit-identical results to baseline → the engine clamped or
 * ignored the perturbed value (e.g. Elite floors supertrendMultiplier at 3).
 * Such variants test nothing and must not count toward the break rate.
 */
export function variantHasNoEffect(baseMetrics, variantMetrics) {
  if (!baseMetrics || !variantMetrics) return false;
  return (
    Number(baseMetrics.totalTrades) === Number(variantMetrics.totalTrades) &&
    Math.abs(Number(baseMetrics.totalReturnPct) - Number(variantMetrics.totalReturnPct)) < 1e-9 &&
    Math.abs(Number(baseMetrics.maxDrawdownPct) - Number(variantMetrics.maxDrawdownPct)) < 1e-9
  );
}

/** Variant "breaks" = profitable baseline flips negative, or return degrades >50%. */
export function variantBreaks(baselineReturnPct, variantReturnPct) {
  const base = Number(baselineReturnPct);
  const v = Number(variantReturnPct);
  if (!Number.isFinite(base) || !Number.isFinite(v)) return true;
  if (base > 0 && v <= 0) return true;
  if (base > 0 && v < base * 0.5) return true;
  if (base <= 0) return v < base * 1.5 - 1; // already unprofitable: only flag if much worse
  return false;
}

/** Scenario survival: equity keeps ≥50% and drawdown stays <50%. */
export function scenarioSurvived({ finalEquity, startingEquity, maxDrawdownPct }) {
  const eq = Number(finalEquity);
  const start = Number(startingEquity);
  const dd = Number(maxDrawdownPct);
  if (Number.isFinite(eq) && Number.isFinite(start) && start > 0 && eq < start * 0.5) return false;
  if (Number.isFinite(dd) && dd >= 50) return false;
  return true;
}

/* ───────────────────────── live-fidelity score rubric ─────────────────────── */

/**
 * How much should this backtest resemble live trading? 0–100 weighted rubric.
 * Pure function — unit-testable.
 */
export function computeLiveFidelity({
  takerFeeRate,
  slippagePct,
  gateMode,
  coveragePct,
  totalTrades,
  wfDegradationPct,
  mcP5ReturnPct,
  mcP50ReturnPct,
  paramBreakRatePct,
  feesOverGrossPct,
  usesMlAdapter,
}) {
  const factors = [];
  const add = (id, label, score, max, note) => {
    factors.push({ id, label, score: Math.max(0, Math.min(max, Math.round(score * 10) / 10)), max, note });
  };

  // 1. Costs realism (15)
  const feesOn = Number(takerFeeRate) > 0;
  const slipOn = Number(slippagePct) > 0;
  add(
    "costs",
    "Realistic costs",
    feesOn && slipOn ? 15 : feesOn || slipOn ? 8 : 0,
    15,
    feesOn && slipOn
      ? "Fees and slippage both applied"
      : feesOn || slipOn
        ? "Only one of fees/slippage applied — live will be worse"
        : "Zero-cost backtest — live results will differ substantially",
  );

  // 2. Gate parity (10)
  const gateOff = String(gateMode || "off") !== "approx";
  add(
    "gate",
    "Intelligence gate parity",
    gateOff ? 10 : 6,
    10,
    gateOff
      ? "No gate replay — signal path matches live exactly"
      : "Approx gate replay differs from live order-book/options intel",
  );

  // 3. Data coverage (10)
  const cov = Number(coveragePct);
  add(
    "coverage",
    "Data coverage",
    Number.isFinite(cov) ? (cov / 100) * 10 : 5,
    10,
    Number.isFinite(cov) ? `${cov.toFixed(1)}% of bars present` : "Coverage unknown",
  );

  // 4. Trade-count significance (15)
  const n = Number(totalTrades) || 0;
  const sig = n >= 100 ? 15 : n >= 50 ? 11 : n >= 30 ? 7 : n >= 10 ? 4 : 1;
  add(
    "significance",
    "Statistical significance",
    sig,
    15,
    `${n} trades — ${n >= 100 ? "robust sample" : n >= 50 ? "adequate sample" : n >= 30 ? "thin sample" : "too few trades to trust the stats"}`,
  );

  // 5. Walk-forward transfer (15)
  const deg = Number(wfDegradationPct);
  const wfScore = !Number.isFinite(deg) ? 5 : deg < 20 ? 15 : deg < 35 ? 11 : deg < 50 ? 6 : 0;
  add(
    "walkforward",
    "Out-of-sample transfer",
    wfScore,
    15,
    !Number.isFinite(deg)
      ? "Walk-forward not computable"
      : `Train→test expectancy degradation ${deg.toFixed(1)}% — ${deg < 35 ? "edge transfers out-of-sample" : "edge fades out-of-sample"}`,
  );

  // 6. Monte Carlo dispersion (10)
  const p5 = Number(mcP5ReturnPct);
  const p50 = Number(mcP50ReturnPct);
  const mcScore = p5 > 0 ? 10 : p50 > 0 ? 4 : 0;
  add(
    "montecarlo",
    "Luck sensitivity (MC)",
    mcScore,
    10,
    p5 > 0
      ? "Even 5th-percentile reshuffles stay profitable"
      : p50 > 0
        ? "Median path profitable but bad-luck paths lose"
        : "Results likely depend on trade-order luck",
  );

  // 7. Parameter stability (15)
  const br = Number(paramBreakRatePct);
  const stabScore = !Number.isFinite(br) ? 7 : br <= 10 ? 15 : br <= 25 ? 11 : br <= 50 ? 5 : 0;
  add(
    "stability",
    "Parameter stability",
    stabScore,
    15,
    !Number.isFinite(br)
      ? "Sensitivity not computed"
      : `${br.toFixed(0)}% of ±10–20% perturbations break the edge — ${br <= 25 ? "broad plateau" : "overfit island"}`,
  );

  // 8. Fee sensitivity (5)
  const fog = Number(feesOverGrossPct);
  const feeScore = !Number.isFinite(fog) ? 2.5 : fog < 25 ? 5 : fog < 50 ? 3 : fog < 100 ? 1 : 0;
  add(
    "feeshare",
    "Fee share of gross",
    feeScore,
    5,
    Number.isFinite(fog)
      ? `Fees consume ${fog.toFixed(0)}% of gross PnL${fog >= 50 ? " — live spread/latency can erase the edge" : ""}`
      : "Fee share unknown",
  );

  // 9. ML look-ahead risk (5)
  add(
    "ml",
    "ML look-ahead risk",
    usesMlAdapter ? 2 : 5,
    5,
    usesMlAdapter
      ? "Strategy uses ML predictions — training-cutoff leakage possible"
      : "No ML adapter — no training-cutoff risk",
  );

  const score = factors.reduce((s, f) => s + f.score, 0);
  return { score: Math.round(score * 10) / 10, factors };
}

/* ─────────────────────────────── grading rubric ───────────────────────────── */

/** Pure A/B/C/F grading from gates + stress + sensitivity. Unit-testable. */
export function computeGrade({ gates, stressSurvivedAll, ruinObserved, paramBreakRatePct, oosReturnPct, mcP5ReturnPct }) {
  const reasons = [];
  const failures = Object.entries(gates?.gates ?? {}).filter(([, g]) => !g.pass);

  if (ruinObserved || (Number(oosReturnPct) <= 0 && Number(mcP5ReturnPct) <= 0)) {
    reasons.push(
      ruinObserved
        ? "Account ruin observed in a stress scenario"
        : "Negative out-of-sample return AND negative Monte Carlo 5th percentile",
    );
    return { grade: "F", reasons };
  }

  if (failures.length >= 2) {
    reasons.push(`Fails ${failures.length} acceptance gates: ${failures.map(([k]) => k).join(", ")}`);
    return { grade: "F", reasons };
  }
  if (failures.length === 1) {
    reasons.push(`Fails acceptance gate: ${failures[0][0]}`);
    return { grade: "C", reasons };
  }

  const paramsStable = Number(paramBreakRatePct) <= 25;
  if (gates?.allPass && stressSurvivedAll && paramsStable) {
    reasons.push("All 4 acceptance gates pass, survives every stress scenario, parameters stable (±10–20%)");
    return { grade: "A", reasons };
  }

  if (!stressSurvivedAll) reasons.push("Fails one or more stress scenarios (drawdown ≥50% or equity halved)");
  if (!paramsStable) reasons.push(`Parameter perturbations break the edge in ${Number(paramBreakRatePct).toFixed(0)}% of cases`);
  reasons.push("All acceptance gates pass — deployable only after the weaknesses above are addressed");
  return { grade: "B", reasons };
}

/* ───────────────────────────── suggestion engine ──────────────────────────── */

/** Standard safety limits a suggested config must respect. */
export const SAFETY_LIMITS = {
  maxDrawdownPct: 15,
  mcP5ReturnPct: 0,
  riskOfRuinPct: 1,
};

export function pickBestCandidate(candidates, limits = SAFETY_LIMITS) {
  const safe = candidates.filter(
    (c) =>
      Number(c.maxDrawdownPct) <= limits.maxDrawdownPct &&
      Number(c.mcP5ReturnPct) > limits.mcP5ReturnPct &&
      Number(c.riskOfRuinPct) < limits.riskOfRuinPct,
  );
  if (!safe.length) return null;
  safe.sort((a, b) => Number(b.totalReturnPct) - Number(a.totalReturnPct));
  return safe[0];
}

/** Safety overlay recommended for any live instance (SAFE_INTRADAY conventions). */
function instanceSafetyOverlay(cfg) {
  return {
    riskPerTrade: Math.min(2, Math.max(0.5, Number(cfg?.riskPerTrade ?? 1))),
    riskPerTradeUnit: "PCT",
    futuresLeverage: Math.min(10, Math.max(1, Number(cfg?.futuresLeverage ?? 10))),
    maxDailyLoss: 1.5,
    maxDailyLossUnit: "PCT",
    riskKillSwitchDdPct: 8,
    riskConsecutiveLossLimit: 2,
    riskWeeklyMaxLossPct: 4,
  };
}

/* ─────────────────────────────── main entrypoint ──────────────────────────── */

/**
 * @param {{ testId: string, onProgress?: (pct:number, phase:string)=>void, shouldCancel?: ()=>boolean }} args
 */
export async function executeStrategyTest({ testId, onProgress, shouldCancel }) {
  // Serialize progress writes so a slow in-flight UPDATE can't land after
  // finalizeTest and clobber the final pct/phase (status=done, phase=black_swan).
  let progressChain = Promise.resolve();
  const report = (pct, phase) => {
    onProgress?.(pct, phase);
    progressChain = progressChain.then(() => updateTestProgress(testId, pct, phase)).catch(() => {});
  };
  const checkCancel = () => {
    if (shouldCancel?.()) throw new Error("cancelled");
  };

  const tr = await query(`SELECT * FROM backtest_strategy_tests WHERE id = $1`, [String(testId)]);
  const test = tr.rows[0];
  if (!test) throw new Error("strategy_test_not_found");
  if (test.status === "cancelled") return;

  const rr = await query(
    `SELECT br.*, sv.cfg_raw AS strategy_cfg_raw
       FROM backtest_runs br
       JOIN strategy_versions sv ON sv.id = br.strategy_version_id
      WHERE br.id = $1`,
    [String(test.seed_run_id)],
  );
  const run = rr.rows[0];
  if (!run) throw new Error("seed_run_not_found");
  if (run.status !== "done") throw new Error("seed_run_not_done");

  await markTestRunning(testId);
  report(0.5, "loading");

  const cfg = await materializeCfg(run);
  const strategyKey = pickStrategyKey(cfg, run.engine_type);
  const tf = String(run.timeframe);
  const isFutures = String(cfg?.marketMode || cfg?.market || "").toUpperCase() === "FUTURES";
  const market = isFutures ? "futures" : "spot";
  const startingUsdt = Number(run.initial_capital) || 1000;
  const costModelOverride = run.cost_model && typeof run.cost_model === "object" ? run.cost_model : {};
  const isPortfolio = run.is_portfolio === true && Array.isArray(run.symbols) && run.symbols.length >= 2;
  const symbols = isPortfolio
    ? run.symbols.map((s) => String(s).toUpperCase())
    : [String(run.symbol).toUpperCase()];
  const primarySymbol = symbols[0];
  const seedRiskPct = Math.max(0.01, Number(cfg?.riskPerTrade ?? 5));

  // Full available history per symbol (everything in the DB).
  const candlesBySym = {};
  const fundingBySym = {};
  for (const sym of symbols) {
    checkCancel();
    const candles = await readFullHistory(sym, tf, market);
    if (!candles.length) throw new Error(`no_candles_for_${sym}`);
    candlesBySym[sym] = candles;
  }
  // Portfolio: clamp every symbol to the common overlapping window. Histories
  // can differ by years (e.g. BNB since 2021 vs ADA since 2025) and replaying
  // one coin alone for years is not the portfolio being tested.
  let portfolioWindowNote = null;
  if (isPortfolio) {
    const commonFrom = Math.max(...symbols.map((s) => candlesBySym[s][0].ts));
    const commonTo = Math.min(...symbols.map((s) => candlesBySym[s][candlesBySym[s].length - 1].ts));
    if (!(commonFrom < commonTo)) throw new Error("portfolio_symbols_have_no_common_history");
    for (const sym of symbols) {
      candlesBySym[sym] = candlesBySym[sym].filter((c) => c.ts >= commonFrom && c.ts <= commonTo);
      if (!candlesBySym[sym].length) throw new Error(`no_candles_in_common_window_for_${sym}`);
    }
    portfolioWindowNote = `Portfolio symbols aligned to their common data window (${new Date(commonFrom).toISOString().slice(0, 10)} → ${new Date(commonTo).toISOString().slice(0, 10)})`;
  }
  for (const sym of symbols) {
    const candles = candlesBySym[sym];
    fundingBySym[sym] = isFutures
      ? await readFundingRates(sym, candles[0].ts, candles[candles.length - 1].ts).catch(() => [])
      : [];
  }
  const primaryCandles = candlesBySym[primarySymbol];
  const windowFrom = primaryCandles[0].ts;
  const windowTo = primaryCandles[primaryCandles.length - 1].ts;

  const ctx = {
    symbols,
    tf,
    cfg,
    strategyKey,
    startingUsdt,
    costModelOverride,
    candlesBySym,
    fundingBySym,
    isPortfolio,
    shouldCancel,
  };

  /* ── Phase 1: baseline reproducibility ── */
  report(2, "baseline");
  const baseline = await simulateVariant(ctx);
  checkCancel();
  if (!baseline) throw new Error("baseline_simulation_failed");
  const baseM = baseline.metrics;

  const seedReturnPct =
    run.initial_capital > 0 && run.final_capital != null
      ? ((Number(run.final_capital) - Number(run.initial_capital)) / Number(run.initial_capital)) * 100
      : null;
  // Seed ran on its own [start,end] window; baseline runs full history. Compare
  // trade overlap only when windows match, otherwise report as informational.
  const sameWindow =
    Math.abs(new Date(run.start_date).getTime() - windowFrom) < 86_400_000 &&
    Math.abs(new Date(run.end_date).getTime() - windowTo) < 86_400_000;
  const reproducibility = {
    seedReturnPct,
    seedTrades: Number(run.total_trades ?? 0),
    batteryReturnPct: baseM.totalReturnPct,
    batteryTrades: baseM.totalTrades,
    sameWindow,
    note: sameWindow
      ? "Seed window ≈ full history — numbers directly comparable"
      : "Battery uses full available history (longer than the seed run window); totals will differ",
  };
  report(8, "walk_forward");

  /* ── Phase 2: purged walk-forward ── */
  const stepMs = primaryCandles.length > 1 ? primaryCandles[1].ts - primaryCandles[0].ts : 900_000;
  const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
  const splits = purgedWalkForwardSplits(primaryCandles.length, {
    folds: 4,
    embargo,
    mode: "rolling",
    minTrain: 300,
  });
  const wfFolds = [];
  let trainExpSum = 0;
  let testExpSum = 0;
  let oosSumReturnPct = 0;
  const wfCtx = { ...ctx, symbols: [primarySymbol], isPortfolio: false };
  for (let i = 0; i < splits.length; i++) {
    checkCancel();
    const s = splits[i];
    const trainRes = await simulateVariant(wfCtx, {
      candlesOverrideBySym: { [primarySymbol]: primaryCandles.slice(s.trainStart, s.trainEnd) },
    });
    const testRes = await simulateVariant(wfCtx, {
      candlesOverrideBySym: { [primarySymbol]: primaryCandles.slice(s.testStart, s.testEnd) },
    });
    const trM = trainRes?.metrics;
    const teM = testRes?.metrics;
    trainExpSum += trM?.expectancy || 0;
    testExpSum += teM?.expectancy || 0;
    oosSumReturnPct += teM?.totalReturnPct || 0;
    wfFolds.push({
      fold: s.fold,
      train: { trades: trM?.totalTrades ?? 0, expectancy: trM?.expectancy ?? 0, returnPct: trM?.totalReturnPct ?? 0 },
      test: {
        trades: teM?.totalTrades ?? 0,
        expectancy: teM?.expectancy ?? 0,
        returnPct: teM?.totalReturnPct ?? 0,
        profitFactor: teM?.profitFactor ?? null,
      },
    });
    report(8 + ((i + 1) / splits.length) * 20, "walk_forward");
  }
  const avgTrainExp = splits.length ? trainExpSum / splits.length : 0;
  const avgTestExp = splits.length ? testExpSum / splits.length : 0;
  const wfDegradationPct = avgTrainExp !== 0 ? ((avgTrainExp - avgTestExp) / Math.abs(avgTrainExp)) * 100 : 100;
  const walkForward = {
    folds: wfFolds,
    avgTrainExpectancy: avgTrainExp,
    avgTestExpectancy: avgTestExp,
    degradationPct: wfDegradationPct,
    oosSumReturnPct,
    embargoBars: embargo,
    scope: isPortfolio ? "primary_symbol" : "full",
    note: isPortfolio ? `Walk-forward computed on ${primarySymbol} (portfolio folds are cost-prohibitive)` : null,
  };

  /* ── Phase 3: Monte Carlo ── */
  report(30, "monte_carlo");
  const rstats = rMultipleStats(baseline.trades);
  const mc = monteCarloBootstrap(rstats.rValues, {
    paths: 3000,
    riskFrac: seedRiskPct / 100,
    ruinDrawdownPct: 50,
  });
  const monteCarlo = { ...mc, riskFracPct: seedRiskPct, rCount: rstats.rValues?.length ?? 0 };
  report(32, "sensitivity");

  /* ── Phase 4: parameter sensitivity (±10% / ±20%) ── */
  const params = pickPerturbableParams(cfg, 4);
  const sensitivityParams = [];
  let breakCount = 0;
  let variantCount = 0;
  const deltas = [-20, -10, 10, 20];
  const totalSensSims = params.length * deltas.length;
  let sensDone = 0;
  for (const p of params) {
    const variants = [];
    for (const d of deltas) {
      checkCancel();
      const value = perturbValue(p.key, p.base, d);
      if (value === p.base) {
        sensDone++;
        continue;
      }
      const res = await simulateVariant(ctx, { cfgPatch: { [p.key]: value } });
      const m = res?.metrics;
      const noEffect = variantHasNoEffect(baseM, m);
      const breaks = noEffect ? false : variantBreaks(baseM.totalReturnPct, m?.totalReturnPct);
      if (!noEffect) {
        if (breaks) breakCount++;
        variantCount++;
      }
      variants.push({
        delta: `${d > 0 ? "+" : ""}${d}%`,
        value,
        returnPct: m?.totalReturnPct ?? null,
        profitFactor: m?.profitFactor ?? null,
        trades: m?.totalTrades ?? 0,
        maxDrawdownPct: m?.maxDrawdownPct ?? null,
        breaks,
        ...(noEffect ? { noEffect: true } : {}),
      });
      sensDone++;
      report(32 + (sensDone / Math.max(1, totalSensSims)) * 28, "sensitivity");
    }
    sensitivityParams.push({ key: p.key, base: p.base, variants });
  }
  const paramBreakRatePct = variantCount > 0 ? (breakCount / variantCount) * 100 : null;
  const sensitivity = {
    params: sensitivityParams,
    variantCount,
    breakCount,
    breakRatePct: paramBreakRatePct,
    stable: paramBreakRatePct != null ? paramBreakRatePct <= 25 : null,
  };
  report(60, "cost_stress");

  /* ── Phase 5: cost stress ── */
  const baseSlip = Number(costModelOverride.slippagePct ?? cfg?.slippagePct ?? 0.0005);
  const baseTaker = Number(costModelOverride.takerOpenFeeRate ?? 0.0005);
  const costVariants = [
    { id: "slippage_x2", label: "Slippage ×2", costPatch: { slippagePct: baseSlip * 2 } },
    { id: "slippage_x4", label: "Slippage ×4", costPatch: { slippagePct: baseSlip * 4 } },
    {
      id: "fees_x2",
      label: "Fees ×2",
      costPatch: {
        takerOpenFeeRate: baseTaker * 2,
        takerCloseFeeRate: baseTaker * 2,
        openFeeRate: baseTaker * 2,
        closeFeeRate: baseTaker * 2,
      },
    },
  ];
  const costStress = [];
  for (let i = 0; i < costVariants.length; i++) {
    checkCancel();
    const v = costVariants[i];
    const res = await simulateVariant(ctx, { costPatch: v.costPatch });
    const m = res?.metrics;
    costStress.push({
      id: v.id,
      label: v.label,
      returnPct: m?.totalReturnPct ?? null,
      deltaVsBasePct: m != null ? (m.totalReturnPct ?? 0) - (baseM.totalReturnPct ?? 0) : null,
      trades: m?.totalTrades ?? 0,
      survived: m != null ? (m.totalReturnPct ?? -100) > -50 : false,
    });
    report(60 + ((i + 1) / costVariants.length) * 10, "cost_stress");
  }
  const feesOverGrossPct =
    Number(baseM.totalGrossPnl) > 0 ? (Number(baseM.totalFees) / Number(baseM.totalGrossPnl)) * 100 : null;

  /* ── Phase 6: black-swan stress (synthetic + real windows) ── */
  report(70, "black_swan");
  const stress = [];
  let ruinObserved = false;
  const synth = SYNTHETIC_SCENARIOS;
  for (let i = 0; i < synth.length; i++) {
    checkCancel();
    const sc = synth[i];
    const res = await simulateVariant(
      ctx,
      sc.kind === "costModel"
        ? { costPatch: sc.applyCost(costModelOverride) }
        : { candleTransform: sc.apply },
    );
    const m = res?.metrics;
    const survived =
      m != null &&
      scenarioSurvived({
        finalEquity: m.finalEquity,
        startingEquity: startingUsdt,
        maxDrawdownPct: m.maxDrawdownPct,
      });
    if (m != null && Number(m.totalReturnPct) <= -80) ruinObserved = true;
    stress.push({
      id: sc.id,
      label: sc.label,
      kind: "synthetic",
      returnPct: m?.totalReturnPct ?? null,
      maxDrawdownPct: m?.maxDrawdownPct ?? null,
      trades: m?.totalTrades ?? 0,
      survived,
    });
    report(70 + ((i + 1) / (synth.length + REAL_CRASH_WINDOWS.length)) * 16, "black_swan");
  }

  for (let i = 0; i < REAL_CRASH_WINDOWS.length; i++) {
    checkCancel();
    const w = REAL_CRASH_WINDOWS[i];
    const fromMs = new Date(w.from).getTime();
    const toMs = new Date(w.to).getTime();
    let entry = { id: w.id, label: w.label, kind: "historical", window: `${w.from} → ${w.to}` };
    try {
      let cov = await getCoverage(primarySymbol, tf, { from: fromMs, to: toMs }).catch(() => ({ coveragePct: null }));
      if (cov.coveragePct == null || cov.coveragePct < 80) {
        await ensureKlines(primarySymbol, tf, { from: fromMs, to: toMs, market }).catch(() => {});
        cov = await getCoverage(primarySymbol, tf, { from: fromMs, to: toMs }).catch(() => ({ coveragePct: null }));
      }
      if (cov.coveragePct == null || cov.coveragePct < 80) {
        entry = { ...entry, skipped: true, reason: `No data (coverage ${cov.coveragePct?.toFixed(0) ?? "0"}%) — symbol likely not listed then` };
      } else {
        const windowCandles = await readCandles(primarySymbol, tf, fromMs, toMs, { market });
        const res = await simulateVariant(
          { ...ctx, symbols: [primarySymbol], isPortfolio: false },
          { candlesOverrideBySym: { [primarySymbol]: windowCandles } },
        );
        const m = res?.metrics;
        const survived =
          m != null &&
          scenarioSurvived({
            finalEquity: m.finalEquity,
            startingEquity: startingUsdt,
            maxDrawdownPct: m.maxDrawdownPct,
          });
        if (m != null && Number(m.totalReturnPct) <= -80) ruinObserved = true;
        entry = {
          ...entry,
          returnPct: m?.totalReturnPct ?? null,
          maxDrawdownPct: m?.maxDrawdownPct ?? null,
          trades: m?.totalTrades ?? 0,
          survived,
        };
      }
    } catch (err) {
      entry = { ...entry, skipped: true, reason: String(err?.message || err).slice(0, 200) };
    }
    stress.push(entry);
    report(70 + ((synth.length + i + 1) / (synth.length + REAL_CRASH_WINDOWS.length)) * 16, "black_swan");
  }
  const stressSurvivedAll = stress.filter((s) => !s.skipped).every((s) => s.survived);

  /* ── Phase 7+8: gates, fidelity, grade ── */
  report(87, "scoring");
  const gates = acceptanceGates({
    oosReturnPct: oosSumReturnPct,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: baseM.calmar ?? -1,
    walkForwardDegradationPct: wfDegradationPct,
  });

  const fidelity = computeLiveFidelity({
    takerFeeRate: baseTaker,
    slippagePct: baseSlip,
    gateMode: run.gate_mode,
    coveragePct: Number(run.data_coverage_pct),
    totalTrades: baseM.totalTrades,
    wfDegradationPct,
    mcP5ReturnPct: mc.insufficient ? null : mc.p5ReturnPct,
    mcP50ReturnPct: mc.insufficient ? null : mc.p50ReturnPct,
    paramBreakRatePct,
    feesOverGrossPct,
    usesMlAdapter: strategyKey === "SURF_PULSE_ML",
  });

  const gradeRes = computeGrade({
    gates,
    stressSurvivedAll,
    ruinObserved,
    paramBreakRatePct: paramBreakRatePct ?? 100,
    oosReturnPct: oosSumReturnPct,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
  });

  /* ── Phase 9: suggestion engine ── */
  report(89, "suggestion");
  const candidates = [];
  const pushCandidate = (label, cfgPatch, res) => {
    const m = res?.metrics;
    if (!m) return;
    const rs = rMultipleStats(res.trades);
    const cMc = monteCarloBootstrap(rs.rValues, {
      paths: 1500,
      riskFrac: Math.max(0.0001, Number(cfgPatch?.riskPerTrade ?? seedRiskPct) / 100),
      ruinDrawdownPct: 50,
    });
    candidates.push({
      label,
      cfgPatch: cfgPatch ?? {},
      totalReturnPct: m.totalReturnPct ?? 0,
      maxDrawdownPct: m.maxDrawdownPct ?? 100,
      profitFactor: m.profitFactor ?? null,
      trades: m.totalTrades ?? 0,
      sharpe: m.sharpe ?? 0,
      mcP5ReturnPct: cMc.insufficient ? -1 : cMc.p5ReturnPct,
      riskOfRuinPct: cMc.insufficient ? 100 : cMc.riskOfRuinPct,
    });
  };
  pushCandidate("Seed config (as tested)", {}, baseline);

  if (strategyKey === "SUPERTREND_ELITE" || strategyKey === "UNIFIED_ELITE") {
    const autoVariants = [
      {
        label: "Auto-calibrate + ADX sep",
        patch: { eliteStAutoCalibrate: true, eliteStHtf1hSepMode: "ADX", eliteStAutoBracketMode: "ATR" },
      },
      {
        label: "Auto-calibrate + PERCENTILE sep",
        patch: { eliteStAutoCalibrate: true, eliteStHtf1hSepMode: "PERCENTILE", eliteStAutoBracketMode: "ATR" },
      },
      {
        label: "Auto-calibrate + CALIBRATED sep",
        patch: { eliteStAutoCalibrate: true, eliteStHtf1hSepMode: "CALIBRATED", eliteStAutoBracketMode: "ATR" },
      },
    ];
    for (let i = 0; i < autoVariants.length; i++) {
      checkCancel();
      const v = autoVariants[i];
      const res = await simulateVariant(ctx, { cfgPatch: v.patch });
      pushCandidate(v.label, v.patch, res);
      report(89 + ((i + 1) / autoVariants.length) * 4, "suggestion");
    }
  }

  const riskVariants = [0.5, 0.75, 1.5]
    .map((mult) => Math.round(seedRiskPct * mult * 100) / 100)
    .filter((r) => r >= 0.25 && r !== seedRiskPct);
  for (let i = 0; i < riskVariants.length; i++) {
    checkCancel();
    const r = riskVariants[i];
    const res = await simulateVariant(ctx, { cfgPatch: { riskPerTrade: r } });
    pushCandidate(`Risk ${r}% per trade`, { riskPerTrade: r }, res);
    report(89 + ((i + 1) / riskVariants.length) * 8, "suggestion");
  }
  const best = pickBestCandidate(candidates, SAFETY_LIMITS);
  const suggestion = {
    safetyLimits: SAFETY_LIMITS,
    candidates: candidates
      .slice()
      .sort((a, b) => b.totalReturnPct - a.totalReturnPct)
      .map(({ label, cfgPatch, totalReturnPct, maxDrawdownPct, profitFactor, trades, sharpe, mcP5ReturnPct, riskOfRuinPct }) => ({
        label,
        cfgPatch,
        totalReturnPct,
        maxDrawdownPct,
        profitFactor,
        trades,
        sharpe,
        mcP5ReturnPct,
        riskOfRuinPct,
        withinLimits:
          maxDrawdownPct <= SAFETY_LIMITS.maxDrawdownPct &&
          mcP5ReturnPct > SAFETY_LIMITS.mcP5ReturnPct &&
          riskOfRuinPct < SAFETY_LIMITS.riskOfRuinPct,
      })),
    best: best
      ? {
          label: best.label,
          cfgPatch: best.cfgPatch,
          metrics: {
            totalReturnPct: best.totalReturnPct,
            maxDrawdownPct: best.maxDrawdownPct,
            profitFactor: best.profitFactor,
            sharpe: best.sharpe,
            trades: best.trades,
            mcP5ReturnPct: best.mcP5ReturnPct,
            riskOfRuinPct: best.riskOfRuinPct,
          },
        }
      : null,
    note: best
      ? null
      : "No tested configuration satisfied the safety limits — do not deploy as-is",
    instanceConfig: instanceSafetyOverlay({ ...cfg, ...(best?.cfgPatch ?? {}) }),
    coinSuitability: gradeCoinSuitability({
      grade: gradeRes.grade,
      oosReturnPct: oosSumReturnPct,
      mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
      maxDrawdownPct: baseM?.maxDrawdownPct ?? 100,
    }),
    recommendedSepMode:
      best?.cfgPatch?.eliteStHtf1hSepMode ??
      (cfg.eliteStAutoCalibrate === true ? cfg.eliteStHtf1hSepMode ?? "ADX" : cfg.eliteStHtf1hSepMode ?? "FIXED"),
  };

  /* ── persist ── */
  report(99, "persisting");
  await progressChain;
  const reportJson = {
    engineVersion: BACKTEST_ENGINE_VERSION,
    seedRunId: String(test.seed_run_id),
    strategyKey,
    symbols,
    isPortfolio,
    timeframe: tf,
    window: { from: windowFrom, to: windowTo, bars: primaryCandles.length, note: portfolioWindowNote },
    baseline: { metrics: slim(baseM), reproducibility },
    walkForward,
    monteCarlo,
    sensitivity,
    costStress,
    feesOverGrossPct,
    stress,
    stressSurvivedAll,
    gates,
    fidelity,
    grade: gradeRes,
  };

  await finalizeTest(testId, {
    report: reportJson,
    grade: gradeRes.grade,
    fidelityScore: fidelity.score,
    suggestion,
  });
}
