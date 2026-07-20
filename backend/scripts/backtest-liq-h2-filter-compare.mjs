#!/usr/bin/env node
/**
 * Compare baseline vs tightened LIQ entry filters on ETH H2 2025.
 * Usage: node scripts/backtest-liq-h2-filter-compare.mjs [baselineRunId]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const BASE_RUN_ID = process.argv[2] || "748868af-a814-4cee-99a6-2825e88c4bef";
const SYMBOL = "ETHUSDT";
const TF = "15m";
/** Same start as baseline run; report trades with exit in Jun–Dec 2025 UTC. */
const FROM_MS = new Date("2025-06-01T00:00:00.000Z").getTime();
const TO_MS = new Date("2026-01-01T00:00:00.000Z").getTime();
const REPORT_EXIT_FROM = new Date("2025-06-01T00:00:00.000Z").getTime();
const REPORT_EXIT_TO = TO_MS;
const STARTING = 100;

const FILTER_PATCH = {
  intradayLiqVetoCounterTrend: true,
  intradayLiqMinReclaimClosePct: 0.001,
  intradayLiqMaxFadeDayRangePct: 0.035,
  intradayLiqPostDisplacementCooldownBars: 10,
  intradayLiqMinQuality: 18,
};

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { query } = await import("../src/db/query.js");

function pickBotCfg(snapshot, fallback) {
  if (snapshot?.bot && typeof snapshot.bot === "object") return { ...snapshot.bot };
  if (snapshot && typeof snapshot === "object" && !snapshot.bot) return { ...snapshot };
  const fb = fallback?.bot && typeof fallback.bot === "object" ? fallback.bot : fallback;
  return fb && typeof fb === "object" ? { ...fb } : {};
}

async function materializeCfgFromRun(run) {
  let cfg = pickBotCfg(run.config_snapshot, run.strategy_cfg_raw);
  const { pickBacktestRunMeta, applyBacktestRunMeta } = await import("../src/backtest/engine/backtestRunMeta.js");
  const meta = pickBacktestRunMeta(pickBotCfg(run.config_snapshot, run.strategy_cfg_raw));

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
    const stratEarly = String(cfg.manualStrategy ?? "").toUpperCase();
    if (
      stratEarly === "SR_INTRADAY" ||
      stratEarly === "INTRADAY_PRO" ||
      !cfg._intradayEngineMaterialized
    ) {
      cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
      cfg._intradayEngineMaterialized = true;
    }
    cfg = ensureBacktestMarketMode(cfg);
  } catch {
    /* optional */
  }

  applyBacktestRunMeta(cfg, meta);
  return cfg;
}

function pickStrategyKey(cfg, engineType) {
  const s = String(cfg?.manualStrategy ?? engineType ?? "").toUpperCase();
  return s || "SR_INTRADAY";
}

function tradeExitMs(t) {
  const raw = t.exitTs ?? t.exitTime ?? t.exit_time;
  return raw != null ? new Date(raw).getTime() : NaN;
}

function summarizeTrades(trades, { reportWindow = false } = {}) {
  let list = trades;
  if (reportWindow) {
    list = trades.filter((t) => {
      const x = tradeExitMs(t);
      return Number.isFinite(x) && x >= REPORT_EXIT_FROM && x < REPORT_EXIT_TO;
    });
  }
  const byExit = {};
  let net = 0;
  let wins = 0;
  const rows = [];
  for (const t of list) {
    const pnl = Number(t.netPnl ?? t.net_pnl ?? 0);
    net += pnl;
    if (pnl > 0) wins++;
    const reason = t.exitReason ?? t.exit_reason ?? "?";
    byExit[reason] = (byExit[reason] || 0) + 1;
    const liq = t.liqContext ?? t.signalContext?.liq ?? t.signal_context?.liq ?? {};
    rows.push({
      date: String(t.exitTs ?? t.exitTime ?? t.exit_time).slice(0, 10),
      dir: t.direction ?? t.side,
      exit: reason,
      pnl: +pnl.toFixed(2),
      level: liq.levelType,
      qual: liq.liqQuality != null ? +Number(liq.liqQuality).toFixed(1) : null,
    });
  }
  return {
    n: list.length,
    net: +net.toFixed(2),
    wr: list.length ? +((wins / list.length) * 100).toFixed(1) : 0,
    sl: byExit.sl ?? 0,
    trail: byExit.trail ?? 0,
    byExit,
    rows,
  };
}

