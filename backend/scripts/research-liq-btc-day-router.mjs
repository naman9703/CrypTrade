#!/usr/bin/env node
/**
 * BTC day-type router test — range → classical fade, breakdown/breakout → trend continuation.
 *
 * Usage: cd backend && node scripts/research-liq-btc-day-router.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-01-01";
const SYMBOL = "BTCUSDT";
const TF = "15m";
const START = 10_000;
const RISK = Number(process.env.RISK_PCT || 2);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const {
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_LIQ_DAILY_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { utcDayId } = await import("../src/strategy/techniques/liquidity.js");

/** Prevent BTC auto-fill from polluting baseline (breakdown/choch gates). */
const BTC_CLEAR = {
  symbol: SYMBOL,
  timeframe: TF,
  riskPerTrade: RISK,
  intradayGateLiquidity: true,
  intradayGateSession: false,
  intradayLiqBreakdownDayBias: false,
  intradayLiqDaySituationBias: false,
  intradayLiqMarketStateGate: false,
  intradayLiqRequireKillzone: false,
  intradayLiqRequireChoch: false,
  intradayLiqPdhPdlOnly: true,
  intradayLiqSessionExtreme: false,
};

/** Proposed router config (for wiring test — not promoted). */
export const INTRADAY_PRO_LIQ_BTC_DAY_ROUTER_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  ...BTC_CLEAR,
  intradayLiqBreakdownDayBias: true,
  intradayLiqClassicOnTrendDays: false,
  intradayLiqClassicEnabled: true,
  intradayLiqTrendContinuation: true,
  intradayLiqTrendOnlyBreakdownDays: true,
  intradayLiqTrendSellOnly: false,
  intradayLiqVetoCounterTrend: false,
  intradayLiqTrendMinAdx: 16,
  intradayLiqTrendMinBarsBeyondLevel: 3,
  intradayLiqTrendMinDispAtr: 0.38,
  intradayLiqTrendDisplacementOnly: false,
  intradayLiqTrendMinRvol: 0.85,
  intradayLiqTrendFadeMinRvol: 0.6,
  intradayLiqMinScore: 6,
};

const VARIANTS = [
  {
    id: "A_baseline",
    label: "Baseline classical (fade always)",
    patch: { ...BTC_CLEAR, intradayLiqTrendContinuation: false },
  },
  {
    id: "B_breakdown_veto",
    label: "Breakdown veto only (range-day fade)",
    patch: {
      ...BTC_CLEAR,
      intradayLiqBreakdownDayBias: true,
      intradayLiqClassicOnTrendDays: false,
      intradayLiqTrendContinuation: false,
    },
  },
  {
    id: "C_router_loose",
    label: "Day router — loose trend cont.",
    patch: INTRADAY_PRO_LIQ_BTC_DAY_ROUTER_15M,
  },
  {
    id: "D_router_strict_disp",
    label: "Day router — disp-only ADX≥20",
    patch: {
      ...INTRADAY_PRO_LIQ_BTC_DAY_ROUTER_15M,
      intradayLiqTrendDisplacementOnly: true,
      intradayLiqTrendMinAdx: 20,
      intradayLiqTrendMinDispAtr: 0.55,
      intradayLiqTrendMinRvol: 1.1,
      intradayLiqMinScore: 8,
      intradayLiqTrendMinBarsBeyondLevel: 4,
    },
  },
  {
    id: "E_liq_daily_trend",
    label: "Router + LIQ_DAILY trend params",
    patch: {
      ...BTC_CLEAR,
      ...INTRADAY_PRO_LIQ_DAILY_15M,
      intradayLiqClassicEnabled: true,
      intradayLiqClassicOnTrendDays: false,
      intradayLiqBreakdownDayBias: true,
      intradayLiqTrendSellOnly: false,
      intradayLiqMinScore: 6,
    },
  },
  {
    id: "F_sell_cont_only",
    label: "Router short-cont only (LIQ_DAILY)",
    patch: {
      ...BTC_CLEAR,
      ...INTRADAY_PRO_LIQ_DAILY_15M,
      intradayLiqClassicEnabled: true,
      intradayLiqClassicOnTrendDays: false,
      intradayLiqBreakdownDayBias: true,
      intradayLiqTrendSellOnly: true,
      intradayLiqMinScore: 6,
    },
  },
  {
    id: "G_more_classical_picks",
    label: "Veto + 4 picks/day (no cont.)",
    patch: {
      ...BTC_CLEAR,
      intradayLiqBreakdownDayBias: true,
      intradayLiqClassicOnTrendDays: false,
      intradayLiqOnePickPerDay: false,
      srIntradayMaxTradesPerDay: 4,
      intradayLiqMaxTradesPerSidePerDay: 2,
      intradayLiqTrendContinuation: false,
    },
  },
];

function mat(patch) {
  return materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_15M, ...patch },
    materializeIntradayPanelOnCfg,
  );
}

function playbookOf(t) {
  const lt = String(t.liqContext?.levelType ?? "");
  if (lt === "pdl_break" || lt === "pdh_break") return "trend";
  if (lt === "pdl" || lt === "pdh") return "classical";
  return "other";
}

