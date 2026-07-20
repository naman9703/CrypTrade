/**
 * Backtest worker_thread entry point.
 *
 * Receives `{ runId }` from the parent (via `pool.js`), loads everything it
 * needs (candles, funding rates, strategy snapshot, optional intel-replay
 * inputs), runs the simulator, and persists results. Progress is reported
 * back via `parentPort.postMessage({ type: 'progress', pct })` so the HTTP
 * layer can forward it to clients over the existing `wsHub`.
 *
 * The worker manages its own DB pool; it does NOT share the parent's
 * connection pool because pg `Pool` objects can't be cloned across threads.
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { parentPort, workerData } from "worker_threads";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../../../.env"), override: false });

const { initPool, closePool } = await import("../../db/pool.js");
const { query } = await import("../../db/query.js");
const { readCandles, ensureKlines } = await import("../data/klineIngest.js");
const { ensureFunding, readFundingRates } = await import("../data/fundingIngest.js");
const { ensureOpenInterest } = await import("../data/openInterestIngest.js");
const { getCoverage } = await import("../data/dataCoverage.js");
const { runSimulation } = await import("./runner.js");
const { computeAllMetrics, attachWalkForwardMetrics } = await import("./metrics.js");
const { finalizeRun, failRun, markRunning, updateProgress, cancelRun } = await import("./persistence.js");
const { buildIntelligenceReplay } = await import("./intelligenceReplay.js").catch(() => ({
  buildIntelligenceReplay: null,
}));
const { buildBacktestAdapters } = await import("./signals/baselines.js").catch(() => ({
  buildBacktestAdapters: null,
}));

let cancelFlag = false;
const persistent = workerData?.persistent === true;

async function applyBacktestBracketCap(cfg, symbol) {
  if (String(process.env.BACKTEST_SIMULATE_BRACKET_CAP ?? "0") !== "1") return cfg;
  const lev = Math.max(1, Number(cfg?.futuresLeverage ?? cfg?.leverage ?? 10));
  const { fetchLeverageBracketNotionalCap } = await import("../../lib/binanceUsdMBracketFetch.js");
  const cap = await fetchLeverageBracketNotionalCap(symbol, lev, process.env.BACKTEST_BRACKET_TRADING_MODE || "BINANCE_DEMO_API");
  if (cap != null && cap > 0) return { ...cfg, backtestBracketNotionalCap: cap };
  return cfg;
}

parentPort?.on("message", (msg) => {
  if (msg && msg.type === "cancel") cancelFlag = true;
});

/** Strategy-test jobs ride the same pool queue with a prefixed job id. */
const STRATEGY_TEST_PREFIX = "strategy-test:";

async function runStrategyTestOnce(jobId, testId) {
  const { executeStrategyTest, failTest, cancelTest } = await import("./strategyTest.js");
  try {
    await executeStrategyTest({
      testId,
      onProgress: (pct) => {
        parentPort?.postMessage({ type: "progress", runId: jobId, pct });
      },
      shouldCancel: () => cancelFlag,
    });
    if (cancelFlag) await cancelTest(testId);
    parentPort?.postMessage({ type: "complete", runId: jobId });
  } catch (err) {
    const msg = String(err?.message || err);
    if (cancelFlag || msg === "cancelled") {
      await cancelTest(testId).catch(() => {});
      parentPort?.postMessage({ type: "complete", runId: jobId });
      return;
    }
    console.error("[backtest:worker] strategy test failed", err?.stack || err);
    await failTest(testId, err).catch(() => {});
    parentPort?.postMessage({ type: "failed", runId: jobId, error: msg });
  }
}

async function runOnce(runId) {
  cancelFlag = false;
  const jobId = String(runId);
  if (jobId.startsWith(STRATEGY_TEST_PREFIX)) {
    await runStrategyTestOnce(jobId, jobId.slice(STRATEGY_TEST_PREFIX.length));
    return;
  }
  try {
    await execute({ runId });
    parentPort?.postMessage({ type: "complete", runId });
  } catch (err) {
    console.error("[backtest:worker] failed", err?.stack || err);
    try {
      await failRun(runId, err);
    } catch {
      /* ignore */
    }
    parentPort?.postMessage({ type: "failed", runId, error: String(err?.message || err) });
  }
}

