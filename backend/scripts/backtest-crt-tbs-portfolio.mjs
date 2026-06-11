#!/usr/bin/env node
/**
 * CRT+TBS multi-coin portfolio — aggregate trade frequency & return.
 * Usage: SYMBOLS=BNBUSDT,ETHUSDT,LINKUSDT node scripts/backtest-crt-tbs-portfolio.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOLS = (process.env.SYMBOLS || "BNBUSDT,ETHUSDT,LINKUSDT,BTCUSDT").split(",").map((s) => s.trim());
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-05";
const RISK = Number(process.env.RISK || 2);
const PRESET = process.env.PRESET || "v2"; // v2 | freq

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildCrtTbsBacktestAdapter, resolveCrtTbsCfg, crtTbsPadFromMs } = await import("../src/strategy/crtTbsIntraday.js");
const { CRT_TBS_BNB_15M, CRT_TBS_BNB_15M_FREQ } = await import("../src/strategy/presets/crtTbsOptimized.js");
const { aggregateSituationEntries } = await import("./lib/situationBacktestMetrics.mjs");

await initPool({ info: () => {}, warn: () => {}, error: console.error });

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const calDays = (toMs - fromMs) / 86_400_000;
const cost = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };
const basePreset = PRESET === "freq" ? CRT_TBS_BNB_15M_FREQ : CRT_TBS_BNB_15M;

let allEntries = [];
let totalRet = 0;

console.log(`\n=== CRT+TBS PORTFOLIO ${TF} ${FROM} → ${TO} preset=${PRESET} ===\n`);

for (const symbol of SYMBOLS) {
  let candles;
  try {
    candles = await readCandles(symbol, TF, crtTbsPadFromMs(fromMs, TF), toMs, { market: "futures" });
  } catch {
    console.log(symbol, "— no data, skip");
    continue;
  }
  if (candles.length < 500) {
    console.log(symbol, "— thin data", candles.length);
    continue;
  }
  const cfg = resolveCrtTbsCfg({ ...basePreset, symbol, timeframe: TF, riskPerTrade: RISK });
  const adapter = buildCrtTbsBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    candles,
    strategyKey: "CRT_TBS",
    cfg: { ...cfg, symbol },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    adapters: { CRT_TBS: adapter },
    symbol,
    costModelOverride: cost,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 100,
  });
  const list = aggregateSituationEntries(sim.trades, fromMs, toMs);
  const wins = list.filter((t) => t.pnlPct > 0).length;
  allEntries = allEntries.concat(list.map((t) => ({ ...t, symbol })));
  totalRet += m.totalReturnPct ?? 0;
  console.log(
    symbol.padEnd(10),
    "n=" + String(list.length).padStart(3),
    "ret=" + ((m.totalReturnPct ?? 0).toFixed(1) + "%").padStart(7),
    "wr=" + (list.length ? ((wins / list.length) * 100).toFixed(0) : "0") + "%",
    "tpd=" + (list.length / calDays).toFixed(3),
  );
}

const portDays = new Set(allEntries.map((t) => new Date(t.ts).toISOString().slice(0, 10)));
const portWins = allEntries.filter((t) => t.pnlPct > 0).length;

console.log("\n--- Portfolio aggregate ---");
console.log("Total entries:", allEntries.length);
console.log("Calendar days with ≥1 trade:", portDays.size);
console.log("Trades / calendar day:", (allEntries.length / calDays).toFixed(3));
console.log("Trades / active day:", portDays.size ? (allEntries.length / portDays.size).toFixed(2) : 0);
console.log("Sum of per-coin returns (equal $100 each):", totalRet.toFixed(1) + "%");
console.log("Portfolio win rate:", allEntries.length ? ((portWins / allEntries.length) * 100).toFixed(1) + "%" : "n/a");

await closePool();
