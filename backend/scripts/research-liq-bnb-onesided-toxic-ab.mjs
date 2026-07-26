#!/usr/bin/env node
/**
 * BNB LIQ — one-sided DaySituationBias hard A/B (freq restore).
 *
 * Soft residual (prepared-mit-residual): on HI_FREQ (mit+minSl+h020, no toxic),
 * drop_BUY_breakdown / drop_SELL_breakout alone → EG both windows with HOLD tw≥2,
 * Y1 tw≈1.76 (near floor). Full toxic collapses tw. Hard-test one-sided modes.
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-bnb-onesided-toxic-ab.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const TF = "15m";
const Y1_FROM = Date.parse(process.env.FROM || "2025-07-01");
const Y1_TO = Date.parse(process.env.TO || "2026-07-01");
const HOLD_FROM = Date.parse(process.env.HOLD_FROM || "2024-07-01");
const HOLD_TO = Date.parse(process.env.HOLD_TO || "2025-07-01");
const FULL_FROM = Date.parse(process.env.FULL_FROM || "2023-07-01");
const FULL_TO = Date.parse(process.env.FULL_TO || "2026-07-01");

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

const HI_FREQ = {
  intradayLiqRequireDisplacementV2: true,
  intradayLiqSweepDisplacementMinAtrMult: 1.2,
  intradayLiqMinSlPct: 0.01,
  intradayLiqMitigationEntry: true,
  intradayLiqMitigationFrac: 0.5,
  intradayLiqMitigationWaitBars: 6,
  intradayLiqActiveHourStart: 0,
  intradayLiqActiveHourEnd: 20,
  intradayLiqDaySituationBias: false,
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

function gatesOk(m) {
  return m.pf >= 1 && m.ret > 0 && m.tw >= 2;
}
function egOk(m) {
  return m.pf >= 1 && m.ret > 0;
}

async function runSim(symbol, candles, funding, over, lo, hi) {
  clearIntradayAdapterCache?.();
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    ...HI_FREQ,
    ...(over || {}),
    symbol,
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
    symbol,
  });
  return (sim.trades ?? []).filter(
    (t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi,
  );
}

const pad = 30 * 864e5;
const dataLo = Math.min(FULL_FROM, HOLD_FROM, Y1_FROM) - pad;
const dataHi = Math.max(FULL_TO, HOLD_TO, Y1_TO);

const candles = await readCandles("BNBUSDT", TF, dataLo, dataHi, { market: "futures" });
const funding = await readFundingRates("BNBUSDT", dataLo, dataHi).catch(() => []);

const variants = [
  ["hf_none", {}],
  ["hf_both", { intradayLiqDaySituationBias: true }],
  ["hf_buy_bd", { intradayLiqDaySituationBias: "buy_breakdown" }],
  ["hf_sell_bo", { intradayLiqDaySituationBias: "sell_breakout" }],
  // freq cushion on one-sided winners
  ["buy_bd_mit035", { intradayLiqDaySituationBias: "buy_breakdown", intradayLiqMitigationFrac: 0.35, intradayLiqMitigationWaitBars: 8 }],
  ["sell_bo_mit035", { intradayLiqDaySituationBias: "sell_breakout", intradayLiqMitigationFrac: 0.35, intradayLiqMitigationWaitBars: 8 }],
  ["buy_bd_disp10", { intradayLiqDaySituationBias: "buy_breakdown", intradayLiqSweepDisplacementMinAtrMult: 1.0 }],
  ["sell_bo_disp10", { intradayLiqDaySituationBias: "sell_breakout", intradayLiqSweepDisplacementMinAtrMult: 1.0 }],
  ["buy_bd_wait4", { intradayLiqDaySituationBias: "buy_breakdown", intradayLiqMitigationWaitBars: 4 }],
  ["sell_bo_wait4", { intradayLiqDaySituationBias: "sell_breakout", intradayLiqMitigationWaitBars: 4 }],
  ["buy_bd_side3", { intradayLiqDaySituationBias: "buy_breakdown", intradayLiqMaxTradesPerSidePerDay: 3, srIntradayMaxTradesPerDay: 6 }],
  ["sell_bo_side3", { intradayLiqDaySituationBias: "sell_breakout", intradayLiqMaxTradesPerSidePerDay: 3, srIntradayMaxTradesPerDay: 6 }],
  ["buy_bd_noHour", { intradayLiqDaySituationBias: "buy_breakdown", intradayLiqActiveHourStart: 0, intradayLiqActiveHourEnd: 24 }],
  ["sell_bo_noHour", { intradayLiqDaySituationBias: "sell_breakout", intradayLiqActiveHourStart: 0, intradayLiqActiveHourEnd: 24 }],
  ["buy_bd_h022", { intradayLiqDaySituationBias: "buy_breakdown", intradayLiqActiveHourEnd: 22 }],
  ["sell_bo_h022", { intradayLiqDaySituationBias: "sell_breakout", intradayLiqActiveHourEnd: 22 }],
  ["buy_bd_h023", { intradayLiqDaySituationBias: "buy_breakdown", intradayLiqActiveHourEnd: 23 }],
  ["sell_bo_h023", { intradayLiqDaySituationBias: "sell_breakout", intradayLiqActiveHourEnd: 23 }],
];

console.log("=== One-sided toxic hard A/B ===\n");
const hard = [];
for (const [id, over] of variants) {
  process.stderr.write(`${id}…\n`);
  const y1t = await runSim("BNBUSDT", candles, funding, over, Y1_FROM, Y1_TO);
  const ht = await runSim("BNBUSDT", candles, funding, over, HOLD_FROM, HOLD_TO);
  const y1 = metrics(y1t, Y1_FROM, Y1_TO);
  const hold = metrics(ht, HOLD_FROM, HOLD_TO);
  const pass = gatesOk(y1) && gatesOk(hold);
  const eg = egOk(y1) && egOk(hold);
  hard.push({ id, over, y1, hold, pass, eg });
  const mark = pass ? " ★PASS" : eg ? " ◆EG" : "";
  console.log(
    `${id.padEnd(22)} Y1 n=${String(y1.n).padStart(3)} tw=${y1.tw} ret=${String(y1.ret).padStart(7)} pf=${y1.pf} | HOLD n=${String(hold.n).padStart(3)} tw=${hold.tw} ret=${String(hold.ret).padStart(7)} pf=${hold.pf}${mark}`,
  );
}

const promote = hard.filter((h) => h.pass);
const egTw = hard.filter((h) => h.eg && h.y1.tw >= 2 && h.hold.tw >= 2);
const best = [...hard].sort(
  (a, b) =>
    (b.pass ? 1 : 0) - (a.pass ? 1 : 0) ||
    (b.eg && b.y1.tw >= 1.9 && b.hold.tw >= 1.9 ? 1 : 0) - (a.eg && a.y1.tw >= 1.9 && a.hold.tw >= 1.9 ? 1 : 0) ||
    (b.eg ? 1 : 0) - (a.eg ? 1 : 0) ||
    b.y1.tw + b.hold.tw - (a.y1.tw + a.hold.tw),
)[0];

const fullRuns = [];
const tops = [...promote, ...egTw, ...hard.filter((h) => h.eg).sort((a, b) => b.y1.tw + b.hold.tw - (a.y1.tw + a.hold.tw)).slice(0, 3)]
  .filter((v, i, a) => a.findIndex((x) => x.id === v.id) === i)
  .slice(0, 4);

for (const c of tops) {
  process.stderr.write(`FULL ${c.id}…\n`);
  const ft = await runSim("BNBUSDT", candles, funding, c.over, FULL_FROM, FULL_TO);
  const full = metrics(ft, FULL_FROM, FULL_TO);
  fullRuns.push({ id: c.id, full, eg: egOk(full) });
  console.log(`FULL ${c.id} n=${full.n} tw=${full.tw} ret=${full.ret}% pf=${full.pf}${egOk(full) ? " ◆EG" : ""}`);
}

const verdict = promote.length
  ? "PROMOTE_CANDIDATE"
  : egTw.length
    ? "EG_TW2"
    : best?.eg
      ? "EG_BELOW_TW2"
      : "REJECT";

const out = {
  generatedAt: new Date().toISOString(),
  hypothesis: "one-sided DaySituationBias restores freq vs full toxic while keeping HOLD green",
  hard,
  fullRuns,
  promote: promote.map((p) => p.id),
  egTw: egTw.map((p) => p.id),
  best: best ? { id: best.id, y1: best.y1, hold: best.hold, pass: best.pass, eg: best.eg } : null,
  verdict,
};
fs.writeFileSync(path.join(__dirname, ".liq-bnb-onesided-toxic-ab.json"), JSON.stringify(out, null, 2));
console.log(`\nverdict=${verdict} best=${best?.id} promote=${promote.map((p) => p.id).join(",") || "—"}`);

await closePool?.();
