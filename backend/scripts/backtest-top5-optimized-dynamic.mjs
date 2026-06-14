#!/usr/bin/env node
/**
 * Rank strategies with optimized presets + Elite per-coin dynamic tuning.
 * Reports single-coin (BTC) and 10-coin portfolio results.
 *
 * Usage (from backend/):
 *   node scripts/backtest-top5-optimized-dynamic.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const TF = process.env.TF || "1h";
const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-13";
const START = Number(process.env.START_USDT || 100);
const RISK = Number(process.env.RISK_PCT || 5);
const LEV = Number(process.env.LEVERAGE || 10);
const SINGLE_SYM = (process.env.SINGLE_SYM || "BTCUSDT").trim().toUpperCase();
const PORTFOLIO = (process.env.SYMBOLS ||
  "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,LINKUSDT,AVAXUSDT,DOTUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { portfolioSliceReplay, tradesToTimelineEvents } = await import("../src/backtest/engine/portfolioReplay.js");
const {
  buildEliteStBacktestAdapter,
  buildEliteStOptsFromCfg,
  prepareEliteRunCfg,
} = await import("../src/strategy/supertrendElite.js");
const { buildUnifiedEliteBacktestAdapter, buildUnifiedEliteOptsFromCfg } = await import(
  "../src/strategy/unifiedElite.js",
);
const {
  SUPERTREND_ELITE_1H_PRESET,
  SUPERTREND_ELITE_AUTO_1H_PRESET,
  UNIFIED_ELITE_1H_PRESET,
} = await import("../src/strategy/presets/supertrendEliteOptimized.js");
const { TREND_HTF_ST_BNB_MAX_PRESET } = await import("../src/strategy/presets/trendHtfStOptimized.js");
const { HTF_LEG_RIDER_PRESET } = await import("../src/strategy/presets/htfLegRiderOptimized.js");
const { HTF_RSI_MAX_RETURN_PRESET } = await import("../src/strategy/presets/htfRsiOptimized.js");
const { APEX_TREND_1H } = await import("../src/strategy/presets/apexTrendPresets.js");
const { ELITE_HTF_BNB_PRESET } = await import("../src/strategy/presets/eliteHtfOptimized.js");
const { INTRADAY_PRO_15M } = await import("../src/strategy/presets/srIntradayOptimized.js");

const COMMON = {
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  backtestPositionSizing: "RISK_AT_SL",
  riskPerTrade: RISK,
  riskPerTradeUnit: "PCT",
  futuresLeverage: LEV,
  slippagePct: 0.0005,
  timeframe: TF,
};

/** Strategy variants: optimized preset + whether Elite dynamic auto-calibrate runs per coin. */
const VARIANTS = [
  {
    key: "SUPERTREND_ELITE",
    name: "SUPERTREND_ELITE · dynamic auto-tune (TP off)",
    dynamic: true,
    preset: () => ({
      ...SUPERTREND_ELITE_AUTO_1H_PRESET,
      ...COMMON,
      manualStrategy: "SUPERTREND_ELITE",
      eliteStAutoCalibrate: true,
      eliteStAutoFullTune: true,
      supertrendFuturesUseFixedTp: false,
      supertrendFuturesFixedTpPct: 0,
    }),
  },
  {
    key: "SUPERTREND_ELITE",
    name: "SUPERTREND_ELITE · trail-only static (no auto-calibrate)",
    dynamic: false,
    preset: () => ({
      ...SUPERTREND_ELITE_1H_PRESET,
      ...COMMON,
      manualStrategy: "SUPERTREND_ELITE",
      eliteStAutoCalibrate: false,
      supertrendFuturesUseFixedTp: false,
      supertrendFuturesFixedTpPct: 0,
      eliteStHtf1hMinSep: 0.0005,
    }),
  },
  {
    key: "UNIFIED_ELITE",
    name: "UNIFIED_ELITE · dynamic auto-tune",
    dynamic: true,
    preset: () => ({
      ...UNIFIED_ELITE_1H_PRESET,
      ...COMMON,
      manualStrategy: "UNIFIED_ELITE",
      futuresLeverage: LEV,
      eliteStAutoCalibrate: true,
      eliteStAutoFullTune: true,
      supertrendFuturesUseFixedTp: false,
      supertrendFuturesFixedTpPct: 0,
    }),
  },
  {
    key: "UNIFIED_ELITE",
    name: "UNIFIED_ELITE · static preset",
    dynamic: false,
    preset: () => ({ ...UNIFIED_ELITE_1H_PRESET, ...COMMON, futuresLeverage: LEV }),
  },
  {
    key: "TREND_HTF_ST",
    name: "TREND_HTF_ST · BNB max preset (1h)",
    dynamic: false,
    preset: () => ({
      ...TREND_HTF_ST_BNB_MAX_PRESET,
      ...COMMON,
      futuresLeverage: LEV,
      riskPerTrade: RISK,
      riskPerTradeUnit: "PCT",
      timeframe: TF,
    }),
  },
  {
    key: "HTF_LEG_RIDER",
    name: "HTF_LEG_RIDER · wide SL/TP preset",
    dynamic: false,
    preset: () => ({
      ...HTF_LEG_RIDER_PRESET,
      ...COMMON,
      futuresLeverage: LEV,
      riskPerTradeUnit: "PCT",
      timeframe: TF,
    }),
  },
  {
    key: "HTF_RSI",
    name: "HTF_RSI · max-return preset",
    dynamic: false,
    preset: () => ({
      ...HTF_RSI_MAX_RETURN_PRESET,
      ...COMMON,
      futuresLeverage: LEV,
      riskPerTradeUnit: "PCT",
      timeframe: TF,
    }),
  },
  {
    key: "APEX_TREND",
    name: "APEX_TREND · 1h preset",
    dynamic: false,
    preset: () => ({ ...APEX_TREND_1H, ...COMMON, manualStrategy: "APEX_TREND", timeframe: TF }),
  },
  {
    key: "ELITE_HTF",
    name: "ELITE_HTF · BNB preset",
    dynamic: false,
    preset: () => ({ ...ELITE_HTF_BNB_PRESET, ...COMMON, manualStrategy: "ELITE_HTF", timeframe: TF }),
  },
  {
    key: "SR_INTRADAY",
    name: "SR_INTRADAY · intraday pro preset",
    dynamic: false,
    preset: () => ({
      ...INTRADAY_PRO_15M,
      ...COMMON,
      manualStrategy: "SR_INTRADAY",
      timeframe: TF,
    }),
  },
];

