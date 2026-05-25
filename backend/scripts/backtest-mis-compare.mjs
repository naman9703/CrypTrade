#!/usr/bin/env node
/**
 * Compare backtest with Market Intelligence replay ON vs OFF for a fixed window.
 * Uses DB candles + funding + same cfg as the worker (SUPERTREND path).
 *
 *   npm --workspace backend run backtest:mis-compare
 *
 * Window: BTCUSDT 1m, 2026-05-10 .. 2026-05-11 UTC (inclusive), 1000 USDT, slippage 0.01%.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOL = "BTCUSDT";
const TF = "1m";
/** Inclusive calendar days in UTC (matches typical “10th–11th” intent). */
const FROM_MS = Date.UTC(2026, 4, 10, 0, 0, 0, 0);
const TO_MS = Date.UTC(2026, 4, 12, 0, 0, 0, 0);
const STARTING = 1000;
const SLIPPAGE_FRAC = 0.01 / 100;

const { initPool, closePool } = await import("../src/db/pool.js");
const { query } = await import("../src/db/query.js");
const { readCandles, ensureKlines } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates, ensureFunding } = await import("../src/backtest/data/fundingIngest.js");
const { ensureFearGreed } = await import("../src/backtest/data/fearGreedIngest.js");
const { ensureOpenInterest } = await import("../src/backtest/data/openInterestIngest.js");
const { getCoverage } = await import("../src/backtest/data/dataCoverage.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildIntelligenceReplay } = await import("../src/backtest/engine/intelligenceReplay.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

function pickBotCfg(snapshot, fallback) {
  const root =
    snapshot && typeof snapshot === "object"
      ? snapshot
      : fallback && typeof fallback === "object"
        ? fallback
        : {};
  if (root && typeof root.bot === "object" && root.bot) return { ...root.bot };
  return { ...root };
}

function pickStrategyKey(cfg) {
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
  return "SUPERTREND";
}

await initPool({ info: () => {}, warn: () => {}, error: console.error });

try {
  const ver = await query(
    `SELECT cfg_raw FROM strategy_versions ORDER BY created_at DESC NULLS LAST LIMIT 1`,
  );
  const cfgRaw = ver.rows[0]?.cfg_raw;
  if (!cfgRaw || typeof cfgRaw !== "object") {
    console.error("No strategy_versions row with cfg_raw — seed a strategy first.");
    process.exit(1);
  }

  const base = pickBotCfg(cfgRaw, cfgRaw);
  base.symbol = SYMBOL;
  base.timeframe = TF;
  base.marketMode = "FUTURES";
  if (base.supertrendFuturesAuto !== true) base.supertrendFuturesAuto = true;

  const cfgOff = JSON.parse(JSON.stringify(base));
  cfgOff.intelligenceGateEnabled = false;

  const cfgOn = JSON.parse(JSON.stringify(base));
  cfgOn.intelligenceGateEnabled = true;

  console.log("Strategy snapshot (bot) intelligenceGateEnabled:", base.intelligenceGateEnabled);
  console.log("Window UTC:", new Date(FROM_MS).toISOString(), "→", new Date(TO_MS).toISOString());
  console.log("Symbol", SYMBOL, TF, "starting", STARTING, "slippagePct", SLIPPAGE_FRAC);

  const padMs = 30 * 24 * 60 * 60 * 1000;
  await Promise.all([
    ensureFearGreed({ limit: 0 }).catch((e) => console.warn("ensureFearGreed:", e?.message || e)),
    ensureFunding(SYMBOL, { from: FROM_MS - padMs, to: TO_MS }).catch((e) =>
      console.warn("ensureFunding:", e?.message || e),
    ),
    ensureOpenInterest(SYMBOL, { from: FROM_MS - padMs, to: TO_MS, period: "1h" }).catch((e) =>
      console.warn("ensureOpenInterest:", e?.message || e),
    ),
  ]);

  for (let pass = 0; pass < 3; pass++) {
    const { inserted, gaps } = await ensureKlines(SYMBOL, TF, {
      from: FROM_MS,
      to: TO_MS,
      market: "futures",
    }).catch((e) => {
      console.warn("ensureKlines:", e?.message || e);
      return { inserted: 0, gaps: -1 };
    });
    const cov = await getCoverage(SYMBOL, TF, { from: FROM_MS, to: TO_MS });
    console.log(
      `Backfill pass ${pass + 1}: klines inserted=${inserted} gapChunks=${gaps} coverage=${cov.coveragePct != null ? cov.coveragePct.toFixed(2) : "n/a"}%`,
    );
    if (cov.coveragePct != null && cov.coveragePct >= 99) break;
    if (inserted === 0 && gaps === 0) break;
  }

  const candles = await readCandles(SYMBOL, TF, FROM_MS, TO_MS);
  if (!candles.length) {
    console.error("No candles in DB for window — sync klines from the Backtest panel (Data coverage) or check DB.");
    process.exit(1);
  }
  const fundingRates = await readFundingRates(SYMBOL, FROM_MS, TO_MS).catch(() => []);
  const cov = await getCoverage(SYMBOL, TF, { from: FROM_MS, to: TO_MS });
  console.log("Final: candles", candles.length, "coveragePct:", cov.coveragePct != null ? cov.coveragePct.toFixed(2) : "n/a");
  if (cov.coveragePct != null && cov.coveragePct < 90) {
    console.warn(
      "Coverage under 90% — results are incomplete. Use Backtest → Data coverage → Sync for this symbol/tf/window.",
    );
  }

  const strategyKey = pickStrategyKey(cfgOff);
  const adapters = await buildBacktestAdapters({
    strategyKey,
    cfg: cfgOff,
    symbol: SYMBOL,
    tf: TF,
    candles,
    fromMs: FROM_MS,
  });

  const costModelOverride = { slippagePct: SLIPPAGE_FRAC };

  const simOff = await runSimulation({
    strategyKey,
    candles,
    cfg: cfgOff,
    costModelOverride,
    gateMode: "off",
    gateFn: null,
    fundingRates,
    startingUsdt: STARTING,
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
  });

  const gateFn = await buildIntelligenceReplay({ symbol: SYMBOL, fromMs: FROM_MS, to: TO_MS, candles });
  const simOn = await runSimulation({
    strategyKey,
    candles,
    cfg: cfgOn,
    costModelOverride,
    gateMode: "approx",
    gateFn,
    fundingRates,
    startingUsdt: STARTING,
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
  });

  console.log("\n=== MIS OFF ===");
  console.log("trades", simOff.trades.length, "finalEquity", simOff.finalEquity.toFixed(4), "gateReplay", simOff.gateReplay);

  console.log("\n=== MIS ON (approx replay, live-directional veto) ===");
  console.log("trades", simOn.trades.length, "finalEquity", simOn.finalEquity.toFixed(4), "gateReplay", simOn.gateReplay);

  const diff = simOff.trades.length - simOn.trades.length;
  console.log("\nTrade count delta (off - on):", diff);
  if (diff === 0 && (simOn.gateReplay?.vetoed ?? 0) === 0 && (simOn.gateReplay?.sizeScaled ?? 0) === 0) {
    console.log(
      "Note: identical counts with zero vetoes/scales means replay composite stayed in neutral band for every entry attempt (expected sometimes).",
    );
  }

  console.log("\nFirst 8 trades MIS-OFF ( #, side, entryTs, netPnl, exitReason )");
  for (const t of simOff.trades.slice(0, 8)) {
    console.log(
      t.tradeNumber,
      t.direction,
      new Date(t.entryTs).toISOString(),
      t.netPnl.toFixed(4),
      t.exitReason,
      "intelScoreAtEntry",
      t.intelScoreAtEntry,
    );
  }
  console.log("\nFirst 8 trades MIS-ON");
  for (const t of simOn.trades.slice(0, 8)) {
    console.log(
      t.tradeNumber,
      t.direction,
      new Date(t.entryTs).toISOString(),
      t.netPnl.toFixed(4),
      t.exitReason,
      "intelScoreAtEntry",
      t.intelScoreAtEntry,
      "gateAction",
      t.gateAction,
    );
  }
} finally {
  await closePool();
}
