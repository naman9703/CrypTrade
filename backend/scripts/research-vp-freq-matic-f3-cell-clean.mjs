#!/usr/bin/env node
/**
 * MATIC F3 round-2 — cell/vacuum denies on HTF 0.0035 base.
 *
 * Round-1: htfAlign_0035 → +69% cal 0.44, sticky red 2022-23 −23.35%.
 * Worst cells 2021-22: SELL bull_chop vacuum, BUY weak_bear vacuum.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-matic-f3-cell-clean.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "MATICUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2024-09-11";
const START = 100;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_BASE,
  VOLUME_PROFILE_FREQ_CORE,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const BASE = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  vpAllowedSetups: ["va_rejection"],
  vpNoveltyEnabled: false,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0035,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
};

const BLEED_SELECT = [
  "SELL|va_rejection|bull_chop|vacuum",
  "BUY|va_rejection|weak_bear|vacuum",
  "BUY|va_rejection|bear_trend|vacuum",
  "SELL|va_rejection|bull_trend|vacuum",
  "SELL|va_rejection|weak_bear|vacuum",
];

const ALL_VACUUM = [
  "SELL|va_rejection|weak_bear|vacuum",
  "SELL|va_rejection|bull_chop|vacuum",
  "SELL|va_rejection|bull_trend|vacuum",
  "SELL|va_rejection|bear_trend|vacuum",
  "BUY|va_rejection|bull_chop|vacuum",
  "BUY|va_rejection|bull_trend|vacuum",
  "BUY|va_rejection|bear_trend|vacuum",
  "BUY|va_rejection|weak_bear|vacuum",
];

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function metricsFor(trades) {
  let eq = START;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of trades) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf: TF, startingEquity: START });
  const years = {};
  eq = START;
  for (const t of trades) {
    const y = yearBucket(t.entryTs);
    years[y] ??= { n: 0, start: eq };
    years[y].n += 1;
    eq += Number(t.netPnl ?? 0);
    years[y].end = eq;
  }
  for (const y of Object.values(years)) {
    y.retPct = y.start ? +(((y.end - y.start) / y.start) * 100).toFixed(2) : 0;
  }
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  const red = Object.entries(years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  return {
    trades: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    years,
    red,
    clean: red.length === 0,
  };
}

async function run(candles, funding, over = {}) {
  const cfg = { ...BASE, ...over, backtestSignalStartMs: fromMs };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) },
    symbol: SYMBOL,
  });
  return (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, BASE);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length}`);

const variants = [
  { id: "base_htf35", over: {} },
  { id: "sellExtDown", over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.05 } },
  { id: "minAtr008", over: { vpMinAtrPct: 0.008 } },
  { id: "bleed_cells", over: { vpPreparedBlockCellKeys: BLEED_SELECT } },
  { id: "all_vacuum", over: { vpPreparedBlockCellKeys: ALL_VACUUM } },
  { id: "sellExt+bleed", over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.05, vpPreparedBlockCellKeys: BLEED_SELECT } },
  { id: "htf40", over: { vpMinHtfSepPct: 0.004 } },
  { id: "htf45", over: { vpMinHtfSepPct: 0.0045 } },
  { id: "htf50", over: { vpMinHtfSepPct: 0.005 } },
  { id: "htf45+bleed", over: { vpMinHtfSepPct: 0.0045, vpPreparedBlockCellKeys: BLEED_SELECT } },
  { id: "htf50+bleed", over: { vpMinHtfSepPct: 0.005, vpPreparedBlockCellKeys: BLEED_SELECT } },
  { id: "htf45+atr008", over: { vpMinHtfSepPct: 0.0045, vpMinAtrPct: 0.008 } },
  { id: "htf50+atr008", over: { vpMinHtfSepPct: 0.005, vpMinAtrPct: 0.008 } },
  { id: "SELL_only", over: { vpAllowedSides: ["SELL"] } },
  { id: "BUY_only", over: { vpAllowedSides: ["BUY"] } },
  { id: "add_poc", over: { vpAllowedSetups: ["va_rejection", "poc_bounce"] } },
  { id: "htf45+add_poc", over: { vpMinHtfSepPct: 0.0045, vpAllowedSetups: ["va_rejection", "poc_bounce"] } },
];

console.log(`\n══ MATIC F3 cell-clean on HTF 0.0035 base — ${FROM}→${TO} ══`);
const ab = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  ab.push({ id: v.id, over: v.over, ...m });
  console.log(
    `${v.id.padEnd(18)} n=${String(m.trades).padStart(3)} tw=${m.tw} ret=${String(m.ret).padStart(7)}% cal=${String(m.calmar).padStart(5)} pf=${m.pf} clean=${m.clean} | ${m.red.join(",") || "none"}`,
  );
}

ab.sort((a, b) => Number(b.clean) - Number(a.clean) || b.calmar - a.calmar || b.ret - a.ret);
console.log("\n══ Ranked (clean → cal → ret) ══");
for (const r of ab.slice(0, 10)) {
  console.log(`${r.id.padEnd(18)} clean=${r.clean} n=${r.trades} ret=${r.ret}% cal=${r.calmar} | ${r.red.join(",") || "none"}`);
}

const best = ab.find((r) => r.clean && r.ret > 0) || ab.find((r) => r.clean) || ab[0];
fs.writeFileSync(path.join(__dirname, ".vp-freq-matic-f3-cell-clean.json"), JSON.stringify({ ab, best }, null, 2));
console.log(`\n══ Best: ${best?.id ?? "none"} clean=${best?.clean} ret=${best?.ret}% ══`);
await closePool?.();
