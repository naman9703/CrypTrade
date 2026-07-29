#!/usr/bin/env node
/**
 * Re-run backtest with full worker parity for an existing run's frozen config.
 * Usage: node scripts/repro-backtest-run.mjs [runId]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const runIdArg = process.argv[2] || "e5a6f1d4-a58e-4241-bf1e-85d449cdaeac";

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { query } = await import("../src/db/query.js");

function pickBotCfg(snapshot, fallback) {
  if (snapshot?.bot && typeof snapshot.bot === "object") return { ...snapshot.bot };
  if (snapshot && typeof snapshot === "object" && !snapshot.bot) return { ...snapshot };
  const fb = fallback?.bot && typeof fallback.bot === "object" ? fallback.bot : fallback;
  return fb && typeof fb === "object" ? { ...fb } : {};
}

function pickStrategyKey(cfg, engineType) {
  const s = String(cfg?.manualStrategy ?? engineType ?? "").toUpperCase();
  if (s) return s;
  return "SUPERTREND_ELITE";
}

const r = await query(
  `SELECT br.*, sv.cfg_raw AS strategy_cfg_raw
     FROM backtest_runs br
     JOIN strategy_versions sv ON sv.id = br.strategy_version_id
    WHERE br.id = $1`,
  [runIdArg],
);
const run = r.rows[0];
if (!run) {
  console.error("run not found:", runIdArg);
  process.exit(1);
}

const symbol = String(run.symbol);
const tf = String(run.timeframe);
const fromMs = new Date(run.start_date).getTime();
const toMs = new Date(run.end_date).getTime();
const startingUsdt = Number(run.initial_capital);
let cfg = pickBotCfg(run.config_snapshot, run.strategy_cfg_raw);

try {
  const { stripRuntimePollutionFromBot, mergeMissingSignalBrainBot, sanitizeSignalBrainCfgRaw } =
    await import("../src/lib/strategySignalBrain.js");
  const { sanitizeCfgForStrategy } = await import("../src/strategy/strategyConfigProfile.js");
  stripRuntimePollutionFromBot(cfg);
  if (run.strategy_cfg_raw && typeof run.strategy_cfg_raw === "object") {
    const versionBrain = sanitizeSignalBrainCfgRaw(run.strategy_cfg_raw, { hydrate: true }).bot ?? {};
    mergeMissingSignalBrainBot(cfg, versionBrain);
  }
  const stratKey = String(cfg.manualStrategy ?? "").toUpperCase();
  Object.assign(cfg, sanitizeCfgForStrategy(stratKey, cfg, { phase: "runtime" }));
} catch {
  /* optional */
}

try {
  const { materializeIntradayEngineCfgSync } = await import("../src/strategy/presets/srIntradayOptimized.js");
  const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
  const { ensureBacktestMarketMode } = await import("../src/lib/strategyInstanceSplit.js");
  const { normalizeEliteStRunCfg } = await import("../src/strategy/supertrendElite.js");
  const stratEarly = String(cfg.manualStrategy ?? "").toUpperCase();
  if (stratEarly === "SITUATION_INTRADAY") {
    const { resolveSituationRouterCfg } = await import("../src/strategy/situationIntraday.js");
    cfg = resolveSituationRouterCfg(cfg);
    cfg._intradayEngineMaterialized = true;
  } else if (stratEarly === "CRT_TBS") {
    const { resolveCrtTbsCfg } = await import("../src/strategy/crtTbsIntraday.js");
    cfg = resolveCrtTbsCfg(cfg);
  } else if (stratEarly === "LIQ_CASCADE") {
    const { resolveLiqCascadeCfg } = await import("../src/strategy/liqCascadeIntraday.js");
    cfg = resolveLiqCascadeCfg(cfg);
    cfg._intradayEngineMaterialized = true;
  } else if (stratEarly === "SCALP_MR") {
    const { resolveScalpMrCfg } = await import("../src/strategy/scalpMr.js");
    cfg = resolveScalpMrCfg(cfg);
    cfg._intradayEngineMaterialized = true;
  } else if (stratEarly === "TOKYO_SESSION") {
    const { resolveTokyoSessionCfg } = await import("../src/strategy/tokyoSessionIntraday.js");
    cfg = resolveTokyoSessionCfg(cfg);
    cfg._intradayEngineMaterialized = true;
  } else if (stratEarly === "SUPERTREND_ELITE" || stratEarly === "UNIFIED_ELITE" || stratEarly === "LIQUIDITY_MAP") {
    cfg._intradayEngineMaterialized = true;
  } else if (stratEarly === "SR_INTRADAY" || stratEarly === "INTRADAY_PRO" || !cfg._intradayEngineMaterialized) {
    cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
    cfg._intradayEngineMaterialized = true;
  }
  cfg = ensureBacktestMarketMode(cfg);
  const strat = String(cfg.manualStrategy ?? "").toUpperCase();
  if (strat === "SUPERTREND_ELITE" || strat === "UNIFIED_ELITE") {
    Object.assign(cfg, normalizeEliteStRunCfg(cfg));
  }
} catch {
  /* optional */
}