const candleCache = new Map();
async function loadSym(sym) {
  if (candleCache.has(sym)) return candleCache.get(sym);
  const candles = await readCandles(sym, TF, fromMs, toMs, { market: "futures" });
  let funding = [];
  try {
    funding = await readFundingRates(sym, fromMs, toMs);
  } catch {
    funding = [];
  }
  const pack = { candles, funding };
  candleCache.set(sym, pack);
  return pack;
}

async function materializeCfg(variant, sym, candles) {
  let cfg = { ...variant.preset(), symbol: sym };
  if (variant.key === "SUPERTREND_ELITE" || (variant.key === "UNIFIED_ELITE" && variant.dynamic)) {
    if (variant.dynamic) {
      cfg = prepareEliteRunCfg(cfg, sym, candles);
    }
  } else if (variant.key === "UNIFIED_ELITE") {
    cfg = { ...cfg, ...prepareEliteRunCfg({ ...SUPERTREND_ELITE_1H_PRESET, ...cfg }, sym, candles) };
  }
  return cfg;
}

async function buildAdapters(strategyKey, sym, candles, cfg) {
  if (strategyKey === "SUPERTREND_ELITE") {
    return {
      SUPERTREND_ELITE: buildEliteStBacktestAdapter(candles, buildEliteStOptsFromCfg(cfg)),
    };
  }
  if (strategyKey === "UNIFIED_ELITE") {
    return {
      UNIFIED_ELITE: buildUnifiedEliteBacktestAdapter(candles, buildUnifiedEliteOptsFromCfg(cfg)),
    };
  }
  return buildBacktestAdapters({ strategyKey, cfg, symbol: sym, tf: TF, candles, fromMs });
}

async function simCoin(variant, sym, startingUsdt) {
  const { candles, funding } = await loadSym(sym);
  if (!candles?.length) return { err: "no candles" };
  let cfg;
  try {
    cfg = await materializeCfg(variant, sym, candles);
  } catch (e) {
    return { err: e?.message || "cfg" };
  }
  let adapters;
  try {
    adapters = await buildAdapters(variant.key, sym, candles, cfg);
  } catch (e) {
    return { err: e?.message || "adapters" };
  }
  const sim = await runSimulation({
    strategyKey: variant.key,
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt,
    timeframe: TF,
    symbol: sym,
    adapters,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: startingUsdt,
  });
  const trades = sim.trades.filter((t) => t.exitReason !== "tp1_partial");
  return {
    ret: Number(m.totalReturnPct ?? 0),
    dd: Number(m.maxDrawdownPct ?? 0),
    trades: trades.length,
    pf: Number(m.profitFactor ?? 0),
    simTrades: sim.trades,
    tuning: cfg._eliteDynamicTuning ?? null,
    sepMode: cfg.eliteStHtf1hSepMode ?? null,
    stM: cfg.supertrendMultiplier ?? null,
  };
}

