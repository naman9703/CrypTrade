#!/usr/bin/env node
/**
 * SR_INTRADAY standalone technique matrix — multi-coin 15m, 5 random months.
 * Includes loosened VP / full-stack / big-move variants.
 *
 * Usage (from backend/):
 *   node scripts/backtest-sr-intraday-bnb-standalone.mjs
 *   SYMBOLS=BTCUSDT,ETHUSDT node scripts/backtest-sr-intraday-bnb-standalone.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOLS = String(process.env.SYMBOLS || process.env.SYMBOL || "BNBUSDT,BTCUSDT,ETHUSDT")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TF = process.env.TF || "15m";
const START = Number(process.env.START_USDT || 10_000);
const RISK = Number(process.env.RISK_PCT || 2.5);
const TUNE_MONTHS = Math.max(1, Number(process.env.TUNE_MONTHS || 3));

const DEFAULT_MONTHS = ["2025-07", "2025-09", "2025-11", "2026-01", "2026-04"];
const MONTHS = String(process.env.MONTHS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TEST_MONTHS = MONTHS.length ? MONTHS : DEFAULT_MONTHS;

function monthWindow(ym) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  const to = `${nextY}-${String(nextM).padStart(2, "0")}-01`;
  return { from, to, label: ym };
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const {
  INTRADAY_PRO_BASE,
  INTRADAY_PRO_15M,
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_LIQ_DAILY_15M,
  INTRADAY_PRO_ICT_15M,
  INTRADAY_PRO_ICT_FULL_15M,
  INTRADAY_PRO_ICT_RESEARCH_15M,
  INTRADAY_PRO_FIB_15M,
  INTRADAY_PRO_VP_15M,
  INTRADAY_PRO_SR_APLUS_15M,
  INTRADAY_PRO_BIGMOVE_15M,
  materializeIntradayEngineCfg,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

function soloGates(overrides = {}) {
  return {
    intradayGateLiquidity: false,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
    intradayGateSmcIct: false,
    intradayGateInstitutionalSr: false,
    intradayLearnedRulesEnabled: false,
    supertrendHtf4hEnabled: false,
    intradayMinTechniqueCount: 1,
    intradayRequireFibOrVp: false,
    intradayRequireSessionReclaim: false,
    supertrendFuturesFixedSlPct: 0,
    supertrendFuturesFixedTpPct: 0,
    ...overrides,
  };
}

function buildVariants(symbol) {
  const SESSION_SOLO = {
    ...INTRADAY_PRO_BASE,
    ...soloGates({ intradayGateSession: true, intradayRequireSessionReclaim: true }),
    symbol,
    timeframe: TF,
    srIntradayMinScore: 6,
    srIntradayMaxTradesPerDay: 4,
  };

  const ORDER_FLOW_SOLO = {
    ...INTRADAY_PRO_BASE,
    ...soloGates({ intradayGateOrderFlow: true }),
    symbol,
    timeframe: TF,
    srIntradayMinScore: 6,
    srIntradayMaxTradesPerDay: 4,
  };

  const VP_SOLO = {
    ...INTRADAY_PRO_VP_15M,
    ...soloGates({ intradayGateVp: true }),
    symbol,
    timeframe: TF,
    intradayVpBrackets: true,
    volumeProfileSoftGates: true,
    volumeProfileGatesEnabled: false,
    requireVpSetup: false,
  };

  const VP_LOOSE = {
    ...VP_SOLO,
    srIntradayMinScore: 5,
    vpMinRR: 1.0,
    vpMinRunPct: 0.002,
    vpLookbackBars: 480,
    intradayLvnSizeMult: 1.5,
  };

  const FULL_STACK_LOOSE = {
    ...INTRADAY_PRO_15M,
    symbol,
    timeframe: TF,
    srIntradayMinScore: 5,
    intradayBigMoveMinScore: 8,
    intradayMinTechniqueCount: 2,
    intradayRequireFibOrVp: false,
    intradaySoloGateMinScore: 4,
    intradayLearnedRulesEnabled: false,
  };

  const BIGMOVE_LOOSE = {
    ...INTRADAY_PRO_BIGMOVE_15M,
    symbol,
    timeframe: TF,
    intradayTierMode: "all",
    srIntradayMinScore: 7,
    intradayBigMoveMinScore: 8,
    intradayMinTechniqueCount: 2,
    intradayRequireFibOrVp: false,
    intradayLearnedRulesEnabled: false,
  };

  return [
    {
      id: "liquidity",
      label: "Liquidity PDH/PDL",
      base: { ...INTRADAY_PRO_LIQ_15M, symbol, timeframe: TF },
      tune: [
        { intradayLiqMinRr: 1.25, intradayLiqMinSweepExtensionPct: 0.006, intradayLiqMinReclaimBodyRatio: 0.25 },
        { intradayLiqMinRr: 1.5, intradayLiqMinSweepExtensionPct: 0.008, intradayLiqMinReclaimBodyRatio: 0.35 },
        { intradayLiqMinRr: 1.75, intradayLiqMinSweepExtensionPct: 0.01, intradayLiqMinReclaimBodyRatio: 0.45 },
      ],
    },
    {
      id: "liquidity_daily",
      label: "Liquidity + trend continuation",
      base: { ...INTRADAY_PRO_LIQ_DAILY_15M, symbol, timeframe: TF },
      tune: [
        { intradayLiqMinRr: 1.25, intradayLiqMinScore: 7 },
        { intradayLiqMinRr: 1.5, intradayLiqMinScore: 9 },
        { intradayLiqMinRr: 1.75, intradayLiqMinScore: 10 },
      ],
    },
    {
      id: "smc_sweep",
      label: "SMC/ICT sweep",
      base: { ...INTRADAY_PRO_ICT_15M, symbol, timeframe: TF },
      tune: [
        { intradaySmcMinRr: 1.25, intradaySmcMinAdx: 10, intradaySmcMinScore: 6 },
        { intradaySmcMinRr: 1.5, intradaySmcMinAdx: 12, intradaySmcMinScore: 7 },
        { intradaySmcMinRr: 1.75, intradaySmcMinAdx: 15, intradaySmcMinScore: 8 },
      ],
    },
    {
      id: "smc_full",
      label: "SMC/ICT full stack",
      base: { ...INTRADAY_PRO_ICT_FULL_15M, symbol, timeframe: TF },
      tune: [
        { intradaySmcMinRr: 1.25, intradaySmcMinScore: 7 },
        { intradaySmcMinRr: 1.5, intradaySmcMinScore: 8 },
        { intradaySmcMinRr: 1.75, intradaySmcMinScore: 9 },
      ],
    },
    {
      id: "smc_research",
      label: "SMC research (CHoCH+FVG)",
      base: { ...INTRADAY_PRO_ICT_RESEARCH_15M, symbol, timeframe: TF },
      tune: [{ intradaySmcMinRr: 1.25 }, { intradaySmcMinRr: 1.5 }, { intradaySmcMinRr: 1.75 }],
    },
    {
      id: "fibonacci",
      label: "Fibonacci golden pocket",
      base: { ...INTRADAY_PRO_FIB_15M, symbol, timeframe: TF },
      tune: [
        { intradayFibMinRr: 1.25, intradayFibMinAdx: 18 },
        { intradayFibMinRr: 1.5, intradayFibMinAdx: 20 },
        { intradayFibMinRr: 1.75, intradayFibMinAdx: 22 },
      ],
    },
    {
      id: "volume_profile",
      label: "Volume Profile (solo)",
      base: VP_SOLO,
      tune: [
        { vpMinRR: 1.2, srIntradayMinScore: 6 },
        { vpMinRR: 1.35, srIntradayMinScore: 7 },
        { vpMinRR: 1.5, srIntradayMinScore: 8 },
      ],
    },
    {
      id: "volume_profile_loose",
      label: "Volume Profile (loose)",
      base: VP_LOOSE,
      tune: [
        { vpMinRR: 0.9, srIntradayMinScore: 4, vpMinRunPct: 0.0015 },
        { vpMinRR: 1.0, srIntradayMinScore: 5, vpMinRunPct: 0.002 },
        { vpMinRR: 1.1, srIntradayMinScore: 6, vpMinRunPct: 0.0025 },
      ],
    },
    {
      id: "institutional_sr",
      label: "Institutional S/R A+",
      base: { ...INTRADAY_PRO_SR_APLUS_15M, symbol, timeframe: TF },
      tune: [
        { intradayLiqMinRr: 1.5, intradaySrMinVolRatio: 1.0 },
        { intradayLiqMinRr: 2.0, intradaySrMinVolRatio: 1.15 },
        { intradayLiqMinRr: 2.5, intradaySrMinVolRatio: 1.3 },
      ],
    },
    {
      id: "session",
      label: "Session reclaim",
      base: SESSION_SOLO,
      tune: [
        { srIntradayMinScore: 5, srIntradayMaxTradesPerDay: 3 },
        { srIntradayMinScore: 6, srIntradayMaxTradesPerDay: 4 },
        { srIntradayMinScore: 7, srIntradayMaxTradesPerDay: 5 },
      ],
    },
    {
      id: "order_flow",
      label: "Order flow / CVD",
      base: ORDER_FLOW_SOLO,
      tune: [
        { srIntradayMinScore: 5, srIntradayMaxTradesPerDay: 3 },
        { srIntradayMinScore: 6, srIntradayMaxTradesPerDay: 4 },
        { srIntradayMinScore: 7, srIntradayMaxTradesPerDay: 5 },
      ],
    },
    {
      id: "full_stack",
      label: "Full confluence stack",
      base: { ...INTRADAY_PRO_15M, symbol, timeframe: TF },
      tune: [
        { srIntradayMinScore: 7, intradayBigMoveMinScore: 10 },
        { srIntradayMinScore: 8, intradayBigMoveMinScore: 11 },
        { srIntradayMinScore: 9, intradayBigMoveMinScore: 12 },
      ],
    },
    {
      id: "full_stack_loose",
      label: "Full stack (loose)",
      base: FULL_STACK_LOOSE,
      tune: [
        { srIntradayMinScore: 4, intradayMinTechniqueCount: 1 },
        { srIntradayMinScore: 5, intradayMinTechniqueCount: 2 },
        { srIntradayMinScore: 6, intradayMinTechniqueCount: 2 },
      ],
    },
    {
      id: "bigmove",
      label: "Tier-A big-move trail",
      base: { ...INTRADAY_PRO_BIGMOVE_15M, symbol, timeframe: TF },
      tune: [
        { srIntradayMinScore: 9, intradayBigMoveMinScore: 10 },
        { srIntradayMinScore: 10, intradayBigMoveMinScore: 11 },
        { srIntradayMinScore: 11, intradayBigMoveMinScore: 12 },
      ],
    },
    {
      id: "bigmove_loose",
      label: "Big-move trail (loose)",
      base: BIGMOVE_LOOSE,
      tune: [
        { srIntradayMinScore: 6, intradayBigMoveMinScore: 7, intradayMinTechniqueCount: 1 },
        { srIntradayMinScore: 7, intradayBigMoveMinScore: 8, intradayMinTechniqueCount: 2 },
        { srIntradayMinScore: 8, intradayBigMoveMinScore: 9, intradayMinTechniqueCount: 2 },
      ],
    },
  ];
}

const windows = TEST_MONTHS.map(monthWindow);
const tuneWindows = windows.slice(0, TUNE_MONTHS);
const oosWindows = windows.slice(TUNE_MONTHS);

function logicalTrades(trades, fromMs, toMs) {
  const seen = new Set();
  let n = 0;
  for (const t of trades) {
    const ts = Number(t.entryTs);
    if (!(ts >= fromMs && ts < toMs)) continue;
    const key = `${ts}:${t.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    n += 1;
  }
  return n;
}

function scoreAgg(rows) {
  const ok = rows.filter((r) => !r.error);
  if (!ok.length) return -1e9;
  const ret = ok.reduce((s, r) => s + r.ret, 0) / ok.length;
  const dd = ok.reduce((s, r) => s + r.dd, 0) / ok.length;
  const trades = ok.reduce((s, r) => s + r.trades, 0) / ok.length;
  const pf = ok.reduce((s, r) => s + (Number.isFinite(r.pf) ? r.pf : 0), 0) / ok.length;
  return ret - dd * 0.7 + Math.min(pf, 3) * 3 - Math.abs(trades - 15) * 0.2;
}

async function runMatrixForSymbol(symbol) {
  const candleCache = new Map();
  const variants = buildVariants(symbol);

  const common = {
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    marketMode: "FUTURES",
    symbol,
    timeframe: TF,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: RISK,
    riskPerTradeUnit: "PCT",
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    futuresLeverage: 12,
  };

  async function loadCandles(window) {
    const key = `${symbol}|${window.label}`;
    if (candleCache.has(key)) return candleCache.get(key);
    const fromMs = Date.parse(window.from);
    const toMs = Date.parse(window.to);
    const warmupMs = 21 * 86_400_000;
    const candles = await readCandles(symbol, TF, fromMs - warmupMs, toMs, { market: "futures" });
    const v = { candles, fromMs, toMs };
    candleCache.set(key, v);
    return v;
  }

  async function runMonth(window, baseCfg, tunePatch = {}) {
    const { candles, fromMs, toMs } = await loadCandles(window);
    if (!candles?.length) return { error: "no_candles", label: window.label };

    const cfg = await materializeIntradayEngineCfg({
      ...baseCfg,
      ...common,
      ...tunePatch,
      backtestSignalStartMs: fromMs,
    });

    const adapters = await buildBacktestAdapters({
      strategyKey: "SR_INTRADAY",
      cfg,
      symbol,
      tf: TF,
      candles,
      fromMs: Number(candles[0]?.ts) || fromMs,
    });
    const sim = await runSimulation({
      strategyKey: "SR_INTRADAY",
      candles,
      cfg,
      costModelOverride: { slippagePct: 0.0005 },
      gateMode: "off",
      fundingRates: [],
      startingUsdt: START,
      timeframe: TF,
      symbol,
      adapters,
    });
    const inWin = sim.trades.filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
    const metrics = computeAllMetrics({
      trades: inWin,
      equityCurve: sim.equityCurve,
      tf: TF,
      startingEquity: START,
    });
    const days = Math.max(1, (toMs - fromMs) / 86_400_000);
    const trades = logicalTrades(sim.trades, fromMs, toMs);
    return {
      label: window.label,
      trades,
      perDay: trades / days,
      ret: Number(metrics.totalReturnPct ?? 0),
      pf: Number(metrics.profitFactor ?? 0),
      wr: Number(metrics.winRate ?? 0) * 100,
      dd: Number(metrics.maxDrawdownPct ?? 0),
      avgR: Number(metrics.expectancyR ?? 0),
    };
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`SR_INTRADAY standalone | ${symbol} ${TF} | months=${TEST_MONTHS.join(",")}`);
  console.log(`Risk ${RISK}%/trade | tune=${tuneWindows.map((w) => w.label).join(",")} | oos=${oosWindows.map((w) => w.label).join(",")}`);

  const summary = [];

  for (const variant of variants) {
    let bestTune = variant.tune[0];
    let bestScore = -1e9;

    for (const tune of variant.tune) {
      const rows = [];
      for (const w of tuneWindows) {
        rows.push(await runMonth(w, variant.base, tune));
      }
      const sc = scoreAgg(rows);
      if (sc > bestScore) {
        bestScore = sc;
        bestTune = tune;
      }
    }

    const monthRows = [];
    for (const w of windows) {
      const phase = oosWindows.some((o) => o.label === w.label) ? "oos" : "is";
      const r = await runMonth(w, variant.base, bestTune);
      monthRows.push({ ...r, phase });
    }

    const ok = monthRows.filter((r) => !r.error);
    const isRows = ok.filter((r) => r.phase === "is");
    const oosRows = ok.filter((r) => r.phase === "oos");
    const avg = (rows, k) => (rows.length ? rows.reduce((s, r) => s + r[k], 0) / rows.length : 0);

    const row = {
      id: variant.id,
      label: variant.label,
      bestTune,
      is: {
        avgRetMo: Number(avg(isRows, "ret").toFixed(2)),
        avgDd: Number(avg(isRows, "dd").toFixed(2)),
        avgTrades: Number(avg(isRows, "trades").toFixed(1)),
        avgPf: Number(avg(isRows, "pf").toFixed(2)),
      },
      oos: {
        avgRetMo: Number(avg(oosRows, "ret").toFixed(2)),
        avgDd: Number(avg(oosRows, "dd").toFixed(2)),
        avgTrades: Number(avg(oosRows, "trades").toFixed(1)),
        avgPf: Number(avg(oosRows, "pf").toFixed(2)),
      },
      all5: {
        avgRetMo: Number(avg(ok, "ret").toFixed(2)),
        avgDd: Number(avg(ok, "dd").toFixed(2)),
        avgTrades: Number(avg(ok, "trades").toFixed(1)),
        avgPerDay: Number(avg(ok, "perDay").toFixed(2)),
        avgPf: Number(avg(ok, "pf").toFixed(2)),
        avgR: Number(avg(ok, "avgR").toFixed(3)),
      },
    };
    summary.push(row);
    console.log(JSON.stringify({ variant: variant.id, all5: row.all5, oos: row.oos, trades: row.all5.avgTrades }));
  }

  summary.sort((a, b) => b.all5.avgRetMo - a.all5.avgRetMo);

  console.log(`\n--- ${symbol} RANKED ---`);
  for (const r of summary) {
    console.log(
      `${r.label.padEnd(30)} ret=${String(r.all5.avgRetMo).padStart(7)}%  dd=${String(r.all5.avgDd).padStart(5)}%  ` +
        `tr/mo=${String(r.all5.avgTrades).padStart(5)}  oos=${String(r.oos.avgRetMo).padStart(7)}%`,
    );
  }

  return { symbol, variants: summary };
}

console.log(`SR_INTRADAY multi-coin standalone matrix`);
console.log(`Symbols: ${SYMBOLS.join(", ")} | TF=${TF} | months=${TEST_MONTHS.join(",")}`);

const allResults = [];
for (const symbol of SYMBOLS) {
  allResults.push(await runMatrixForSymbol(symbol));
}

console.log(`\n${"=".repeat(72)}`);
console.log("=== CROSS-COIN LEADERS (avg ret/mo, all 5 months) ===");
const flat = allResults.flatMap((r) => r.variants.map((v) => ({ symbol: r.symbol, ...v })));
flat.sort((a, b) => b.all5.avgRetMo - a.all5.avgRetMo);
for (const r of flat.slice(0, 15)) {
  console.log(
    `${r.symbol.padEnd(10)} ${r.label.padEnd(28)} ret=${String(r.all5.avgRetMo).padStart(7)}%  ` +
      `dd=${String(r.all5.avgDd).padStart(5)}%  tr/mo=${String(r.all5.avgTrades).padStart(5)}  oos=${String(r.oos.avgRetMo).padStart(7)}%`,
  );
}

console.log("\n=== LOOSE VARIANTS CHECK (trades/mo across coins) ===");
for (const id of ["volume_profile_loose", "full_stack_loose", "bigmove_loose", "volume_profile", "full_stack", "bigmove"]) {
  const rows = flat.filter((r) => r.id === id);
  if (!rows.length) continue;
  const avgTr = rows.reduce((s, r) => s + r.all5.avgTrades, 0) / rows.length;
  const avgRet = rows.reduce((s, r) => s + r.all5.avgRetMo, 0) / rows.length;
  console.log(`${id.padEnd(24)} avgTr/mo=${avgTr.toFixed(1)}  avgRet/mo=${avgRet.toFixed(2)}%  (${rows.map((r) => `${r.symbol}:${r.all5.avgTrades}`).join(", ")})`);
}

await closePool?.();