async function runSim(cfg, label, runRef) {
  const { readCandles, ensureKlines } = await import("../src/backtest/data/klineIngest.js");
  const { ensureFunding, readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
  const { runSimulation } = await import("../src/backtest/engine/runner.js");
  const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
  const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");

  clearIntradayAdapterCache();
  const isFutures = String(cfg?.marketMode || cfg?.market || "FUTURES").toUpperCase() === "FUTURES";
  const market = isFutures ? "futures" : "spot";
  const strategyKey = pickStrategyKey(cfg, "SR_INTRADAY");

  await ensureKlines(SYMBOL, TF, { from: FROM_MS, to: TO_MS, market }).catch(() => {});
  if (isFutures) await ensureFunding(SYMBOL, { from: FROM_MS, to: TO_MS }).catch(() => {});

  const candles = await readCandles(SYMBOL, TF, FROM_MS, TO_MS, { market });
  if (!candles.length) throw new Error("no_candles");

  const fundingRates = isFutures ? await readFundingRates(SYMBOL, FROM_MS, TO_MS).catch(() => []) : [];
  const adapters = await buildBacktestAdapters({
    strategyKey,
    cfg,
    symbol: SYMBOL,
    tf: TF,
    candles,
    fromMs: FROM_MS,
  }).catch(() => ({}));

  let trailMicro = null;
  const futuresTrailMode = String(cfg?.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
  const trailEnabled = cfg?.trailingStopLossAuto === true && isFutures && futuresTrailMode !== "OFF";
  if (trailEnabled) {
    const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
    trailMicro = await buildTrailMicroContext({
      symbol: SYMBOL,
      fromMs: FROM_MS,
      toMs: TO_MS,
      cfg,
      trailEnabled,
    });
  }

  const costModelOverride =
    runRef?.cost_model && typeof runRef.cost_model === "object" ? runRef.cost_model : {};
  const gateMode = String(runRef?.gate_mode || "off") === "approx" ? "approx" : "off";

  const sim = await runSimulation({
    strategyKey,
    candles,
    cfg,
    costModelOverride,
    gateMode,
    fundingRates,
    startingUsdt: Number(runRef?.initial_capital ?? STARTING),
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
    trailMicro,
  });

  const summary = summarizeTrades(sim.trades, { reportWindow: true });
  console.log(`\n── ${label} ──`);
  console.log(
    JSON.stringify(
      {
        trades: summary.n,
        netUsd: summary.net,
        winRatePct: summary.wr,
        slExits: summary.sl,
        trailExits: summary.trail,
        exits: summary.byExit,
      },
      null,
      2,
    ),
  );
  for (const r of summary.rows) {
    console.log(
      `  ${r.date} ${r.dir} ${r.exit.padEnd(10)} $${String(r.pnl).padStart(7)}  ${r.level ?? "?"} q=${r.qual ?? "?"}`,
    );
  }
  return summary;
}

const r = await query(
  `SELECT br.*, sv.cfg_raw AS strategy_cfg_raw
     FROM backtest_runs br
     JOIN strategy_versions sv ON sv.id = br.strategy_version_id
    WHERE br.id = $1`,
  [BASE_RUN_ID],
);
const run = r.rows[0];
if (!run) {
  console.error("baseline run not found:", BASE_RUN_ID);
  process.exit(1);
}

const baseCfg = await materializeCfgFromRun(run);
const filterCfg = { ...baseCfg, ...FILTER_PATCH };

console.log("ETH LIQ H2 2025 filter compare");
console.log("baseline run:", BASE_RUN_ID);
console.log("window: exit Jun–Dec 2025 | sim from", new Date(FROM_MS).toISOString().slice(0, 10));
console.log("filter patch:", FILTER_PATCH);

const base = await runSim(baseCfg, "BASELINE (repro)", run);
const filtered = await runSim(filterCfg, "FILTERED", run);

console.log("\n── DELTA ──");
console.log(
  JSON.stringify(
    {
      trades: filtered.n - base.n,
      netUsd: +(filtered.net - base.net).toFixed(2),
      slExits: filtered.sl - base.sl,
      trailExits: filtered.trail - base.trail,
    },
    null,
    2,
  ),
);

await closePool().catch(() => {});