try {
  await initPool({
    info: () => {},
    warn: () => {},
    error: (...a) => console.error("[backtest:worker]", ...a),
  });
} catch (err) {
  console.error("[backtest:worker] initPool failed", err?.stack || err);
  parentPort?.postMessage({
    type: "failed",
    runId: workerData.runId,
    error: String(err?.message || err),
  });
  process.exit(1);
}

if (persistent) {
  parentPort?.on("message", (msg) => {
    if (msg?.type === "run" && msg.runId) {
      runOnce(String(msg.runId)).catch((err) => {
        parentPort?.postMessage({
          type: "failed",
          runId: msg.runId,
          error: String(err?.message || err),
        });
      });
    }
  });
  parentPort?.postMessage({ type: "ready" });
} else {
  try {
    await runOnce(workerData.runId);
  } finally {
    try {
      await closePool();
    } catch {
      /* ignore */
    }
  }
}

async function execute({ runId }) {
  if (!runId) throw new Error("worker:missing_runId");

  const r = await query(
    `SELECT br.*, sv.cfg_raw AS strategy_cfg_raw, sv.strategy_id, sv.id AS strategy_version_id
       FROM backtest_runs br
       JOIN strategy_versions sv ON sv.id = br.strategy_version_id
      WHERE br.id = $1`,
    [runId],
  );
  const run = r.rows[0];
  if (!run) throw new Error("worker:run_not_found");
  if (run.status === "cancelled") return;

  await markRunning(runId);
  parentPort?.postMessage({ type: "progress", runId, pct: 0 });
  void updateProgress(runId, 0).catch(() => {});

  try {
    const { clearIntradayAdapterCache } = await import("./intradayAdapterCache.js");
    clearIntradayAdapterCache();
  } catch {
    /* optional */
  }

  const symbol = String(run.symbol);
  const tf = String(run.timeframe);
  const fromMs = new Date(run.start_date).getTime();
  const toMs = new Date(run.end_date).getTime();
  const startingUsdt = Number(run.initial_capital);
  const snapshotBot = pickBotCfg(run.config_snapshot, run.strategy_cfg_raw);
  const { pickBacktestRunMeta, applyBacktestRunMeta } = await import("./backtestRunMeta.js");
  const backtestRunMeta = pickBacktestRunMeta(snapshotBot);
  let cfg = { ...snapshotBot };
  try {
    const { stripRuntimePollutionFromBot, mergeMissingSignalBrainBot, sanitizeSignalBrainCfgRaw } =
      await import("../../lib/strategySignalBrain.js");
    const { sanitizeCfgForStrategy } = await import("../../strategy/strategyConfigProfile.js");
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
    const { materializeIntradayEngineCfgSync } = await import("../../strategy/presets/srIntradayOptimized.js");
    const { materializeIntradayPanelOnCfg } = await import("../../strategy/intradayPanelKeys.js");
    const { ensureBacktestMarketMode, applyInstanceOperationalToBot } = await import("../../lib/strategyInstanceSplit.js");
    const { normalizeEliteStRunCfg } = await import("../../strategy/supertrendElite.js");
    const { normalizeLiquidityMapRunCfg } = await import("../../strategy/liquidityMapStrategy.js");
    const stratEarly = String(cfg.manualStrategy ?? "").toUpperCase();
    if (stratEarly === "SITUATION_INTRADAY") {
      const { resolveSituationRouterCfg } = await import("../../strategy/situationIntraday.js");
      cfg = resolveSituationRouterCfg(cfg);
      cfg._intradayEngineMaterialized = true;
    } else if (stratEarly === "CRT_TBS") {
      const { resolveCrtTbsCfg } = await import("../../strategy/crtTbsIntraday.js");
      cfg = resolveCrtTbsCfg(cfg);
      cfg._intradayEngineMaterialized = true;
    } else if (stratEarly === "SCALP_MR") {
      const { resolveScalpMrCfg } = await import("../../strategy/scalpMr.js");
      cfg = resolveScalpMrCfg(cfg);
      cfg._intradayEngineMaterialized = true;
    } else if (stratEarly === "TOKYO_SESSION") {
      const { resolveTokyoSessionCfg } = await import("../../strategy/tokyoSessionIntraday.js");
      cfg = resolveTokyoSessionCfg(cfg);
      cfg._intradayEngineMaterialized = true;
    } else if (stratEarly === "SUPERTREND_ELITE" || stratEarly === "UNIFIED_ELITE" || stratEarly === "LIQUIDITY_MAP") {
      // Skip intraday materialization — injects defaults that break strategies with their own adapters.
      cfg._intradayEngineMaterialized = true;
    } else if (stratEarly === "VOLUME_PROFILE") {
      // VP has its own adapter + fillVolumeProfileFreqDefaults — do NOT run LIQ/SMC materialize.
      cfg._intradayEngineMaterialized = true;
    } else if (
      stratEarly === "SR_INTRADAY" ||
      stratEarly === "INTRADAY_PRO" ||
      !cfg._intradayEngineMaterialized
    ) {
      // Always replace cfg — polluted snapshots merge stale SMC/SR keys if we spread onto prior bot.
      cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
      cfg._intradayEngineMaterialized = true;
    }
    if (run.instance_operational_snapshot && typeof run.instance_operational_snapshot === "object") {
      applyInstanceOperationalToBot(cfg, run.instance_operational_snapshot);
    }
    cfg = ensureBacktestMarketMode(cfg);
    const strat = String(cfg.manualStrategy ?? "").toUpperCase();
    if (strat === "SUPERTREND_ELITE" || strat === "UNIFIED_ELITE") {
      Object.assign(cfg, normalizeEliteStRunCfg(cfg));
    } else if (strat === "LIQUIDITY_MAP") {
      Object.assign(cfg, normalizeLiquidityMapRunCfg(cfg));
    }
  } catch (err) {
    console.warn("[backtest:worker] cfg materialize failed:", err?.message || err);
  }
  applyBacktestRunMeta(cfg, backtestRunMeta);
  const costModelOverride = run.cost_model && typeof run.cost_model === "object" ? run.cost_model : {};
  // `gate_mode` is stored at run creation time. Fall back to checking the strategy cfg
  // directly so that old runs or API calls without the UI still activate the replay gate.
  const gateModeFromDb = String(run.gate_mode || "off") === "approx" ? "approx" : "off";
  const gateMode =
    gateModeFromDb === "approx" || cfg?.intelligenceGateEnabled === true ? "approx" : "off";
  const isFutures = String(cfg?.marketMode || cfg?.market || "").toUpperCase() === "FUTURES";
  const market = isFutures ? "futures" : "spot";
  const strategyKey = pickStrategyKey(cfg, run.engine_type);

  const reportPrep = (pct) => {
    parentPort?.postMessage({ type: "progress", runId, pct });
    void updateProgress(runId, pct).catch(() => {});
  };

  const isPortfolio = run.is_portfolio === true;
  const portfolioSymbols =
    isPortfolio && Array.isArray(run.symbols)
      ? run.symbols.map((s) => String(s).toUpperCase()).filter(Boolean)
      : [];
  if (isPortfolio && portfolioSymbols.length >= 2) {
    const wfSplit =
      run.walk_forward_split && typeof run.walk_forward_split === "object" ? run.walk_forward_split : null;
    const portfolioTrainPct =
      wfSplit && Number.isFinite(Number(wfSplit.trainPct))
        ? Math.max(0.1, Math.min(0.9, Number(wfSplit.trainPct)))
        : null;
    await executePortfolio({
      runId,
      run,
      cfg,
      costModelOverride,
      gateMode,
      isFutures,
      market,
      strategyKey,
      symbols: portfolioSymbols,
      fromMs,
      toMs,
      tf,
      startingUsdt,
      trainPct: portfolioTrainPct,
      reportPrep,
    });
    return;
  }

  reportPrep(0.5);
  let candleFromMs = fromMs;
  if (strategyKey === "CRT_TBS") {
    const { crtTbsPadFromMs } = await import("../../strategy/crtTbsIntraday.js");
    candleFromMs = crtTbsPadFromMs(fromMs, tf);
  } else if (strategyKey === "SCALP_MR") {
    const { scalpMrPadFromMs } = await import("../../strategy/scalpMr.js");
    candleFromMs = scalpMrPadFromMs(fromMs, tf);
  } else if (strategyKey === "TOKYO_SESSION") {
    const { tokyoSessionPadFromMs } = await import("../../strategy/tokyoSessionIntraday.js");
    candleFromMs = tokyoSessionPadFromMs(fromMs, tf);
  } else if (strategyKey === "VOLUME_PROFILE") {
    const { volumeProfilePadFromMs } = await import("../../strategy/presets/volumeProfileOptimized.js");
    candleFromMs = volumeProfilePadFromMs(fromMs, tf, cfg);
  }

  const covPre = await getCoverage(symbol, tf, { from: candleFromMs, to: toMs }).catch(() => ({
    coveragePct: null,
  }));
  if (covPre.coveragePct == null || covPre.coveragePct < 98) {
    await ensureKlines(symbol, tf, { from: candleFromMs, to: toMs, market }).catch((err) => {
      console.warn("[backtest:worker] ensureKlines failed:", err?.message || err);
    });
  }
  reportPrep(2);
  if (isFutures) {
    await ensureFunding(symbol, { from: fromMs, to: toMs }).catch((err) => {
      console.warn("[backtest:worker] ensureFunding failed:", err?.message || err);
    });
    await ensureOpenInterest(symbol, { from: fromMs, to: toMs, period: "1h" }).catch((err) => {
      console.warn("[backtest:worker] ensureOpenInterest failed:", err?.message || err);
    });
  }
  reportPrep(3);

  const candles = await readCandles(symbol, tf, candleFromMs, toMs, { market });
  if (!candles.length) throw new Error("worker:no_candles");
  reportPrep(5);

  const stratKey = String(cfg.manualStrategy ?? "").toUpperCase();
  if (stratKey === "SUPERTREND_ELITE" || stratKey === "UNIFIED_ELITE") {
    const { prepareEliteRunCfg } = await import("../../strategy/supertrendElite.js");
    cfg = prepareEliteRunCfg(cfg, symbol, candles);
  } else if (stratKey === "VOLUME_PROFILE") {
    const { fillVolumeProfileFreqDefaults } = await import("../../strategy/presets/volumeProfileOptimized.js");
    cfg = fillVolumeProfileFreqDefaults({ ...cfg, symbol });
  }
  // Warmup candles may precede the run window — never open trades before start_date.
  cfg = { ...cfg, backtestSignalStartMs: fromMs };
  if (isFutures) cfg = await applyBacktestBracketCap(cfg, symbol);

  const fundingRates = isFutures ? await readFundingRates(symbol, fromMs, toMs).catch(() => []) : [];

  const cov = await getCoverage(symbol, tf, { from: fromMs, to: toMs });
  if (cov.coveragePct != null && cov.coveragePct < 99) {
    console.warn(`[backtest:worker] partial coverage ${cov.coveragePct.toFixed(1)}% for ${symbol} ${tf}`);
  }

  let gateFn = null;
  if (gateMode === "approx" && typeof buildIntelligenceReplay === "function") {
    try {
      gateFn = await buildIntelligenceReplay({
        symbol,
        fromMs,
        toMs,
        candles,
        timeframe: tf,
        strictMode: cfg?.intelligenceGateStrict === true,
        highWinRateMode: cfg?.intelligenceGateHighWinRate === true,
      });
    } catch (err) {
      console.warn("[backtest:worker] intelligenceReplay failed:", err?.message || err);
    }
  }

  /** @type {Record<string, Function>} */
  let adapters = {};
  if (typeof buildBacktestAdapters === "function") {
    try {
      reportPrep(8);
      adapters = await buildBacktestAdapters({ strategyKey, cfg, symbol, tf, candles, fromMs });
      reportPrep(12);
    } catch (err) {
      console.warn("[backtest:worker] buildBacktestAdapters failed:", err?.message || err);
    }
  }

  let trailMicro = null;
  const futuresTrailMode = String(cfg?.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
  const trailEnabled =
    cfg?.trailingStopLossAuto === true && isFutures && futuresTrailMode !== "OFF";
  if (trailEnabled) {
    try {
      const { buildTrailMicroContext } = await import("./trailMicroSim.js");
      trailMicro = await buildTrailMicroContext({
        symbol,
        fromMs,
        toMs,
        cfg,
        trailEnabled,
      });
    } catch (err) {
      console.warn("[backtest:worker] trailMicro setup failed:", err?.message || err);
    }
  }

  /** Map simulation 0–100% into ~2–99.9 for prep phase headroom; keep decimals for smooth UI. */
  const onProgress = ({ percent }) => {
    const sim = Math.min(100, Math.max(0, Number(percent)));
    const pct = Math.min(99.9, 2 + (sim / 100) * 97);
    const rounded = Math.round(pct * 10) / 10;
    parentPort?.postMessage({ type: "progress", runId, pct: rounded });
    void updateProgress(runId, rounded).catch(() => {});
  };

  /**
   * Walk-forward: split candles into train (first `trainPct`) and test windows.
   * The simulator runs on the full window once for the published equity curve,
   * but we attach per-window metrics to `metrics.walkForward` so the optimization
   * panel can show train-vs-test consistency without scheduling extra runs.
   */
  const wfSplit = run.walk_forward_split && typeof run.walk_forward_split === "object" ? run.walk_forward_split : null;
  const trainPct = wfSplit && Number.isFinite(Number(wfSplit.trainPct)) ? Math.max(0.1, Math.min(0.9, Number(wfSplit.trainPct))) : null;

  const sim = await runSimulation({
    strategyKey,
    candles,
    cfg,
    costModelOverride,
    gateMode,
    gateFn,
    fundingRates,
    onProgress,
    shouldCancel: () => cancelFlag,
    startingUsdt,
    timeframe: tf,
    symbol,
    adapters,
    trailMicro,
  });

  if (cancelFlag) {
    await cancelRun(runId);
    return;
  }

  let metrics = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf,
    startingEquity: startingUsdt,
  });
  metrics.gateReplay = sim.gateReplay ?? {
    mode: gateMode,
    evaluated: 0,
    pass: 0,
    vetoed: 0,
    sizeScaled: 0,
    noGate: 0,
    avgIntelScore: null,
  };

  metrics = attachWalkForwardMetrics(metrics, {
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    timelineCandles: candles,
    trainPct,
    tf,
    startingEquity: startingUsdt,
  });

  await finalizeRun({
    runId,
    symbol,
    metrics,
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    finalEquity: sim.finalEquity,
    coveragePct: cov.coveragePct,
  });
}

