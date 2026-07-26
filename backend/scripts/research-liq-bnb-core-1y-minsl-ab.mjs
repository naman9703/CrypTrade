#!/usr/bin/env node
/**
 * BNB LIQ_CORE — hard A/B from 1y deep autopsy:
 * survivors have wider SL (distSl ~1.3% vs ~0.96% on death paths).
 * One-change: MinSlPct / ATR SL buffer / atrPct proxy.
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-bnb-core-1y-minsl-ab.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const Y1_FROM = Date.parse(process.env.FROM || "2025-07-01");
const Y1_TO = Date.parse(process.env.TO || "2026-07-01");
const HOLD_FROM = Date.parse(process.env.HOLD_FROM || "2024-07-01");
const HOLD_TO = Date.parse(process.env.HOLD_TO || "2025-07-01");

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");

function metrics(trades, lo, hi) {
  const s = (trades || [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
  let eq = 100;
  const curve = [{ ts: lo, equity: eq }];
  for (const t of s) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades: s, equityCurve: curve, tf: TF, startingEquity: 100 });
  const weeks = Math.max(0.01, (hi - lo) / (7 * 864e5));
  return {
    n: s.length,
    tw: +(s.length / weeks).toFixed(2),
    ret: +Number(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
  };
}

async function run(candles, funding, over, lo, hi) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    ...(over || {}),
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: lo,
  };
  cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
  const adapter = buildIntradayBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: TF,
    adapters: { SR_INTRADAY: adapter, INTRADAY_PRO: adapter },
    symbol: SYMBOL,
  });
  return metrics(sim.trades ?? [], lo, hi);
}

const VARIANTS = [
  ["CORE", {}],
  ["minSl_0.008", { intradayLiqMinSlPct: 0.008 }],
  ["minSl_0.010", { intradayLiqMinSlPct: 0.01 }],
  ["minSl_0.012", { intradayLiqMinSlPct: 0.012 }],
  ["atrBuf_0.2", { intradayLiqSlBufferAtrMult: 0.2 }],
  ["atrBuf_0.35", { intradayLiqSlBufferAtrMult: 0.35 }],
  ["minSl008_atrBuf02", { intradayLiqMinSlPct: 0.008, intradayLiqSlBufferAtrMult: 0.2 }],
];

console.log("=== BNB CORE 1y MinSl / ATR-buffer A/B (from deep autopsy) ===\n");
const pad = 30 * 864e5;
const candles = await readCandles(SYMBOL, TF, Math.min(Y1_FROM, HOLD_FROM) - pad, Math.max(Y1_TO, HOLD_TO), {
  market: "futures",
});
const funding = await readFundingRates(SYMBOL, Math.min(Y1_FROM, HOLD_FROM) - pad, Math.max(Y1_TO, HOLD_TO)).catch(
  () => [],
);

const results = [];
for (const [id, over] of VARIANTS) {
  process.stderr.write(`${id} Y1…\n`);
  const y1 = await run(candles, funding, over, Y1_FROM, Y1_TO);
  process.stderr.write(`${id} HOLD…\n`);
  const hold = await run(candles, funding, over, HOLD_FROM, HOLD_TO);
  const pass = y1.pf >= 1 && y1.ret > 0 && y1.tw >= 2 && hold.pf >= 1 && hold.ret > 0 && hold.tw >= 2;
  results.push({ id, over, y1, hold, pass });
  console.log(
    `${id.padEnd(22)} Y1 n=${y1.n} tw=${y1.tw} ret=${String(y1.ret).padStart(7)}% pf=${y1.pf} | HOLD n=${hold.n} tw=${hold.tw} ret=${String(hold.ret).padStart(7)}% pf=${hold.pf}${pass ? " ★" : ""}`,
  );
}

const verdict = results.some((r) => r.pass)
  ? "PROMOTE_CANDIDATE"
  : results.some((r) => r.y1.pf >= 1 && r.y1.ret > 0 && r.y1.tw >= 2)
    ? "Y1_ONLY"
    : "REJECT";

const out = {
  generatedAt: new Date().toISOString(),
  hypothesis:
    "1y path autopsy: had_follow survivors have wider structural SL (1.3% vs 0.96%). Reject tight-SL fades via MinSlPct / widen ATR buffer.",
  verdict,
  results,
};
const outPath = path.join(__dirname, ".liq-bnb-core-1y-minsl-ab.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nverdict=${verdict} wrote ${outPath}`);
await closePool?.();
