#!/usr/bin/env node
/**
 * Compare FIXED (per-symbol) vs dynamic 1H EMA min-sep modes on SUPERTREND_ELITE 1H.
 *
 *   BASELINE  — FIXED + BTC/BNB symbol overrides (current production behavior)
 *   ATR       — minSep = k × (ATR_1h / price), k=0.25
 *   PERCENTILE — minSep = 1.0 × median(sep, last 90 completed 1H bars)
 *   ADX       — minSep = base × (1 + α × max(0, 25−ADX)/25)
 *   CALIBRATED — p40 of warmup 1H EMA sep (first 90 bars), constant thereafter
 *
 * Usage (from backend/):
 *   node scripts/backtest-elite-dynamic-sep-sweep.mjs
 *   FROM=2025-01-01 TO=2026-06-10 RISK=5 node scripts/backtest-elite-dynamic-sep-sweep.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2025-06-01";
const TO = process.env.TO || "2026-06-10";
const RISK = Number(process.env.RISK || 5);
const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,LINKUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const {
  buildEliteStBacktestAdapter,
  buildEliteStOptsFromCfg,
  normalizeEliteStRunCfg,
} = await import("../src/strategy/supertrendElite.js");
const { SUPERTREND_ELITE_1H_PRESET } = await import("../src/strategy/presets/supertrendEliteOptimized.js");

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();
const candleCache = {};

async function candles(sym) {
  if (!candleCache[sym]) {
    candleCache[sym] = await readCandles(sym, "1h", fromMs, toMs, { market: "futures" });
  }
  return candleCache[sym];
}

const MODES = [
  {
    id: "BASELINE",
    label: "BASELINE (FIXED + BTC/BNB rules)",
    patch: { eliteStHtf1hSepMode: "FIXED", eliteStHtf1hMinSep: 0.0003 },
  },
  {
    id: "ATR",
    label: "A — ATR-scaled (k=0.25)",
    patch: { eliteStHtf1hSepMode: "ATR", eliteStHtf1hMinSepAtrMult: 0.25 },
  },
  {
    id: "PERCENTILE",
    label: "B — Rolling median sep (90 bars)",
    patch: {
      eliteStHtf1hSepMode: "PERCENTILE",
      eliteStHtf1hSepPercentileLookback: 90,
      eliteStHtf1hSepPercentileMult: 1.0,
    },
  },
  {
    id: "ADX",
    label: "C — ADX-modulated (base 0.03%, α=1.5)",
    patch: {
      eliteStHtf1hSepMode: "ADX",
      eliteStHtf1hSepAdxBase: 0.0003,
      eliteStHtf1hSepAdxAlpha: 1.5,
      eliteStHtf1hSepAdxRef: 25,
    },
  },
  {
    id: "CALIBRATED",
    label: "D — Warmup p40 (90 bars)",
    patch: {
      eliteStHtf1hSepMode: "CALIBRATED",
      eliteStHtf1hSepCalibratePct: 40,
      eliteStHtf1hSepCalibrateBars: 90,
    },
  },
];

async function runSym(sym, modePatch) {
  const c = await candles(sym);
  if (!c.length) return null;
  const cfg = normalizeEliteStRunCfg({
    ...SUPERTREND_ELITE_1H_PRESET,
    symbol: sym,
    timeframe: "1h",
    marketMode: "FUTURES",
    riskPerTrade: RISK,
    futuresLeverage: 10,
    ...modePatch,
  });
  const sim = await runSimulation({
    strategyKey: "SUPERTREND_ELITE",
    candles: c,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 1000,
    timeframe: "1h",
    adapters: { SUPERTREND_ELITE: buildEliteStBacktestAdapter(c, buildEliteStOptsFromCfg(cfg)) },
    symbol: sym,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: "1h", startingEquity: 1000 });
  const trades = sim.trades.filter((t) => t.exitReason !== "tp1_partial");
  const liq = trades.filter((t) => t.exitReason === "liq").length;
  const effectiveSep =
    modePatch.eliteStHtf1hSepMode === "FIXED"
      ? cfg.eliteStHtf1hMinSep
      : modePatch.eliteStHtf1hSepMode;
  return {
    ret: Number(m.totalReturnPct ?? 0),
    dd: Number(m.maxDrawdownPct ?? 0),
    n: trades.length,
    pf: Number(m.profitFactor ?? 0),
    wr: Number(m.winRate ?? 0) * (m.winRate <= 1 ? 100 : 1),
    liq,
    sep: effectiveSep,
    bars: c.length,
  };
}

function fmt(n, d = 1) {
  return Number.isFinite(n) ? n.toFixed(d) : "—";
}

console.log(`\nSUPERTREND_ELITE 1H — dynamic sep comparison`);
console.log(`Window: ${FROM} → ${TO}  |  Risk: ${RISK}%  |  Leverage: 10×  |  Start: $1000\n`);

const allResults = {};

for (const mode of MODES) {
  console.log(`\n${"═".repeat(72)}`);
  console.log(mode.label);
  console.log(`${"═".repeat(72)}`);
  console.log(
    `${"Symbol".padEnd(10)}${"Bars".padStart(6)}${"Trades".padStart(7)}${"Ret%".padStart(10)}${"DD%".padStart(8)}${"PF".padStart(7)}${"WR%".padStart(7)}${"Liq".padStart(5)}${"Eff.sep".padStart(10)}`,
  );
  console.log("-".repeat(72));

  const rows = [];
  for (const sym of SYMBOLS) {
    const r = await runSym(sym, mode.patch);
    if (!r) {
      console.log(`${sym.padEnd(10)}${"no data".padStart(6)}`);
      continue;
    }
    rows.push({ sym, ...r });
    const sepStr =
      mode.id === "BASELINE"
        ? `${(Number(r.sep) * 100).toFixed(2)}%`
        : mode.id;
    console.log(
      `${sym.padEnd(10)}${String(r.bars).padStart(6)}${String(r.n).padStart(7)}${fmt(r.ret, 1).padStart(10)}${fmt(r.dd, 1).padStart(8)}${fmt(r.pf, 2).padStart(7)}${fmt(r.wr, 1).padStart(7)}${String(r.liq).padStart(5)}${sepStr.padStart(10)}`,
    );
  }

  const valid = rows.filter((r) => r.n > 0);
  const avgRet = valid.length ? valid.reduce((s, r) => s + r.ret, 0) / valid.length : 0;
  const avgDd = valid.length ? valid.reduce((s, r) => s + r.dd, 0) / valid.length : 0;
  const totalTrades = valid.reduce((s, r) => s + r.n, 0);
  const totalLiq = valid.reduce((s, r) => s + r.liq, 0);
  const pos = valid.filter((r) => r.ret > 0).length;
  console.log("-".repeat(72));
  console.log(
    `${"AVG/SUM".padEnd(10)}${"".padStart(6)}${String(totalTrades).padStart(7)}${fmt(avgRet, 1).padStart(10)}${fmt(avgDd, 1).padStart(8)}${"".padStart(7)}${"".padStart(7)}${String(totalLiq).padStart(5)}${`${pos}/${valid.length} +`.padStart(10)}`,
  );
  allResults[mode.id] = { mode, rows, avgRet, avgDd, totalTrades, totalLiq, pos, nCoins: valid.length };
}

console.log(`\n${"═".repeat(72)}`);
console.log("SUMMARY — rank by average return% (higher) then average DD% (lower)");
console.log(`${"═".repeat(72)}`);
const ranked = Object.values(allResults).sort((a, b) => b.avgRet - a.avgRet || a.avgDd - b.avgDd);
console.log(`${"Mode".padEnd(14)}${"AvgRet%".padStart(10)}${"AvgDD%".padStart(9)}${"Trades".padStart(8)}${"Liq".padStart(6)}${"+coins".padStart(8)}`);
for (const r of ranked) {
  console.log(
    `${r.mode.id.padEnd(14)}${fmt(r.avgRet, 1).padStart(10)}${fmt(r.avgDd, 1).padStart(9)}${String(r.totalTrades).padStart(8)}${String(r.totalLiq).padStart(6)}${`${r.pos}/${r.nCoins}`.padStart(8)}`,
  );
}

await closePool?.().catch(() => {});
process.exit(0);
