#!/usr/bin/env node
/** Tune ADAPTIVE SL params for TOKYO_SESSION. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2026-01-01";
const TO = process.env.TO || "2026-06-08";
const RISK = Number(process.env.RISK || 2);

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const {
  buildTokyoSessionBacktestAdapter,
  resolveTokyoSessionCfg,
  tokyoSessionPadFromMs,
} = await import("../src/strategy/tokyoSessionIntraday.js");
const { TOKYO_SESSION_BNB_15M } = await import("../src/strategy/presets/tokyoSessionOptimized.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const candles = await readCandles(SYMBOL, TF, tokyoSessionPadFromMs(fromMs, TF), toMs, { market: "futures" });
const cost = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };

async function runOne(label, patch) {
  const cfg = resolveTokyoSessionCfg({ ...TOKYO_SESSION_BNB_15M, symbol: SYMBOL, timeframe: TF, riskPerTrade: RISK, ...patch });
  const adapter = buildTokyoSessionBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    candles,
    strategyKey: "TOKYO_SESSION",
    cfg: { ...cfg, symbol: SYMBOL },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    adapters: { TOKYO_SESSION: adapter },
    symbol: SYMBOL,
    costModelOverride: cost,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: 100 });
  const inW = sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
  const slExits = inW.filter((t) => t.exitReason === "sl").length;
  const tpExits = inW.filter((t) => t.exitReason === "tp" || t.exitReason === "tp2").length;
  return {
    label,
    ret: m.totalReturnPct ?? 0,
    n: inW.length,
    wr: (m.winRate ?? 0) * 100,
    dd: m.maxDrawdownPct ?? 0,
    pf: m.profitFactor ?? 0,
    slExits,
    tpExits,
    patch,
  };
}

const grid = [];
const mins = [0.002, 0.0025, 0.0028, 0.003, 0.0035];
const maxs = [0.005, 0.006, 0.007];
const atrs = [0.8, 1.0, 1.05, 1.2];
const spans = [0.25, 0.35, 0.5];
const rrs = [1, 1.5, 2];

// Baseline legacy
grid.push(await runOne("LEGACY FIRST2_RANGE 2R", { tokyoSlMode: "FIRST2_RANGE", tokyoTpRr: 2 }));

for (const min of mins) {
  for (const max of maxs) {
    if (min >= max) continue;
    for (const atr of atrs) {
      for (const span of spans) {
        for (const rr of rrs) {
          grid.push(
            await runOne(`ADAPT min=${min} max=${max} atr=${atr} sp=${span} ${rr}R`, {
              tokyoSlMode: "ADAPTIVE",
              tokyoSlMinPct: min,
              tokyoSlMaxPct: max,
              tokyoSlAtrMult: atr,
              tokyoSlSpanMult: span,
              tokyoTpRr: rr,
            }),
          );
        }
      }
    }
  }
}

grid.sort((a, b) => b.ret - a.ret);
console.log(`\n=== ADAPTIVE SL TUNE ${SYMBOL} ${TF} ${FROM}→${TO} @ ${RISK}% ===\n`);
for (const r of grid.slice(0, 20)) {
  console.log(
    `${r.label.padEnd(52)} ret=${r.ret.toFixed(1)}% wr=${r.wr.toFixed(0)}% sl=${r.slExits} tp=${r.tpExits} dd=${r.dd.toFixed(1)}% pf=${r.pf?.toFixed(2)}`,
  );
}
const best = grid[0];
console.log("\n=== BEST ===");
console.log(JSON.stringify(best, null, 2));
await closePool();