if (process.env.LIQ_PARTIAL_FRAC != null) {
  const v = Number(process.env.LIQ_PARTIAL_FRAC);
  if (Number.isFinite(v)) {
    cfg.liqMapPartialFrac = v;
    cfg.intradayLiqPartialFrac = v;
  }
}
if (process.env.LIQ_DEAD_BARS != null) {
  const v = Number(process.env.LIQ_DEAD_BARS);
  if (Number.isFinite(v)) cfg.liqMapDeadTradeExitBars = v;
}
if (process.env.LIQ_DEAD_MIN_MFE_R != null) {
  const v = Number(process.env.LIQ_DEAD_MIN_MFE_R);
  if (Number.isFinite(v)) cfg.liqMapDeadTradeMinMfeR = v;
}
if (process.env.LIQ_DEAD_MAX_LOSS_R != null) {
  const v = Number(process.env.LIQ_DEAD_MAX_LOSS_R);
  if (Number.isFinite(v)) cfg.liqMapDeadTradeMaxLossR = v;
}
if (process.env.LIQ_TRAIL_ST_PERIOD != null) {
  const v = Number(process.env.LIQ_TRAIL_ST_PERIOD);
  if (Number.isFinite(v)) {
    cfg.liqMapTrailStPeriod = v;
    cfg.supertrendPeriod = v;
  }
}
if (process.env.LIQ_TRAIL_ST_MULT != null) {
  const v = Number(process.env.LIQ_TRAIL_ST_MULT);
  if (Number.isFinite(v)) {
    cfg.liqMapTrailStMult = v;
    cfg.supertrendMultiplier = v;
  }
}
if (process.env.LIQ_MAX_HOLD_BARS != null) {
  const v = Number(process.env.LIQ_MAX_HOLD_BARS);
  if (Number.isFinite(v)) {
    cfg.liqMapMaxHoldBars = v;
    cfg.intradayLiqMaxHoldBars = v;
  }
}
if (process.env.LIQ_BE_AFTER_PARTIAL != null) {
  const enabled = process.env.LIQ_BE_AFTER_PARTIAL !== "0";
  cfg.liqMapBreakevenAfterPartial = enabled;
  cfg.intradayLiqBreakevenAfterPartial = enabled;
}
if (process.env.LIQ_NORM_THRESH != null) cfg.liqMapNormalizeThresholds = process.env.LIQ_NORM_THRESH !== "0";
if (process.env.LIQ_SWEEP_ATR_FRAC != null) {
  const v = Number(process.env.LIQ_SWEEP_ATR_FRAC);
  if (Number.isFinite(v)) cfg.liqMapSweepAtrFrac = v;
}
if (process.env.LIQ_EQUAL_ATR_FRAC != null) {
  const v = Number(process.env.LIQ_EQUAL_ATR_FRAC);
  if (Number.isFinite(v)) cfg.liqMapEqualTolAtrFrac = v;
}
if (process.env.LIQ_AUTO_CAL != null) cfg.liqMapAutoCalibrate = process.env.LIQ_AUTO_CAL !== "0";
if (process.env.LIQ_AUTO_PROFILE_BARS != null) {
  const v = Number(process.env.LIQ_AUTO_PROFILE_BARS);
  if (Number.isFinite(v)) cfg.liqMapAutoProfileBars = v;
}
if (process.env.LIQ_QUALITY_GATE != null) cfg.liqMapQualityGate = process.env.LIQ_QUALITY_GATE !== "0";
if (process.env.LIQ_QUALITY_GATE_MODE != null) cfg.liqMapQualityGateMode = String(process.env.LIQ_QUALITY_GATE_MODE).toUpperCase();
if (process.env.LIQ_SOFT_GATE_BAND != null) {
  const v = Number(process.env.LIQ_SOFT_GATE_BAND);
  if (Number.isFinite(v)) cfg.liqMapSoftGateScoreBand = v;
}
if (process.env.LIQ_QUALITY_AUTO != null) cfg.liqMapQualityAuto = process.env.LIQ_QUALITY_AUTO !== "0";
if (process.env.LIQ_MIN_QUALITY != null) {
  const v = Number(process.env.LIQ_MIN_QUALITY);
  if (Number.isFinite(v)) cfg.liqMapMinQualityScore = v;
}
if (process.env.LIQ_ENTRY_MODEL != null) cfg.liqMapEntryModel = String(process.env.LIQ_ENTRY_MODEL).toUpperCase();
if (process.env.LIQ_HTF_POOL_TFS != null) cfg.liqMapHtfPoolTfs = String(process.env.LIQ_HTF_POOL_TFS);
if (process.env.LIQ_HTF_LOOKBACK != null) {
  const v = Number(process.env.LIQ_HTF_LOOKBACK);
  if (Number.isFinite(v)) cfg.liqMapHtfLookbackBars = v;
}
if (process.env.LIQ_HTF_SWING_LEFT != null) {
  const v = Number(process.env.LIQ_HTF_SWING_LEFT);
  if (Number.isFinite(v)) cfg.liqMapHtfSwingLeft = v;
}
if (process.env.LIQ_HTF_SWING_RIGHT != null) {
  const v = Number(process.env.LIQ_HTF_SWING_RIGHT);
  if (Number.isFinite(v)) cfg.liqMapHtfSwingRight = v;
}
if (process.env.LIQ_HTF_EQUAL_TOUCHES != null) {
  const v = Number(process.env.LIQ_HTF_EQUAL_TOUCHES);
  if (Number.isFinite(v)) cfg.liqMapHtfEqualMinTouches = v;
}
if (process.env.LIQ_DAILY_WEEKLY_POOLS != null) cfg.liqMapUseDailyWeeklyPools = process.env.LIQ_DAILY_WEEKLY_POOLS !== "0";
if (process.env.LIQ_TRENDLINE_POOLS != null) cfg.liqMapUseTrendlinePools = process.env.LIQ_TRENDLINE_POOLS !== "0";
if (process.env.LIQ_ENTRY_TIMING != null) cfg.liqMapEntryTiming = String(process.env.LIQ_ENTRY_TIMING).toUpperCase();
if (process.env.LIQ_REQUIRE_MSS != null) cfg.liqMapRequireMss = process.env.LIQ_REQUIRE_MSS !== "0";
if (process.env.LIQ_REQUIRE_CHOCH != null) cfg.liqMapRequireChoch = process.env.LIQ_REQUIRE_CHOCH !== "0";
if (process.env.LIQ_REQUIRE_RETRACE != null) cfg.liqMapRequireRetrace = process.env.LIQ_REQUIRE_RETRACE !== "0";
if (process.env.LIQ_RECLAIM_HOLD != null) cfg.liqMapRequireReclaimHold = process.env.LIQ_RECLAIM_HOLD !== "0";
if (process.env.LIQ_STRUCT_LOOKBACK != null) {
  const v = Number(process.env.LIQ_STRUCT_LOOKBACK);
  if (Number.isFinite(v)) cfg.liqMapStructureLookbackBars = v;
}
if (process.env.LIQ_MSS_MAX_AFTER_SWEEP != null) {
  const v = Number(process.env.LIQ_MSS_MAX_AFTER_SWEEP);
  if (Number.isFinite(v)) cfg.liqMapMssMaxBarsAfterSweep = v;
}
if (process.env.LIQ_ENTRY_ZONE != null) cfg.liqMapEntryZoneMode = String(process.env.LIQ_ENTRY_ZONE).toUpperCase();
if (process.env.LIQ_MAX_OPP_RR != null) {
  const v = Number(process.env.LIQ_MAX_OPP_RR);
  if (Number.isFinite(v)) cfg.liqMapMaxOpposingRr = v;
}
if (process.env.LIQ_FVG_ENTRY != null) cfg.liqMapFvgEntryMode = String(process.env.LIQ_FVG_ENTRY).toUpperCase();
if (process.env.LIQ_MSS_DISPLACEMENT != null) cfg.liqMapMssRequireDisplacement = process.env.LIQ_MSS_DISPLACEMENT !== "0";
if (process.env.LIQ_DISP_BODY_MULT != null) {
  const v = Number(process.env.LIQ_DISP_BODY_MULT);
  if (Number.isFinite(v)) cfg.liqMapDisplacementBodyMult = v;
}
if (process.env.LIQ_DISP_ATR_MULT != null) {
  const v = Number(process.env.LIQ_DISP_ATR_MULT);
  if (Number.isFinite(v)) cfg.liqMapDisplacementAtrMult = v;
}
if (process.env.LIQ_FVG_MIN_GAP != null) {
  const v = Number(process.env.LIQ_FVG_MIN_GAP);
  if (Number.isFinite(v)) cfg.liqMapFvgMinGapPct = v;
}
if (process.env.LIQ_STRICT_PD_ZONE != null) cfg.liqMapStrictPdZone = process.env.LIQ_STRICT_PD_ZONE !== "0";
if (process.env.LIQ_OB_DISP_ATR != null) {
  const v = Number(process.env.LIQ_OB_DISP_ATR);
  if (Number.isFinite(v)) cfg.liqMapObMinDisplacementAtr = v;
}
if (process.env.LIQ_SL_MODE != null) cfg.liqMapSlMode = String(process.env.LIQ_SL_MODE).toUpperCase();
if (process.env.LIQ_TRAIL_MODE != null) cfg.liqMapTrailMode = String(process.env.LIQ_TRAIL_MODE).toUpperCase();
if (process.env.LIQ_ATR_SL != null) {
  const v = Number(process.env.LIQ_ATR_SL);
  if (Number.isFinite(v)) cfg.liqMapAtrSlMult = v;
}
if (process.env.LIQ_SL_BUFFER_PCT != null) {
  const v = Number(process.env.LIQ_SL_BUFFER_PCT);
  if (Number.isFinite(v)) cfg.liqMapSlBufferPct = v;
}
if (process.env.LIQ_SL_BUFFER_ATR != null) {
  const v = Number(process.env.LIQ_SL_BUFFER_ATR);
  if (Number.isFinite(v)) cfg.liqMapSlBufferAtrFrac = v;
}
if (process.env.LIQ_SL_REGIME != null) cfg.liqMapSlRegimeAdjust = process.env.LIQ_SL_REGIME !== "0";
if (process.env.LIQ_SL_REGIME_LOW != null) {
  const v = Number(process.env.LIQ_SL_REGIME_LOW);
  if (Number.isFinite(v)) cfg.liqMapSlRegimeLowMult = v;
}
if (process.env.LIQ_SL_REGIME_HIGH != null) {
  const v = Number(process.env.LIQ_SL_REGIME_HIGH);
  if (Number.isFinite(v)) cfg.liqMapSlRegimeHighMult = v;
}
if (process.env.LIQ_TRAIL_ATR_HWM != null) {
  const v = Number(process.env.LIQ_TRAIL_ATR_HWM);
  if (Number.isFinite(v)) cfg.liqMapTrailAtrHwmMult = v;
}
if (process.env.LIQ_TRAIL_MFE_GIVEBACK != null) {
  const v = Number(process.env.LIQ_TRAIL_MFE_GIVEBACK);
  if (Number.isFinite(v)) cfg.liqMapTrailMfeGiveback = v;
}
if (process.env.LIQ_TRAIL_MFE_MIN_R != null) {
  const v = Number(process.env.LIQ_TRAIL_MFE_MIN_R);
  if (Number.isFinite(v)) cfg.liqMapTrailMfeMinR = v;
}
if (process.env.LIQ_TRAIL_STEP_ATR != null) {
  const v = Number(process.env.LIQ_TRAIL_STEP_ATR);
  if (Number.isFinite(v)) cfg.liqMapTrailStepAtrMult = v;
}
if (process.env.LIQ_TRAIL_MERGE_ST != null) cfg.liqMapTrailMergeSt = process.env.LIQ_TRAIL_MERGE_ST !== "0";
if (process.env.LIQ_DYN_RUNNER_MAX_TP_RR != null) {
  const v = Number(process.env.LIQ_DYN_RUNNER_MAX_TP_RR);
  if (Number.isFinite(v)) cfg.liqMapDynamicRunnerMaxTpRr = v;
}
if (process.env.LIQ_DYN_RUNNER_MIN_TP_RR != null) {
  const v = Number(process.env.LIQ_DYN_RUNNER_MIN_TP_RR);
  if (Number.isFinite(v)) cfg.liqMapDynamicRunnerMinTpRr = v;
}
if (process.env.LIQ_PROJ_TP_ATR != null) {
  const v = Number(process.env.LIQ_PROJ_TP_ATR);
  if (Number.isFinite(v)) cfg.liqMapProjectedTpAtrMult = v;
}
if (process.env.LIQ_PROJ_TP_RANGE != null) {
  const v = Number(process.env.LIQ_PROJ_TP_RANGE);
  if (Number.isFinite(v)) cfg.liqMapProjectedTpRangeMult = v;
}
if (process.env.LIQ_PROJ_TP_LOOKBACK != null) {
  const v = Number(process.env.LIQ_PROJ_TP_LOOKBACK);
  if (Number.isFinite(v)) cfg.liqMapProjectionLookbackBars = v;
}
if (process.env.LIQ_DYN_EXIT != null) cfg.liqMapDynamicExitPolicy = process.env.LIQ_DYN_EXIT !== "0";
if (process.env.LIQ_DYN_EXIT_Q_HI != null) {
  const v = Number(process.env.LIQ_DYN_EXIT_Q_HI);
  if (Number.isFinite(v)) cfg.liqMapDynExitQualityHi = v;
}
if (process.env.LIQ_DYN_EXIT_Q_MID != null) {
  const v = Number(process.env.LIQ_DYN_EXIT_Q_MID);
  if (Number.isFinite(v)) cfg.liqMapDynExitQualityMid = v;
}
if (process.env.LIQ_DYN_EXIT_RR_HI != null) {
  const v = Number(process.env.LIQ_DYN_EXIT_RR_HI);
  if (Number.isFinite(v)) cfg.liqMapDynExitRrHi = v;
}
if (process.env.LIQ_DYN_EXIT_RR_MID != null) {
  const v = Number(process.env.LIQ_DYN_EXIT_RR_MID);
  if (Number.isFinite(v)) cfg.liqMapDynExitRrMid = v;
}
if (process.env.LIQ_DYN_EXIT_PARTIAL_HI != null) {
  const v = Number(process.env.LIQ_DYN_EXIT_PARTIAL_HI);
  if (Number.isFinite(v)) cfg.liqMapDynExitPartialHi = v;
}
if (process.env.LIQ_DYN_EXIT_PARTIAL_MID != null) {
  const v = Number(process.env.LIQ_DYN_EXIT_PARTIAL_MID);
  if (Number.isFinite(v)) cfg.liqMapDynExitPartialMid = v;
}
if (process.env.LIQ_DYN_EXIT_PARTIAL_BASE != null) {
  const v = Number(process.env.LIQ_DYN_EXIT_PARTIAL_BASE);
  if (Number.isFinite(v)) cfg.liqMapDynExitPartialBase = v;
}
if (process.env.LIQ_DYN_EXIT_TRAIL_ATR_HI != null) {
  const v = Number(process.env.LIQ_DYN_EXIT_TRAIL_ATR_HI);
  if (Number.isFinite(v)) cfg.liqMapDynExitTrailAtrHi = v;
}
if (process.env.LIQ_DYN_EXIT_TRAIL_ATR_MID != null) {
  const v = Number(process.env.LIQ_DYN_EXIT_TRAIL_ATR_MID);
  if (Number.isFinite(v)) cfg.liqMapDynExitTrailAtrMid = v;
}
if (process.env.LIQ_DYN_EXIT_TRAIL_ATR_BASE != null) {
  const v = Number(process.env.LIQ_DYN_EXIT_TRAIL_ATR_BASE);
  if (Number.isFinite(v)) cfg.liqMapDynExitTrailAtrBase = v;
}
if (process.env.LIQ_DYN_EXIT_WEAK_TP1_RR != null) {
  const v = Number(process.env.LIQ_DYN_EXIT_WEAK_TP1_RR);
  if (Number.isFinite(v)) cfg.liqMapDynExitWeakTp1Rr = v;
}
if (process.env.LIQ_STRUCT_TP1_RR != null) {
  const v = Number(process.env.LIQ_STRUCT_TP1_RR);
  if (Number.isFinite(v)) cfg.liqMapStructuralTp1Rr = v;
}

