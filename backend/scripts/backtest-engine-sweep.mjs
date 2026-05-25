#!/usr/bin/env node
/**
 * Exercise the same backtest engine as the panel across strategies.
 *
 *   npm --workspace backend run backtest:sweep -- --synthetic
 *   npm --workspace backend run backtest:sweep -- --symbol BTCUSDT --tf 15m --days 90 --market futures
 *
 * Checks: sum(netPnl) ≈ finalEquity - startingUsdt; no overlapping adapter errors.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const STRATEGIES = [
  "SUPERTREND",
  "AUTO",
  "EMA_CROSS",
  "RSI_MEAN",
  "BREAKOUT_VOL",
  "MOMENTUM_SURGE",
  "CONFLUENCE",
  "ENSEMBLE",
  "TREND_PULLBACK",
  "SURF_PULSE_ML",
];

/** Deterministic pseudo-random for reproducible synthetic paths */
function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSyntheticCandles({ n, stepMs, seed = 42 }) {
  const rand = mulberry32(seed);
  let p = 42_000;
  const out = [];
  let ts = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const regime = i < n * 0.45 ? 0.00015 : i < n * 0.7 ? -0.00012 : 0.00008;
    const noise = (rand() - 0.5) * 0.0012;
    const o = p;
    const c = p * (1 + regime + noise);
    const hi = Math.max(o, c) * (1 + rand() * 0.0004);
    const lo = Math.min(o, c) * (1 - rand() * 0.0004);
    const vol = 100 + rand() * 400;
    out.push({ ts, open: o, high: hi, low: lo, close: c, volume: vol });
    p = c;
    ts += stepMs;
  }
  return out;
}

function baseBotCfg(overrides = {}) {
  return {
    marketMode: "FUTURES",
    futuresLeverage: 5,
    supertrendPeriod: 10,
    supertrendMultiplier: 3,
    supertrendWilderAtr: true,
    supertrendFuturesFixedSlPct: 0.02,
    supertrendFuturesFixedTpPct: 0,
    riskPerTrade: 1,
    riskPerTradeUnit: "PCT_EQUITY",
    slippagePct: 0.0003,
    tradeHistoryTakerOpenFeeRate: 0.0005,
    tradeHistoryTakerCloseFeeRate: 0.0005,
    surfPulseMlThreshold: 0.55,
    surfPulseIgnoreTrainingCutoff: true,
    ...overrides,
  };
}

async function buildAdaptersForStrategy(strategyKey, { symbol, tf, candles, cfg, fromMs }) {
  const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
  if (typeof buildBacktestAdapters !== "function") return {};
  return buildBacktestAdapters({ strategyKey, cfg, symbol, tf, candles, fromMs });
}

async function runOne({ strategyKey, candles, tf, cfg, startingUsdt, symbol, fromMs }) {
  const { runSimulation } = await import("../src/backtest/engine/runner.js");
  const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");

  const adapters = await buildAdaptersForStrategy(strategyKey, {
    symbol,
    tf,
    candles,
    cfg,
    fromMs,
  });

  const sim = await runSimulation({
    strategyKey,
    candles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt,
    timeframe: tf,
    adapters,
  });

  const metrics = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf,
    startingEquity: startingUsdt,
  });

  const pnlSum = sim.trades.reduce((s, t) => s + Number(t.netPnl ?? 0), 0);
  const eqDelta = sim.finalEquity - startingUsdt;
  const pnlOk = Math.abs(pnlSum - eqDelta) < Math.max(1e-6, Math.abs(eqDelta) * 1e-9 + 1e-4);

  return { sim, metrics, pnlOk, pnlSum, eqDelta };
}

function printRow(name, m, pnlOk, err) {
  if (err) {
    console.log(`${name.padEnd(18)} ERROR  ${String(err).slice(0, 120)}`);
    return;
  }
  const ret = Number(m.totalReturnPct ?? 0).toFixed(2);
  const dd = Number(m.maxDrawdownPct ?? 0).toFixed(2);
  const n = m.totalTrades ?? 0;
  const wr = ((m.winRate ?? 0) * 100).toFixed(1);
  const ok = pnlOk ? "✓" : "✗pnl";
  console.log(`${name.padEnd(18)} ${ok}  trades=${String(n).padStart(4)}  ret%=${String(ret).padStart(8)}  DD%=${String(dd).padStart(6)}  win%=${wr}`);
}

