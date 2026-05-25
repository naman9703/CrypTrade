#!/usr/bin/env node
/**
 * ST-only + Big-move indicator gate sweep (intelligence gate OFF).
 *
 *   node scripts/backtest-st-bigmove-sweep.mjs --symbol BNBUSDT
 *   node scripts/backtest-st-bigmove-sweep.mjs --symbol BTCUSDT --from 2026-01-01 --to 2026-05-20
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const symbol = String(arg("symbol", "BNBUSDT")).toUpperCase();
const tf = String(arg("tf", "15m"));
const fromMs = new Date(arg("from", "2026-01-01")).getTime();
const toMs = new Date(arg("to", "2026-05-20")).getTime();
const capital = Number(arg("capital", "100"));
const topN = Math.max(15, Number(arg("top", "25")));
const targetWr = Number(arg("targetWr", "80"));
const minTrades = Math.max(4, Number(arg("minTrades", "8")));

const STRENGTH = [60, 65, 70, 75];
const MOVE_SL = [1.5, 1.8, 2.0];
const SCORE = [0.5, 0.55, 0.6];
const SL_TP = [
  { sl: 0.012, tp: 0.03, trail: false, flip: true },
  { sl: 0.012, tp: 0.03, trail: true, flip: true },
  { sl: 0.01, tp: 0.025, trail: false, flip: true },
  { sl: 0.015, tp: 0.045, trail: false, flip: false },
];
const RISK = [
  { risk: 5, lev: 10 },
  { risk: 8, lev: 15 },
  { risk: 10, lev: 20 },
  { risk: 15, lev: 25 },
];

function baseCfg(over) {
  return {
    symbol,
    timeframe: tf,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SUPERTREND",
    supertrendFuturesAuto: true,
    supertrendPeriod: 10,
    supertrendMultiplier: 3,
    supertrendWilderAtr: true,
    intelligenceGateEnabled: false,
    intelligenceGateStrict: false,
    signalStrengthGatesTrades: false,
    supertrendMoveQualityGate: false,
    supertrendBreakoutConfirm: false,
    marketDecision: { enabled: false },
    riskPerTradeUnit: "PCT",
    slippagePct: 0.0001,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    futuresTrailingStopMode: "SUPERTREND",
    futuresTrailingStFeeBreakeven: true,
    futuresTrailingStAdvanced: true,
    trailBufferMode: "ATR",
    trailBufferAtrMult: 1.2,
    ...over,
  };
}

function score(m) {
  const n = m.totalTrades ?? 0;
  if (n < minTrades) return -1e9;
  const ret = Number(m.totalReturnPct ?? 0);
  const wr = Number(m.winRate ?? 0) * 100;
  const pf = Number(m.profitFactor ?? 0);
  const wrBonus = wr >= targetWr ? 800 + (wr - targetWr) * 15 : 0;
  const retBonus = ret >= 1000 ? 2000 + ret * 0.5 : ret * 2;
  return wrBonus + retBonus + wr * 0.3 + Math.min(pf, 6) * 10 - (n < 12 ? (12 - n) * 8 : 0);
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
if (!candles.length) {
  console.error("No candles");
  process.exit(1);
}

console.log(`\n=== ST-only + Big-move gate sweep ===`);
console.log(`${symbol} ${tf}  ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}`);
console.log(`Intel OFF · target WR ${targetWr}% · return goal 1000%+\n`);

const rows = [];
let n = 0;
for (const st of STRENGTH) {
  for (const ms of MOVE_SL) {
    for (const sc of SCORE) {
      for (const bracket of SL_TP) {
        for (const rk of RISK) {
          n++;
          const cfg = baseCfg({
            supertrendBigMoveGateEnabled: true,
            supertrendBigMoveMinStrength: st,
            supertrendBigMoveMinMoveSlRatio: ms,
            supertrendBigMoveMinScore: sc,
            supertrendBigMoveMinAdx: 22,
            supertrendFuturesFixedSlPct: bracket.sl,
            supertrendFuturesFixedTpPct: bracket.tp,
            trailingStopLossAuto: bracket.trail,
            supertrendFlipExitEnabled: bracket.flip,
            riskPerTrade: rk.risk,
            futuresLeverage: rk.lev,
          });
          const adapters = await buildBacktestAdapters({
            strategyKey: "SUPERTREND",
            cfg,
            symbol,
            tf,
            candles,
            fromMs,
          });
          const sim = await runSimulation({
            strategyKey: "SUPERTREND",
            candles,
            cfg,
            gateMode: "off",
            gateFn: null,
            startingUsdt: capital,
            timeframe: tf,
            adapters,
            symbol,
          });
          const m = computeAllMetrics({
            trades: sim.trades,
            equityCurve: sim.equityCurve,
            tf,
            startingEquity: capital,
          });
          const wr = (m.winRate ?? 0) * 100;
          rows.push({
            st,
            ms,
            sc,
            sl: bracket.sl,
            tp: bracket.tp,
            trail: bracket.trail,
            flip: bracket.flip,
            risk: rk.risk,
            lev: rk.lev,
            trades: m.totalTrades,
            wr,
            ret: m.totalReturnPct ?? 0,
            pf: m.profitFactor ?? 0,
            bm: sim.bigMoveReplay,
            score: score(m),
          });
        }
      }
    }
  }
}

rows.sort((a, b) => b.score - a.score);
console.log(`Ran ${n} configs\n`);
console.log("Top configs:");
for (const r of rows.slice(0, topN)) {
  const hit = r.wr >= targetWr && r.ret > 0 ? "★" : r.wr >= targetWr ? "WR" : "";
  console.log(
    `${hit} str${r.st} move${r.ms} sc${r.sc} SL${(r.sl * 100).toFixed(1)}% TP${(r.tp * 100).toFixed(1)}% trail${r.trail ? "Y" : "N"} flip${r.flip ? "Y" : "N"} risk${r.risk}% ${r.lev}x → ${r.trades}t WR${r.wr.toFixed(1)}% ret${r.ret.toFixed(1)}% PF${r.pf.toFixed(2)} veto${r.bm?.veto ?? 0}`,
  );
}

const best = rows[0];
const target = rows.find((r) => r.wr >= targetWr && r.ret >= 1000);
console.log(
  target
    ? `\n✓ Found WR≥${targetWr}% and ret≥1000%: str${target.st} move${target.ms} ret${target.ret.toFixed(1)}%`
    : best
      ? `\nBest: WR${best.wr.toFixed(1)}% ret${best.ret.toFixed(1)}% (${best.trades} trades)`
      : "\nNo results",
);

await closePool?.();