async function simPortfolio(variant) {
  const n = PORTFOLIO.length;
  const perCoinStart = START / n;
  const events = [];
  const perCoin = {};
  for (const sym of PORTFOLIO) {
    const r = await simCoin(variant, sym, perCoinStart);
    if (r.err) {
      perCoin[sym] = r;
      continue;
    }
    perCoin[sym] = { ret: r.ret, trades: r.trades, dd: r.dd };
    events.push(...tradesToTimelineEvents(sym, r.simTrades));
  }
  if (!events.length) return { ret: 0, dd: 0, trades: 0, pf: 0, perCoin, err: "no trades" };
  const replay = portfolioSliceReplay({
    events,
    startingUsdt: START,
    coinCount: n,
    perCoinUnitStart: perCoinStart,
    startTs: fromMs,
  });
  const m = computeAllMetrics({
    trades: replay.trades,
    equityCurve: replay.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  return {
    ret: Number(m.totalReturnPct ?? 0),
    dd: Number(m.maxDrawdownPct ?? 0),
    trades: replay.trades.length,
    pf: Number(m.profitFactor ?? 0),
    perCoin,
  };
}

function fmt(n, d = 1) {
  return Number.isFinite(n) ? Number(n).toFixed(d) : "—";
}

console.log(`\n=== TOP STRATEGY HUNT — optimized + dynamic ===`);
console.log(`Window: ${FROM} → ${TO}  TF=${TF}  start=$${START}  risk=${RISK}%  lev=${LEV}x`);
console.log(`Single: ${SINGLE_SYM}  Portfolio (${PORTFOLIO.length}): ${PORTFOLIO.join(", ")}\n`);

const rows = [];
for (const variant of VARIANTS) {
  process.stdout.write(`  ${variant.name} … `);
  const single = await simCoin(variant, SINGLE_SYM, START);
  const port = await simPortfolio(variant);
  rows.push({ ...variant, single, port });
  console.log(
    single.err
      ? `single ERR  port ${fmt(port.ret)}%`
      : `single ${fmt(single.ret)}%  port ${fmt(port.ret)}% (${port.trades} tr)`,
  );
}

/** Best variant per strategy key (by portfolio return). */
const bestByKey = new Map();
for (const r of rows) {
  const prev = bestByKey.get(r.key);
  const portRet = r.port?.ret ?? -Infinity;
  if (!prev || portRet > (prev.port?.ret ?? -Infinity)) bestByKey.set(r.key, r);
}

const top5 = [...bestByKey.values()].sort((a, b) => (b.port?.ret ?? 0) - (a.port?.ret ?? 0)).slice(0, 5);

console.log(`\n========== TOP 5 STRATEGIES (best optimized variant · portfolio return) ==========`);
console.log(
  `${"rank".padEnd(5)}${"strategy".padEnd(18)}${"variant".padEnd(42)}${"dyn".padStart(4)}${"BTC ret%".padStart(10)}${"BTC tr".padStart(7)}${"PF ret%".padStart(10)}${"PF tr".padStart(7)}${"PF DD%".padStart(8)}`,
);
top5.forEach((r, i) => {
  console.log(
    `${String(i + 1).padEnd(5)}${r.key.padEnd(18)}${r.name.slice(0, 41).padEnd(42)}${(r.dynamic ? "Y" : "N").padStart(4)}${fmt(r.single?.ret).padStart(10)}${String(r.single?.trades ?? "—").padStart(7)}${fmt(r.port?.ret).padStart(10)}${String(r.port?.trades ?? "—").padStart(7)}${fmt(r.port?.dd).padStart(8)}`,
  );
});

console.log(`\n========== ALL VARIANTS (portfolio ranked) ==========`);
const allRanked = [...rows].sort((a, b) => (b.port?.ret ?? 0) - (a.port?.ret ?? 0));
for (const r of allRanked) {
  console.log(
    `${r.key.padEnd(18)}${fmt(r.port?.ret).padStart(9)}% ${String(r.port?.trades ?? 0).padStart(4)} tr  DD ${fmt(r.port?.dd)}%  | BTC ${fmt(r.single?.ret)}%  ${r.dynamic ? "dynamic" : "static"}`,
  );
}

console.log(`\nNotes:`);
console.log(`- Per-coin dynamic auto-tune (profile → sep/ST/brackets) applies only to SUPERTREND_ELITE / UNIFIED_ELITE when dynamic=Y.`);
console.log(`- Other strategies use static optimized presets (mostly tuned on 15m/BNB; 1h portfolio may underperform).`);
console.log(`- Portfolio replay: equal capital slice, shared account compounding (${PORTFOLIO.length} coins).`);
console.log(`- Only SUPERTREND_ELITE passes full OOS validation in research; high % figures can still be window/sizing sensitive.`);

await closePool?.();