async function main() {
  const synthetic = process.argv.includes("--synthetic");
  const skipSurf = process.argv.includes("--skip-surf");
  const symbol = String(arg("symbol", "BTCUSDT")).toUpperCase();
  const tf = String(arg("tf", "15m"));
  const days = Math.max(1, Number(arg("days", "90")));
  const market = String(arg("market", "futures")).toLowerCase() === "spot" ? "spot" : "futures";
  const startingUsdt = 10_000;

  let candles;
  let fromMs;
  let toMs;

  if (synthetic) {
    const { tfToMs } = await import("../src/backtest/data/timeframe.js");
    const stepMs = tfToMs(tf);
    candles = makeSyntheticCandles({ n: 3500, stepMs, seed: 99 });
    fromMs = candles[0].ts;
    toMs = candles[candles.length - 1].ts + stepMs;
    console.log(`Synthetic ${candles.length} bars · ${tf} · ~${(candles.length * stepMs) / 86400000}d span\n`);
  } else {
    const { initPool, closePool, getPool } = await import("../src/db/pool.js");
    if (!getPool?.()) {
      await initPool({ info: () => {}, warn: () => {}, error: console.error });
    }
    const { ensureKlines } = await import("../src/backtest/data/klineIngest.js");
    const { readCandles } = await import("../src/backtest/data/klineIngest.js");
    const { tfToMs } = await import("../src/backtest/data/timeframe.js");

    toMs = Date.now();
    fromMs = toMs - days * 86400000;
    console.log(`DB ${symbol} ${tf} ${market} ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}\n`);
    await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market });
    candles = await readCandles(symbol, tf, fromMs, toMs);
    if (!candles.length) {
      console.error("No candles after ensureKlines — check DB / network.");
      process.exit(1);
    }
    console.log(`Loaded ${candles.length} bars\n`);
    if (!synthetic) {
      const { closePool: c } = await import("../src/db/pool.js");
      await c().catch(() => {});
    }
  }

  const cfgFutures = baseBotCfg();
  const cfgSpot = baseBotCfg({
    marketMode: "SPOT",
    spotFixedSlPct: 0.02,
  });

  console.log("strategy            chk   trades   ret%       DD%    win%");
  console.log("-".repeat(72));

  for (const strategyKey of STRATEGIES) {
    if (skipSurf && strategyKey === "SURF_PULSE_ML") continue;
    const cfgBase = market === "spot" ? cfgSpot : cfgFutures;
    const cfg =
      strategyKey === "AUTO"
        ? { ...cfgBase, strategyMode: "AUTO" }
        : { ...cfgBase, strategyMode: "MANUAL", manualStrategy: strategyKey };
    try {
      const { metrics, pnlOk, sim } = await runOne({
        strategyKey,
        candles,
        tf,
        cfg,
        startingUsdt,
        symbol,
        fromMs,
      });
      printRow(strategyKey, metrics, pnlOk, null);
      if (!pnlOk) {
        console.error(`  [invariant] sum(netPnl)=${sim.trades.reduce((s, t) => s + t.netPnl, 0)} vs equity delta`);
      }
    } catch (e) {
      printRow(strategyKey, {}, true, e);
    }
  }

  console.log("\nNotes:");
  console.log("  • chk ✓ means equity reconciles with sum of trade net PnL (engine consistency).");
  console.log("  • Positive ret% on a window does not imply future profitability.");
  console.log("  • SURF_PULSE_ML needs AI on AI_SERVICE_URL; failures show as ERROR.");
  if (skipSurf) console.log("  • (--skip-surf) SURF_PULSE_ML was omitted for speed.");
  if (market === "spot") console.log("  • Spot: SELL entries are skipped (no shorts); flip exits still close longs.");

  if (!synthetic) {
    const { closePool } = await import("../src/db/pool.js");
    await closePool().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
