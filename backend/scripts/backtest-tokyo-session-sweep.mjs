#!/usr/bin/env node
/**
 * TOKYO_SESSION — sweep direction mode × SL mode × TP R:R (1/2/3).
 * Usage: node scripts/backtest-tokyo-session-sweep.mjs
 * Env: SYMBOL, TF, FROM, TO, RISK
 */
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
const candles = await readCandles(SYMBOL, TF, tokyoSessionPadFromMs(fromMs, TF), toMs, {
  market: "futures",
});
const cost = { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };

const DIR_MODES = ["SECOND_MOMENTUM", "BOTH_BODY", "NET_CLOSE"];
const SL_MODES = ["ADAPTIVE", "FIRST2_RANGE", "C2_EXTREME", "FIRST2_OPPOSITE", "FIRST2_MID", "C1_ANCHOR"];
const RR_LEVELS = [1, 2, 3];

async function runOne(label, extra) {
  const cfg = resolveTokyoSessionCfg({
    ...TOKYO_SESSION_BNB_15M,
    symbol: SYMBOL,
    timeframe: TF,
    riskPerTrade: RISK,
    ...extra,
  });
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
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 100,
  });
  const inWindow = sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
  const wins = inWindow.filter((t) => Number(t.netPnl ?? 0) > 0).length;
  const wr = inWindow.length ? (wins / inWindow.length) * 100 : 0;
  return {
    label,
    ret: m.totalReturnPct ?? 0,
    n: inWindow.length,
    wr,
    dd: m.maxDrawdownPct ?? 0,
    pf: m.profitFactor ?? 0,
    cagr: m.cagrPct ?? 0,
    extra,
  };
}

const rows = [];
for (const dir of DIR_MODES) {
  for (const sl of SL_MODES) {
    for (const rr of RR_LEVELS) {
      const skipMixed = dir === "BOTH_BODY";
      const label = `${dir}|${sl}|${rr}R${skipMixed ? "|skipMixed" : ""}`;
      rows.push(
        await runOne(label, {
          tokyoDirMode: dir,
          tokyoSlMode: sl,
          tokyoTpRr: rr,
          tokyoSkipMixedBodies: skipMixed,
        }),
      );
    }
  }
}

rows.sort((a, b) => b.ret - a.ret);

console.log(`\n=== TOKYO_SESSION SWEEP ${SYMBOL} ${TF} ${FROM} → ${TO} @ ${RISK}% risk ===`);
console.log(`Candles: ${candles.length}`);
console.log("\nTop 15 by return:");
for (const r of rows.slice(0, 15)) {
  console.log(
    `${r.label.padEnd(42)} ret=${r.ret.toFixed(1)}% n=${r.n} wr=${r.wr.toFixed(0)}% dd=${r.dd.toFixed(1)}% pf=${r.pf?.toFixed(2) ?? "—"}`,
  );
}

const best = rows[0];
console.log("\n=== BEST ===");
console.log(JSON.stringify(best, null, 2));

// Sanity: verify first trade has tokyo meta
if (best.n > 0) {
  const cfg = resolveTokyoSessionCfg({ ...TOKYO_SESSION_BNB_15M, ...best.extra, symbol: SYMBOL });
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
  const t = sim.trades[0];
  console.log("\n=== SAMPLE TRADE ===");
  console.log({
    entry: t?.entryTs,
    dir: t?.direction,
    reason: t?.entryReason,
    sl: t?.slPrice,
    tp: t?.tpPrice,
    tokyoMeta: t?.liqContext?.tokyoMeta ?? null,
  });
}

await closePool();
