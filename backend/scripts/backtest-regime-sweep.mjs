#!/usr/bin/env node
/**
 * REGIME_ADAPTIVE config sweep — runs the full knob grid across symbols/timeframes
 * and ranks every configuration by net return so we can see the best-performing
 * cells (and how the knobs move the result).
 *
 * Full-window backtests only (fast). For the winners, re-run them through
 * scripts/backtest-validate-regime.mjs to get the OOS / MC / walk-forward gates.
 *
 * Usage:
 *   node scripts/backtest-regime-sweep.mjs
 *   SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT TF=15m node scripts/backtest-regime-sweep.mjs
 *   TOP=30 RISK_SCALE=1 node scripts/backtest-regime-sweep.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2026-01-01";
const TO = process.env.TO || "2026-06-01";
const START_USDT = Number(process.env.START_USDT || 1000);
const RISK_SCALE = Number(process.env.RISK_SCALE || 1);
const RISK_PCT = Number(process.env.RISK_PCT || 1.0);
const LEVERAGE = Number(process.env.LEVERAGE || 10);
const TOP = Number(process.env.TOP || 30);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildRegimeAdaptiveBacktestAdapter } = await import("../src/strategy/regimeAdaptive.js");

// ── Grid ──────────────────────────────────────────────────────────────────
const GRID = {
  minGrade: ["A", "B"],
  confFloor: [0.25, 0.45, 0.6],
  maxTrades: [2, 3, 5],
  enables: [
    { t: true, r: true, b: true, tag: "all" },
    { t: true, r: false, b: false, tag: "trend" },
    { t: false, r: true, b: false, tag: "range" },
    { t: false, r: false, b: true, tag: "breakout" },
    { t: true, r: false, b: true, tag: "trend+brk" },
    { t: false, r: true, b: true, tag: "range+brk" },
  ],
  rr: [
    { trend: 2.0, range: 1.5, brk: 2.0, tag: "rr-base" },
    { trend: 1.5, range: 1.2, brk: 1.5, tag: "rr-tight" },
    { trend: 3.0, range: 2.0, brk: 3.0, tag: "rr-wide" },
  ],
};

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();

const data = {};
for (const sym of SYMBOLS) {
  const candles = await readCandles(sym, TF, fromMs, toMs);
  if (!candles?.length) {
    console.log(`[skip] ${sym} ${TF}: no candles`);
    continue;
  }
  let funding = [];
  try {
    funding = await readFundingRates(sym, fromMs, toMs);
  } catch {
    funding = [];
  }
  data[sym] = { candles, funding };
}

function baseCfg(sym, g) {
  return {
    symbol: sym,
    marketMode: "FUTURES",
    futuresLeverage: LEVERAGE,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: RISK_PCT,
    riskPerTradeUnit: "PCT",
    slippagePct: 0.0005,
    regimeAdaptiveEnableTrend: g.en.t,
    regimeAdaptiveEnableRange: g.en.r,
    regimeAdaptiveEnableBreakout: g.en.b,
    regimeAdaptiveMinGrade: g.minGrade,
    regimeAdaptiveConfidenceFloor: g.confFloor,
    regimeAdaptiveMaxTradesPerDay: g.maxTrades,
    regimeAdaptiveMinBarGap: 8,
    regimeAdaptiveKillzoneMode: "LONDON_NY",
    regimeAdaptiveTrendRR: g.rr.trend,
    regimeAdaptiveRangeRR: g.rr.range,
    regimeAdaptiveBreakoutRR: g.rr.brk,
    regimeAdaptiveAtrSlMult: 1.1,
    riskScale: RISK_SCALE,
    volTargetSizing: false,
  };
}

async function runOne(sym, cfg) {
  const { candles, funding } = data[sym];
  const adapter = buildRegimeAdaptiveBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    strategyKey: "REGIME_ADAPTIVE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters: { REGIME_ADAPTIVE: adapter },
    symbol: sym,
  });
  return computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START_USDT });
}

const results = [];
let combo = 0;
const totalCombos =
  Object.keys(data).length *
  GRID.minGrade.length *
  GRID.confFloor.length *
  GRID.maxTrades.length *
  GRID.enables.length *
  GRID.rr.length;

console.log(`\n=== REGIME_ADAPTIVE sweep — ${Object.keys(data).join(", ")} ${TF} ${FROM}->${TO} ===`);
console.log(`riskScale=${RISK_SCALE} risk%=${RISK_PCT} lev=${LEVERAGE}x · ${totalCombos} configs\n`);

for (const sym of Object.keys(data)) {
  for (const minGrade of GRID.minGrade) {
    for (const confFloor of GRID.confFloor) {
      for (const maxTrades of GRID.maxTrades) {
        for (const en of GRID.enables) {
          for (const rr of GRID.rr) {
            const g = { minGrade, confFloor, maxTrades, en, rr };
            const cfg = baseCfg(sym, g);
            const m = await runOne(sym, cfg);
            results.push({
              sym,
              tag: `${en.tag}/${rr.tag}/g${minGrade}/cf${confFloor}/mt${maxTrades}`,
              net: m.totalReturnPct,
              trades: m.totalTrades,
              wr: (m.winRate || 0) * 100,
              pf: m.profitFactor || 0,
              dd: m.maxDrawdownPct,
              calmar: m.calmar ?? 0,
              sharpe: m.sharpe || 0,
              expR: m.expectancyR || 0,
            });
            combo++;
            if (combo % 25 === 0) process.stdout.write(`\r  ...${combo}/${totalCombos}`);
          }
        }
      }
    }
  }
}
process.stdout.write(`\r  ...${combo}/${totalCombos} done\n\n`);

results.sort((a, b) => b.net - a.net);

const fmt = (n, d = 1) => Number(n).toFixed(d);
const head =
  `${"#".padStart(3)}  ${"symbol".padEnd(8)}${"config".padEnd(40)}` +
  `${"net%".padStart(8)}${"trades".padStart(8)}${"wr%".padStart(6)}${"PF".padStart(6)}${"maxDD%".padStart(8)}${"Calmar".padStart(8)}${"Sharpe".padStart(8)}${"expR".padStart(8)}`;

console.log(`========== TOP ${TOP} CONFIGS BY NET RETURN ==========`);
console.log(head);
results.slice(0, TOP).forEach((r, i) => {
  console.log(
    `${String(i + 1).padStart(3)}  ${r.sym.padEnd(8)}${r.tag.padEnd(40)}` +
      `${fmt(r.net).padStart(8)}${String(r.trades).padStart(8)}${fmt(r.wr, 0).padStart(6)}${fmt(r.pf, 2).padStart(6)}${fmt(r.dd).padStart(8)}${fmt(r.calmar, 2).padStart(8)}${fmt(r.sharpe, 2).padStart(8)}${fmt(r.expR, 3).padStart(8)}`,
  );
});

const pos = results.filter((r) => r.net > 0);
console.log(`\nConfigs with net>0: ${pos.length}/${results.length}`);
const best = results[0];
console.log(`Best: ${best.sym} ${best.tag} -> net ${fmt(best.net)}% (trades ${best.trades}, PF ${fmt(best.pf, 2)}, maxDD ${fmt(best.dd)}%, Calmar ${fmt(best.calmar, 2)})`);

// Per-symbol best.
console.log(`\nBest per symbol:`);
for (const sym of Object.keys(data)) {
  const b = results.filter((r) => r.sym === sym)[0];
  if (b) console.log(`  ${sym.padEnd(9)} net ${fmt(b.net).padStart(7)}%  ${b.tag}`);
}

await closePool?.();