function pfOf(arr) {
  const wins = arr.filter((t) => Number(t.netPnl) > 0);
  const losses = arr.filter((t) => Number(t.netPnl) <= 0);
  const gw = wins.reduce((s, t) => s + Number(t.netPnl), 0);
  const gl = losses.reduce((s, t) => s + Number(t.netPnl), 0);
  if (gl < 0) return gw / Math.abs(gl);
  return gw > 0 ? 99 : 0;
}

async function runVariant(v) {
  clearIntradayAdapterCache();
  const warmup = 21 * 86_400_000;
  const candles = await readCandles(SYMBOL, TF, fromMs - warmup, toMs, { market: "futures" });
  const cfg = mergeAdaptiveCfg(mat(v.patch), candles);

  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    startingUsdt: START,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
  });

  const closed = sim.trades.filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const slice = closed.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
  const m = computeAllMetrics({
    trades: slice,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START,
  });

  const tradingDays = new Set(
    candles.filter((c) => c.ts >= fromMs && c.ts < toMs).map((c) => utcDayId(c.ts)),
  ).size;
  const tradeDays = new Set(slice.map((t) => utcDayId(t.entryTs))).size;

  const cls = slice.filter((t) => playbookOf(t) === "classical");
  const trend = slice.filter((t) => playbookOf(t) === "trend");

  return {
    id: v.id,
    label: v.label,
    trades: slice.length,
    tradesPerDay: slice.length / tradingDays,
    tradeDays,
    tradingDays,
    daysWithTradePct: (tradeDays / tradingDays) * 100,
    returnPct: Number(m.totalReturnPct ?? 0),
    pf: Number(m.profitFactor ?? 0),
    wr: Number(m.winRate ?? 0) * 100,
    maxDd: Number(m.maxDrawdownPct ?? 0),
    classicalN: cls.length,
    classicalPf: pfOf(cls),
    trendN: trend.length,
    trendPf: pfOf(trend),
  };
}

console.log(`\n=== BTC Day-Type Router Test ===`);
console.log(`${FROM} → ${TO} | ${SYMBOL} ${TF} | risk ${RISK}% | no context filter\n`);

const rows = [];
for (const v of VARIANTS) {
  process.stderr.write(`  ${v.id}...\n`);
  rows.push(await runVariant(v));
}

console.log(
  "\n| ID | Variant | Trades | t/day | Days w/trade | Return% | PF | WR% | MaxDD% | Classical | Trend cont. |",
);
console.log(
  "|----|---------|--------|-------|--------------|---------|-----|------|--------|-----------|---------------|",
);
for (const r of rows) {
  console.log(
    `| ${r.id} | ${r.label.slice(0, 36)} | ${r.trades} | ${r.tradesPerDay.toFixed(2)} | ${r.tradeDays}/${r.tradingDays} (${r.daysWithTradePct.toFixed(0)}%) | ${r.returnPct.toFixed(1)} | ${r.pf.toFixed(2)} | ${r.wr.toFixed(0)} | ${r.maxDd.toFixed(1)} | ${r.classicalN} (PF ${r.classicalPf.toFixed(2)}) | ${r.trendN} (PF ${r.trendPf.toFixed(2)}) |`,
  );
}

const md = [
  `# BTC day-type router test (${FROM} → ${TO})`,
  "",
  "| ID | Variant | Trades | t/day | Return% | PF | WR% | Classical | Trend |",
  "|----|---------|--------|-------|---------|-----|------|-----------|-------|",
  ...rows.map(
    (r) =>
      `| ${r.id} | ${r.label} | ${r.trades} | ${r.tradesPerDay.toFixed(2)} | ${r.returnPct.toFixed(1)} | ${r.pf.toFixed(2)} | ${r.wr.toFixed(0)} | ${r.classicalN} / ${r.classicalPf.toFixed(2)} | ${r.trendN} / ${r.trendPf.toFixed(2)} |`,
  ),
  "",
  "## Verdict",
  "",
  "**Do not wire naive day router to app.** Trend continuation (`evaluateTrendContinuationSetup`) is net-negative on BTC 2025 at all tested strictness levels.",
  "",
  "- **B_breakdown_veto**: best PF (1.55) but only 3 trades/year — range-day classical only.",
  "- **C–F routers**: frequency ↑ to 0.13–0.53/day but **PF 0.09–0.25, returns −38% to −87%**.",
  "- **G more picks/day**: still 3 trades — pick cap is not the bottleneck.",
  "",
  "Next: redesign trend-day playbook for BTC before app integration.",
].join("\n");

const jsonPath = path.join(__dirname, ".research-liq-btc-day-router.json");
const mdPath = path.join(__dirname, ".research-liq-btc-day-router.md");
fs.writeFileSync(jsonPath, JSON.stringify({ window: { from: FROM, to: TO }, rows }, null, 2));
fs.writeFileSync(mdPath, md);
console.log(`\nWrote ${jsonPath}`);
console.log(`Wrote ${mdPath}`);

await closePool();
