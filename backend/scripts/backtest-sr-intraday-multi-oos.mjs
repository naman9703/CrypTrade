#!/usr/bin/env node
/**
 * SR_INTRADAY multi-coin setup search + walk-forward OOS.
 * Tests prominent solo gates (LIQ / FIB / ICT / SR-A+) with realistic costs.
 *
 *   cd backend && node scripts/backtest-sr-intraday-multi-oos.mjs
 *   QUICK=1 node scripts/backtest-sr-intraday-multi-oos.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const QUICK = process.env.QUICK === "1";
const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,LINKUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const IS_FROM = process.env.IS_FROM || "2026-01-01";
const IS_TO = process.env.IS_TO || "2026-04-30";
const OOS_FROM = process.env.OOS_FROM || "2026-05-01";
const OOS_TO = process.env.OOS_TO || "2026-06-15";
const START = Number(process.env.START_USDT || 1000);
const TF = process.env.TF || "15m";

const {
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_LIQ_ETH_15M,
  INTRADAY_PRO_FIB_15M,
  INTRADAY_PRO_ICT_15M,
  INTRADAY_PRO_SR_APLUS_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");

const COST = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };

const candleCache = new Map();

async function candlesFor(sym, fromMs, toMs) {
  const key = `${sym}|${TF}|${fromMs}|${toMs}`;
  if (!candleCache.has(key)) {
    const pad = 90 * 86400000;
    candleCache.set(key, await readCandles(sym, TF, fromMs - pad, toMs, { market: "futures" }));
  }
  return candleCache.get(key);
}

function daysBetween(fromMs, toMs) {
  return Math.max(1, (toMs - fromMs) / 86400000);
}

async function runWindow({ sym, presetBase, patch, fromMs, toMs }) {
  const candles = await candlesFor(sym, fromMs, toMs);
  if (!candles?.length) return null;
  clearIntradayAdapterCache();
  const cfg = materializeIntradayEngineCfgSync(
    { ...presetBase, ...patch, symbol: sym, timeframe: TF },
    materializeIntradayPanelOnCfg,
  );
  const merged = mergeAdaptiveCfg(cfg, candles);
  const sim = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: { ...merged, symbol: sym, timeframe: TF, manualStrategy: "SR_INTRADAY", marketMode: "FUTURES" },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    symbol: sym,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, TF) },
    costModelOverride: { ...COST, leverage: Number(merged.futuresLeverage ?? 12) },
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  const days = daysBetween(fromMs, toMs);
  const inWindow = sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
  const dailyRet = (Number(m.totalReturnPct ?? 0) / days);
  return {
    n: inWindow.length,
    tpd: inWindow.length / days,
    retPct: Number(m.totalReturnPct ?? 0),
    dailyRetPct: dailyRet,
    monthlyRetPct: dailyRet * 30,
    wr: Number(m.winRate ?? 0) * 100,
    pf: Number(m.profitFactor ?? 0),
    dd: Number(m.maxDrawdownPct ?? 0),
    sharpe: Number(m.sharpe ?? 0),
    expectancy: Number(m.expectancy ?? 0),
  };
}

function buildConfigs() {
  const liqGrid = [];
  const sweepExt = QUICK ? [0.006] : [0.004, 0.006, 0.008];
  const minRr = QUICK ? [1.5] : [1.5, 2.0];
  const maxDay = QUICK ? [3] : [2, 3, 5];
  const risk = QUICK ? [2.5] : [2, 2.5, 3.5, 5];

  for (const ext of sweepExt) {
    for (const rr of minRr) {
      for (const md of maxDay) {
        for (const r of risk) {
          liqGrid.push({
            name: `liq_ext${(ext * 100).toFixed(1)}_rr${rr}_d${md}_r${r}`,
            base: INTRADAY_PRO_LIQ_15M,
            patch: {
              intradayLiqMinSweepExtensionPct: ext,
              intradayLiqMinRr: rr,
              srIntradayMaxTradesPerDay: md,
              riskPerTrade: r,
              intradayLiqOnePickPerDay: md <= 2,
            },
          });
        }
      }
    }
  }

  const fixed = [
    { name: "liq_eth_ladder", base: INTRADAY_PRO_LIQ_ETH_15M, patch: {} },
    { name: "fib_sniper", base: INTRADAY_PRO_FIB_15M, patch: {} },
    { name: "ict_sweep", base: INTRADAY_PRO_ICT_15M, patch: { riskPerTrade: 2.5 } },
    { name: "sr_aplus", base: INTRADAY_PRO_SR_APLUS_15M, patch: {} },
    {
      name: "liq_hf",
      base: INTRADAY_PRO_LIQ_15M,
      patch: {
        intradayLiqMinSweepExtensionPct: 0.004,
        intradayLiqMinRr: 1.5,
        intradayLiqMinScore: 5,
        srIntradayMaxTradesPerDay: 5,
        srIntradayMinBarGap: 2,
        intradayLiqOnePickPerDay: false,
        riskPerTrade: 3,
      },
    },
  ];

  return [...liqGrid, ...fixed];
}

async function evalConfig(cfg, isFrom, isTo, oosFrom, oosTo) {
  const perCoinIs = [];
  const perCoinOos = [];
  for (const sym of SYMBOLS) {
    const is = await runWindow({ sym, presetBase: cfg.base, patch: cfg.patch, fromMs: isFrom, toMs: isTo });
  if (!is) continue;
    const oos = await runWindow({ sym, presetBase: cfg.base, patch: cfg.patch, fromMs: oosFrom, toMs: oosTo });
    perCoinIs.push({ sym, ...is });
    if (oos) perCoinOos.push({ sym, ...oos });
  }
  if (!perCoinIs.length) return null;

  const avg = (rows, k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);
  const posIs = perCoinIs.filter((r) => r.retPct > 0).length;
  const posOos = perCoinOos.filter((r) => r.retPct > 0).length;

  return {
    name: cfg.name,
    patch: cfg.patch,
    base: cfg.base,
    coins: perCoinIs.length,
    posIs,
    posOos,
    isTrades: sum(perCoinIs, "n"),
    isTpd: avg(perCoinIs, "tpd"),
    isRet: avg(perCoinIs, "retPct"),
    isDaily: avg(perCoinIs, "dailyRetPct"),
    isMonthly: avg(perCoinIs, "monthlyRetPct"),
    isWr: avg(perCoinIs, "wr"),
    isPf: avg(perCoinIs, "pf"),
    isDd: Math.max(...perCoinIs.map((r) => r.dd)),
    oosRet: perCoinOos.length ? avg(perCoinOos, "retPct") : null,
    oosDaily: perCoinOos.length ? avg(perCoinOos, "dailyRetPct") : null,
    oosPf: perCoinOos.length ? avg(perCoinOos, "pf") : null,
    perCoinIs,
    perCoinOos,
  };
}

function score(r) {
  const oosBonus = r.oosRet != null && r.oosRet > 0 ? 40 : r.oosRet != null && r.oosRet > -2 ? 10 : -20;
  const breadth = (r.posOos / Math.max(1, r.coins)) * 30 + (r.posIs / Math.max(1, r.coins)) * 20;
  const freq = r.isTpd >= 0.5 && r.isTpd <= 4 ? 25 : r.isTpd > 0.2 ? 10 : 0;
  const profit = r.isRet * 2 + (r.isPf > 1.2 ? 40 : r.isPf > 1 ? 20 : 0);
  const daily = r.isDaily >= 2 ? 80 : r.isDaily >= 1 ? 40 : r.isDaily >= 0.3 ? 15 : 0;
  return oosBonus + breadth + freq + profit + daily - r.isDd * 0.5;
}

if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const isFrom = Date.parse(IS_FROM);
const isTo = Date.parse(IS_TO);
const oosFrom = Date.parse(OOS_FROM);
const oosTo = Date.parse(OOS_TO);
const configs = buildConfigs();

console.log(`\n=== SR_INTRADAY multi-coin OOS search ===`);
console.log(`Coins: ${SYMBOLS.join(", ")} · ${TF}`);
console.log(`IS: ${IS_FROM} → ${IS_TO} · OOS: ${OOS_FROM} → ${OOS_TO}`);
console.log(`Configs: ${configs.length}${QUICK ? " (QUICK)" : ""}\n`);

const results = [];
let i = 0;
for (const c of configs) {
  i++;
  process.stdout.write(`\r[${i}/${configs.length}] ${c.name}…`);
  const r = await evalConfig(c, isFrom, isTo, oosFrom, oosTo);
  if (r) results.push({ ...r, sc: score(r) });
}
console.log("\n");

results.sort((a, b) => b.sc - a.sc);

console.log("── Top configs (IS avg per coin, OOS validated) ──");
console.log(
  `${"name".padEnd(28)} ${"IS ret%".padStart(8)} ${"IS d%/d".padStart(8)} ${"IS mo%".padStart(8)} ${"tpd".padStart(5)} ${"PF".padStart(5)} ${"OOS%".padStart(7)} ${"+coins".padStart(6)} score`,
);
for (const r of results.slice(0, 12)) {
  console.log(
    `${r.name.padEnd(28)} ${r.isRet.toFixed(1).padStart(8)} ${r.isDaily.toFixed(2).padStart(8)} ${r.isMonthly.toFixed(1).padStart(8)} ${r.isTpd.toFixed(2).padStart(5)} ${r.isPf.toFixed(2).padStart(5)} ${(r.oosRet ?? 0).toFixed(1).padStart(7)} ${`${r.posOos}/${r.coins}`.padStart(6)} ${r.sc.toFixed(0)}`,
  );
}

const best = results[0];
if (best) {
  console.log(`\n── Best: ${best.name} ──`);
  console.log("IS per coin:");
  for (const c of best.perCoinIs) {
    console.log(
      `  ${c.sym.padEnd(10)} n=${String(c.n).padStart(3)} ret=${c.retPct.toFixed(1).padStart(6)}% d=${c.dailyRetPct.toFixed(2)}%/d WR=${c.wr.toFixed(0)}% PF=${c.pf.toFixed(2)}`,
    );
  }
  if (best.perCoinOos?.length) {
    console.log("OOS per coin:");
    for (const c of best.perCoinOos) {
      console.log(
        `  ${c.sym.padEnd(10)} n=${String(c.n).padStart(3)} ret=${c.retPct.toFixed(1).padStart(6)}% d=${c.dailyRetPct.toFixed(2)}%/d WR=${c.wr.toFixed(0)}% PF=${c.pf.toFixed(2)}`,
      );
    }
  }
  console.log("\nRecommended patch (merge with INTRADAY_PRO_LIQ_15M or gate preset):");
  console.log(JSON.stringify(best.patch, null, 2));
}

await closePool().catch(() => {});