const costModelOverride = run.cost_model && typeof run.cost_model === "object" ? run.cost_model : {};
const gateMode = String(run.gate_mode || "off") === "approx" ? "approx" : "off";
const isFutures = String(cfg?.marketMode || cfg?.market || "").toUpperCase() === "FUTURES";
const market = isFutures ? "futures" : "spot";
const strategyKey = pickStrategyKey(cfg, run.engine_type);

const { readCandles, ensureKlines } = await import("../src/backtest/data/klineIngest.js");
const { ensureFunding, readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { getCoverage } = await import("../src/backtest/data/dataCoverage.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");

clearIntradayAdapterCache();
await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market }).catch(() => {});
if (isFutures) await ensureFunding(symbol, { from: fromMs, to: toMs }).catch(() => {});

const candles = await readCandles(symbol, tf, fromMs, toMs, { market });
if (!candles.length) {
  console.error("no candles");
  process.exit(1);
}

const stratKey = String(cfg.manualStrategy ?? "").toUpperCase();
if (stratKey === "SUPERTREND_ELITE" || stratKey === "UNIFIED_ELITE") {
  const { prepareEliteRunCfg } = await import("../src/strategy/supertrendElite.js");
  cfg = prepareEliteRunCfg(cfg, symbol, candles);
}