/**
 * Multi-coin portfolio: per-symbol unit sims (equal slice) → shared-account dollar replay.
 */
async function executePortfolio({
  runId,
  run,
  cfg,
  costModelOverride,
  gateMode,
  isFutures,
  market,
  strategyKey,
  symbols,
  fromMs,
  toMs,
  tf,
  startingUsdt,
  trainPct = null,
  reportPrep,
}) {
  const { portfolioSliceReplay, tradesToTimelineEvents } = await import("./portfolioReplay.js");
  const {
    resolvePortfolioPositionSizing,
    resolvePortfolioUnitStart,
    resolvePortfolioUnitSizingMode,
  } = await import("./portfolioPositionSizing.js");
  const { prepareEliteRunCfg } = await import("../../strategy/supertrendElite.js");
  const nCoins = Math.max(1, symbols.length);
  const portfolioSizingMode = resolvePortfolioPositionSizing(cfg);
  const perCoinStart = resolvePortfolioUnitStart({
    startingUsdt,
    coinCount: nCoins,
    mode: portfolioSizingMode,
  });
  const unitSizingMode = resolvePortfolioUnitSizingMode(portfolioSizingMode);

  reportPrep(1);
  let candleFromMs = fromMs;
  if (strategyKey === "CRT_TBS") {
    const { crtTbsPadFromMs } = await import("../../strategy/crtTbsIntraday.js");
    candleFromMs = crtTbsPadFromMs(fromMs, tf);
  } else if (strategyKey === "SCALP_MR") {
    const { scalpMrPadFromMs } = await import("../../strategy/scalpMr.js");
    candleFromMs = scalpMrPadFromMs(fromMs, tf);
  } else if (strategyKey === "TOKYO_SESSION") {
    const { tokyoSessionPadFromMs } = await import("../../strategy/tokyoSessionIntraday.js");
    candleFromMs = tokyoSessionPadFromMs(fromMs, tf);
  } else if (strategyKey === "VOLUME_PROFILE") {
    const { volumeProfilePadFromMs } = await import("../../strategy/presets/volumeProfileOptimized.js");
    candleFromMs = volumeProfilePadFromMs(fromMs, tf, cfg);
  }

  const coveragePcts = [];
  for (const sym of symbols) {
    const covPre = await getCoverage(sym, tf, { from: candleFromMs, to: toMs }).catch(() => ({
      coveragePct: null,
    }));
    if (covPre.coveragePct != null) coveragePcts.push(covPre.coveragePct);
    if (covPre.coveragePct == null || covPre.coveragePct < 98) {
      await ensureKlines(sym, tf, { from: candleFromMs, to: toMs, market }).catch((err) => {
        console.warn(`[backtest:worker] ensureKlines ${sym} failed:`, err?.message || err);
      });
    }
    if (isFutures) {
      await ensureFunding(sym, { from: fromMs, to: toMs }).catch(() => {});
      await ensureOpenInterest(sym, { from: fromMs, to: toMs, period: "1h" }).catch(() => {});
    }
  }
  reportPrep(3);

  const allEvents = [];
  const gateReplayAgg = {
    mode: gateMode,
    evaluated: 0,
    pass: 0,
    vetoed: 0,
    sizeScaled: 0,
    noGate: 0,
    intelScoreSum: 0,
  };
  const nSyms = symbols.length;
  let timelineCandles = [];

  for (let si = 0; si < nSyms; si++) {
    if (cancelFlag) {
      await cancelRun(runId);
      return;
    }
    const sym = symbols[si];
    const pctBase = 5 + (si / nSyms) * 85;
    reportPrep(pctBase);

    const candles = await readCandles(sym, tf, candleFromMs, toMs, { market });
    if (!candles.length) {
      console.warn(`[backtest:worker] portfolio skip ${sym}: no candles`);
      continue;
    }
    if (!timelineCandles.length) timelineCandles = candles;

    const stratKey = String(cfg.manualStrategy ?? "").toUpperCase();
    let symCfg =
      stratKey === "SUPERTREND_ELITE" || stratKey === "UNIFIED_ELITE"
        ? prepareEliteRunCfg(cfg, sym, candles)
        : { ...cfg, symbol: sym };
    if (stratKey === "VOLUME_PROFILE") {
      const { fillVolumeProfileFreqDefaults } = await import("../../strategy/presets/volumeProfileOptimized.js");
      symCfg = fillVolumeProfileFreqDefaults(symCfg);
    }
    symCfg = {
      ...symCfg,
      backtestSignalStartMs: fromMs,
      backtestPositionSizing: unitSizingMode,
      portfolioPositionSizing: portfolioSizingMode,
    };
    if (isFutures) symCfg = await applyBacktestBracketCap(symCfg, sym);

    const fundingRates = isFutures ? await readFundingRates(sym, fromMs, toMs).catch(() => []) : [];

    let gateFn = null;
    if (gateMode === "approx" && typeof buildIntelligenceReplay === "function") {
      try {
        gateFn = await buildIntelligenceReplay({
          symbol: sym,
          fromMs,
          toMs,
          candles,
          timeframe: tf,
          strictMode: cfg?.intelligenceGateStrict === true,
          highWinRateMode: cfg?.intelligenceGateHighWinRate === true,
        });
      } catch {
        /* optional */
      }
    }

    let adapters = {};
    if (typeof buildBacktestAdapters === "function") {
      try {
        adapters = await buildBacktestAdapters({ strategyKey, cfg: symCfg, symbol: sym, tf, candles, fromMs });
      } catch (err) {
        console.warn(`[backtest:worker] adapters ${sym} failed:`, err?.message || err);
      }
    }

    let trailMicro = null;
    const futuresTrailMode = String(symCfg?.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
    const trailEnabled =
      symCfg?.trailingStopLossAuto === true && isFutures && futuresTrailMode !== "OFF";
    if (trailEnabled) {
      try {
        const { buildTrailMicroContext } = await import("./trailMicroSim.js");
        trailMicro = await buildTrailMicroContext({
          symbol: sym,
          fromMs,
          toMs,
          cfg: symCfg,
          trailEnabled,
        });
      } catch (err) {
        console.warn(`[backtest:worker] trailMicro ${sym} failed:`, err?.message || err);
      }
    }

    const sim = await runSimulation({
      strategyKey,
      candles,
      cfg: symCfg,
      costModelOverride,
      gateMode,
      gateFn,
      fundingRates,
      startingUsdt: perCoinStart,
      timeframe: tf,
      symbol: sym,
      adapters,
      shouldCancel: () => cancelFlag,
      trailMicro,
    });

    const gr = sim.gateReplay;
    if (gr) {
      gateReplayAgg.evaluated += Number(gr.evaluated ?? 0);
      gateReplayAgg.pass += Number(gr.pass ?? 0);
      gateReplayAgg.vetoed += Number(gr.vetoed ?? 0);
      gateReplayAgg.sizeScaled += Number(gr.sizeScaled ?? 0);
      gateReplayAgg.noGate += Number(gr.noGate ?? 0);
      if (gr.intelScoreSum != null) gateReplayAgg.intelScoreSum += Number(gr.intelScoreSum);
    }

    allEvents.push(...tradesToTimelineEvents(sym, sim.trades));
  }

  if (cancelFlag) {
    await cancelRun(runId);
    return;
  }

  reportPrep(92);
  const replay = portfolioSliceReplay({
    events: allEvents,
    startingUsdt,
    coinCount: nCoins,
    perCoinUnitStart: perCoinStart,
    startTs: fromMs,
    mode: portfolioSizingMode,
  });

  let metrics = computeAllMetrics({
    trades: replay.trades,
    equityCurve: replay.equityCurve,
    tf,
    startingEquity: startingUsdt,
  });
  metrics = attachWalkForwardMetrics(metrics, {
    trades: replay.trades,
    equityCurve: replay.equityCurve,
    timelineCandles,
    trainPct,
    tf,
    startingEquity: startingUsdt,
  });
  metrics.gateReplay = {
    ...gateReplayAgg,
    avgIntelScore:
      gateReplayAgg.evaluated > 0 ? gateReplayAgg.intelScoreSum / gateReplayAgg.evaluated : null,
  };
  metrics.portfolio = {
    mode: portfolioSizingMode,
    coinCount: nCoins,
    perCoinStart,
    skippedOverlap: Number(replay.skippedOverlap ?? 0),
    symbols,
    perCoin: Object.fromEntries(
      Object.entries(replay.perCoin).map(([sym, v]) => [
        sym,
        {
          trades: v.n,
          wins: v.wins,
          winRate: v.n ? (v.wins / v.n) * 100 : 0,
          netPnl: v.netPnl,
        },
      ]),
    ),
  };

  const coveragePct =
    coveragePcts.length > 0 ? Math.min(...coveragePcts) : null;

  await finalizeRun({
    runId,
    symbol: "PORTFOLIO",
    metrics,
    trades: replay.trades,
    equityCurve: replay.equityCurve,
    finalEquity: replay.finalEquity,
    coveragePct,
  });
}

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

/**
 * Compute the simulation strategy key from the saved config.
 * Priority mirrors the live bot exactly so backtest = live simulation:
 *   1. supertrendAuto flag on → "SUPERTREND"
 *   2. strategyMode MANUAL    → manualStrategy (or "SUPERTREND" if unset)
 *   3. strategyMode AUTO      → "AUTO"  (per-bar regime rotation via AUTO adapter)
 *   4. fallback               → "SUPERTREND"
 */
/** Must match `pickEngineType` in backtestRoutes.js so UI engine label = simulation. */
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
