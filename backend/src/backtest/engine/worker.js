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
const { getCoverage } = await import("../data/dataCoverage.js");
const { runSimulation } = await import("./runner.js");
const { computeAllMetrics } = await import("./metrics.js");
const { finalizeRun, failRun, markRunning, updateProgress, cancelRun } = await import("./persistence.js");
const { buildIntelligenceReplay } = await import("./intelligenceReplay.js").catch(() => ({
  buildIntelligenceReplay: null,
}));
const { buildBacktestAdapters } = await import("./signals/baselines.js").catch(() => ({
  buildBacktestAdapters: null,
}));

let cancelFlag = false;
parentPort?.on("message", (msg) => {
  if (msg && msg.type === "cancel") cancelFlag = true;
});

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

try {
  await execute(workerData);
  parentPort?.postMessage({ type: "complete", runId: workerData.runId });
} catch (err) {
  console.error("[backtest:worker] failed", err?.stack || err);
  try {
    await failRun(workerData.runId, err);
  } catch {
    /* ignore — worker exit will signal failure to pool */
  }
  parentPort?.postMessage({ type: "failed", runId: workerData.runId, error: String(err?.message || err) });
} finally {
  try {
    await closePool();
  } catch {
    /* ignore */
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

  const symbol = String(run.symbol);
  const tf = String(run.timeframe);
  const fromMs = new Date(run.start_date).getTime();
  const toMs = new Date(run.end_date).getTime();
  const startingUsdt = Number(run.initial_capital);
  const cfg = pickBotCfg(run.config_snapshot, run.strategy_cfg_raw);
  const costModelOverride = run.cost_model && typeof run.cost_model === "object" ? run.cost_model : {};
  // `gate_mode` is stored at run creation time. Fall back to checking the strategy cfg
  // directly so that old runs or API calls without the UI still activate the replay gate.
  const gateModeFromDb = String(run.gate_mode || "off") === "approx" ? "approx" : "off";
  const gateMode =
    gateModeFromDb === "approx" || cfg?.intelligenceGateEnabled === true ? "approx" : "off";
  const isFutures = String(cfg?.marketMode || cfg?.market || "").toUpperCase() === "FUTURES";
  const market = isFutures ? "futures" : "spot";
  const strategyKey = pickStrategyKey(cfg, run.engine_type);

  await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market }).catch((err) => {
    console.warn("[backtest:worker] ensureKlines failed:", err?.message || err);
  });
  if (isFutures) {
    await ensureFunding(symbol, { from: fromMs, to: toMs }).catch((err) => {
      console.warn("[backtest:worker] ensureFunding failed:", err?.message || err);
    });
  }

  const candles = await readCandles(symbol, tf, fromMs, toMs);
  if (!candles.length) throw new Error("worker:no_candles");
  parentPort?.postMessage({ type: "progress", runId, pct: 1 });
  void updateProgress(runId, 1).catch(() => {});

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
      adapters = await buildBacktestAdapters({ strategyKey, cfg, symbol, tf, candles, fromMs });
    } catch (err) {
      console.warn("[backtest:worker] buildBacktestAdapters failed:", err?.message || err);
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
  });

  if (cancelFlag) {
    await cancelRun(runId);
    return;
  }

  const metrics = computeAllMetrics({
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

  if (trainPct != null && sim.trades.length) {
    const splitIdx = Math.floor(candles.length * trainPct);
    const splitTs = splitIdx > 0 && splitIdx < candles.length ? Number(candles[splitIdx].ts) : null;
    if (splitTs != null) {
      const trainTrades = sim.trades.filter((t) => Number(t.exitTs) <= splitTs);
      const testTrades = sim.trades.filter((t) => Number(t.exitTs) > splitTs);
      const trainCurve = sim.equityCurve.filter((p) => Number(p.ts) <= splitTs);
      const testCurve = sim.equityCurve.filter((p) => Number(p.ts) > splitTs);
      const startingTest = trainCurve.length ? trainCurve[trainCurve.length - 1].equity : startingUsdt;
      metrics.walkForward = {
        trainPct,
        splitTs,
        train: computeAllMetrics({
          trades: trainTrades,
          equityCurve: trainCurve,
          tf,
          startingEquity: startingUsdt,
        }),
        test: computeAllMetrics({
          trades: testTrades,
          equityCurve: testCurve,
          tf,
          startingEquity: startingTest,
        }),
      };
    }
  }

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