const fundingRates = isFutures ? await readFundingRates(symbol, fromMs, toMs).catch(() => []) : [];
const adapters = await buildBacktestAdapters({ strategyKey, cfg, symbol, tf, candles, fromMs }).catch(() => ({}));

let trailMicro = null;
const futuresTrailMode = String(cfg?.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
const trailEnabled = cfg?.trailingStopLossAuto === true && isFutures && futuresTrailMode !== "OFF";
if (trailEnabled) {
  const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
  trailMicro = await buildTrailMicroContext({ symbol, fromMs, toMs, cfg, trailEnabled });
}

const sim = await runSimulation({
  strategyKey,
  candles,
  cfg,
  costModelOverride,
  gateMode,
  fundingRates,
  startingUsdt,
  timeframe: tf,
  symbol,
  adapters,
  trailMicro,
});

const repro = computeAllMetrics({
  trades: sim.trades,
  equityCurve: sim.equityCurve,
  tf,
  startingEquity: startingUsdt,
});

const stored = run.metrics && typeof run.metrics === "object" ? run.metrics : {};
const trQ = await query(
  `SELECT COUNT(*)::int AS n, SUM(net_pnl)::float AS sum_net
     FROM backtest_trades WHERE backtest_run_id = $1`,
  [runIdArg],
);

const cov = await getCoverage(symbol, tf, { from: fromMs, to: toMs }).catch(() => ({}));

console.log(
  JSON.stringify(
    {
      runId: runIdArg,
      window: {
        from: new Date(fromMs).toISOString().slice(0, 10),
        to: new Date(toMs).toISOString().slice(0, 10),
        candles: candles.length,
        markCoveragePct: cov.coveragePct ?? null,
      },
      stored: {
        totalReturnPct: stored.totalReturnPct,
        maxDrawdownPct: stored.maxDrawdownPct,
        totalTrades: stored.totalTrades,
        finalEquity: stored.finalEquity,
        winRate: stored.winRate,
        profitFactor: stored.profitFactor,
      },
      reproduced: {
        totalReturnPct: repro.totalReturnPct,
        maxDrawdownPct: repro.maxDrawdownPct,
        totalTrades: repro.totalTrades,
        finalEquity: repro.finalEquity,
        winRate: repro.winRate,
        profitFactor: repro.profitFactor,
      },
      dbTrades: { count: trQ.rows[0].n, sumNetPnl: trQ.rows[0].sum_net },
      reproTrades: { count: sim.trades.length, sumNetPnl: sim.trades.reduce((a, t) => a + Number(t.netPnl || 0), 0) },
      trailMicro: trailMicro != null,
      match:
        Math.abs(Number(stored.totalReturnPct) - repro.totalReturnPct) < 0.01 &&
        Number(stored.totalTrades) === repro.totalTrades,
      tradeMismatches: (() => {
        const out = [];
        for (let i = 0; i < Math.min(sim.trades.length, 30); i++) {
          const s = sim.trades[i];
          if (Math.abs(Number(s.netPnl) - Number(trQ.rows[0]?.net_pnl)) > 0.02) {
            /* filled below from db */
          }
        }
        return out;
      })(),
    },
    null,
    2,
  ),
);

// Per-trade compare with DB
const dbRows = await query(
  `SELECT trade_number, net_pnl, exit_reason, signal_context->>'trailTierLabel' AS tier
     FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number`,
  [runIdArg],
);
let tradeDiffs = 0;
for (let i = 0; i < sim.trades.length; i++) {
  const s = sim.trades[i];
  const d = dbRows.rows[i];
  if (!d) continue;
  const pnlOk = Math.abs(Number(s.netPnl) - Number(d.net_pnl)) <= 0.02;
  const reasonOk = String(s.exitReason) === String(d.exit_reason);
  if (!pnlOk || !reasonOk) {
    tradeDiffs++;
    if (tradeDiffs <= 5) {
      console.error(
        `trade #${d.trade_number} stored ${d.exit_reason} ${d.net_pnl} (${d.tier}) vs repro ${s.exitReason} ${s.netPnl?.toFixed?.(4)} step=${s.trailStep}`,
      );
    }
  }
}
console.log("tradeDiffs", tradeDiffs, "/", sim.trades.length);
if (sim.trades.length > dbRows.rows.length) {
  const extra = sim.trades.slice(dbRows.rows.length);
  console.log(
    "extraReproTrades",
    extra.map((t) => ({
      entryTs: t.entryTs,
      exitTs: t.exitTs,
      direction: t.direction,
      netPnl: t.netPnl,
      exitReason: t.exitReason,
    })),
  );
}
console.log(
  "VERDICT:",
  tradeDiffs === 0 && Math.abs(Number(stored.totalReturnPct) - repro.totalReturnPct) < 0.01
    ? "PASS — reproduction matches stored run"
    : "FAIL — reproduction diverges",
);

await closePool();
