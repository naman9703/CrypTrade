#!/usr/bin/env node
/**
 * BNB LIQ — nudge buy_bd_mit035 / sell_bo_mit035 over Y1 tw≥2 while keeping HOLD EG.
 * Prior: buy_bd_mit035 Y1 tw=1.98 EG | HOLD 2.22 EG | FULL 2.18 +24% EG.
 *
 * Usage (backend/): SKIP_ENSURE=1 node scripts/research-liq-bnb-onesided-nudge.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const TF = "15m";
const Y1_FROM = Date.parse("2025-07-01");
const Y1_TO = Date.parse("2026-07-01");
const HOLD_FROM = Date.parse("2024-07-01");
const HOLD_TO = Date.parse("2025-07-01");
const FULL_FROM = Date.parse("2023-07-01");
const FULL_TO = Date.parse("2026-07-01");

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

const BASE_BUY = {
  intradayLiqRequireDisplacementV2: true,
  intradayLiqSweepDisplacementMinAtrMult: 1.2,
  intradayLiqMinSlPct: 0.01,
  intradayLiqMitigationEntry: true,
  intradayLiqMitigationFrac: 0.35,
  intradayLiqMitigationWaitBars: 8,
  intradayLiqActiveHourStart: 0,
  intradayLiqActiveHourEnd: 20,
  intradayLiqDaySituationBias: "buy_breakdown",
};

const BASE_SELL = {
  ...BASE_BUY,
  intradayLiqDaySituationBias: "sell_breakout",
};

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
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
  };
}
const gatesOk = (m) => m.pf >= 1 && m.ret > 0 && m.tw >= 2;
const egOk = (m) => m.pf >= 1 && m.ret > 0;

async function runSim(candles, funding, over, lo, hi) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    ...over,
    symbol: "BNBUSDT",
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
    symbol: "BNBUSDT",
  });
  return (sim.trades ?? []).filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
}

const pad = 30 * 864e5;
const candles = await readCandles("BNBUSDT", TF, FULL_FROM - pad, FULL_TO, { market: "futures" });
const funding = await readFundingRates("BNBUSDT", FULL_FROM - pad, FULL_TO).catch(() => []);

const variants = [
  ["buy_bd_mit035", { ...BASE_BUY }],
  ["buy_bd_mit040", { ...BASE_BUY, intradayLiqMitigationFrac: 0.4 }],
  ["buy_bd_mit030", { ...BASE_BUY, intradayLiqMitigationFrac: 0.3 }],
  ["buy_bd_wait6", { ...BASE_BUY, intradayLiqMitigationWaitBars: 6 }],
  ["buy_bd_wait10", { ...BASE_BUY, intradayLiqMitigationWaitBars: 10 }],
  ["buy_bd_disp11", { ...BASE_BUY, intradayLiqSweepDisplacementMinAtrMult: 1.1 }],
  ["buy_bd_disp10", { ...BASE_BUY, intradayLiqSweepDisplacementMinAtrMult: 1.0 }],
  ["buy_bd_side3", { ...BASE_BUY, intradayLiqMaxTradesPerSidePerDay: 3, srIntradayMaxTradesPerDay: 6 }],
  ["buy_bd_h021", { ...BASE_BUY, intradayLiqActiveHourEnd: 21 }],
  ["buy_bd_minSl009", { ...BASE_BUY, intradayLiqMinSlPct: 0.009 }],
  ["buy_bd_mit035_side3", { ...BASE_BUY, intradayLiqMaxTradesPerSidePerDay: 3, srIntradayMaxTradesPerDay: 6 }],
  ["buy_bd_mit040_side3", { ...BASE_BUY, intradayLiqMitigationFrac: 0.4, intradayLiqMaxTradesPerSidePerDay: 3, srIntradayMaxTradesPerDay: 6 }],
  ["buy_bd_disp11_side3", { ...BASE_BUY, intradayLiqSweepDisplacementMinAtrMult: 1.1, intradayLiqMaxTradesPerSidePerDay: 3, srIntradayMaxTradesPerDay: 6 }],
  ["sell_bo_mit035", { ...BASE_SELL }],
  ["sell_bo_mit040", { ...BASE_SELL, intradayLiqMitigationFrac: 0.4 }],
  ["sell_bo_disp11", { ...BASE_SELL, intradayLiqSweepDisplacementMinAtrMult: 1.1 }],
  ["sell_bo_side3", { ...BASE_SELL, intradayLiqMaxTradesPerSidePerDay: 3, srIntradayMaxTradesPerDay: 6 }],
  ["sell_bo_h021", { ...BASE_SELL, intradayLiqActiveHourEnd: 21 }],
  ["sell_bo_mit035_side3", { ...BASE_SELL, intradayLiqMaxTradesPerSidePerDay: 3, srIntradayMaxTradesPerDay: 6 }],
  ["sell_bo_disp11_side3", { ...BASE_SELL, intradayLiqSweepDisplacementMinAtrMult: 1.1, intradayLiqMaxTradesPerSidePerDay: 3, srIntradayMaxTradesPerDay: 6 }],
];

console.log("=== One-sided nudge (clear Y1 tw≥2) ===\n");
const hard = [];
for (const [id, over] of variants) {
  process.stderr.write(`${id}…\n`);
  const y1 = metrics(await runSim(candles, funding, over, Y1_FROM, Y1_TO), Y1_FROM, Y1_TO);
  const hold = metrics(await runSim(candles, funding, over, HOLD_FROM, HOLD_TO), HOLD_FROM, HOLD_TO);
  const pass = gatesOk(y1) && gatesOk(hold);
  const eg = egOk(y1) && egOk(hold);
  hard.push({ id, over, y1, hold, pass, eg });
  console.log(
    `${id.padEnd(24)} Y1 n=${String(y1.n).padStart(3)} tw=${y1.tw} ret=${String(y1.ret).padStart(7)} pf=${y1.pf} | HOLD n=${String(hold.n).padStart(3)} tw=${hold.tw} ret=${String(hold.ret).padStart(7)} pf=${hold.pf}${pass ? " ★PASS" : eg ? " ◆EG" : ""}`,
  );
}

const promote = hard.filter((h) => h.pass);
const fullRuns = [];
for (const c of [
  ...promote,
  ...hard.filter((h) => h.eg && h.y1.tw >= 1.95).sort((a, b) => b.y1.tw - a.y1.tw).slice(0, 3),
].filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i).slice(0, 5)) {
  process.stderr.write(`FULL ${c.id}…\n`);
  const full = metrics(await runSim(candles, funding, c.over, FULL_FROM, FULL_TO), FULL_FROM, FULL_TO);
  fullRuns.push({ id: c.id, full, eg: egOk(full) });
  console.log(`FULL ${c.id} n=${full.n} tw=${full.tw} ret=${full.ret}% pf=${full.pf}${egOk(full) ? " ◆EG" : ""}`);
}

const best = [...hard].sort(
  (a, b) =>
    (b.pass ? 1 : 0) - (a.pass ? 1 : 0) ||
    (b.eg ? 1 : 0) - (a.eg ? 1 : 0) ||
    Math.min(b.y1.tw, b.hold.tw) - Math.min(a.y1.tw, a.hold.tw),
)[0];

const out = {
  generatedAt: new Date().toISOString(),
  hard,
  fullRuns,
  promote: promote.map((p) => p.id),
  best: best ? { id: best.id, y1: best.y1, hold: best.hold, pass: best.pass, eg: best.eg } : null,
  verdict: promote.length ? "PROMOTE_CANDIDATE" : best?.eg ? "EG_NEAR_TW2" : "REJECT",
};
fs.writeFileSync(path.join(__dirname, ".liq-bnb-onesided-nudge.json"), JSON.stringify(out, null, 2));
console.log(`\nverdict=${out.verdict} best=${best?.id} promote=${promote.map((p) => p.id).join(",") || "—"}`);
await closePool?.();
