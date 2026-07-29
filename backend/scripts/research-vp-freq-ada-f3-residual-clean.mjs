#!/usr/bin/env node
/**
 * ADA F3 round-2 — year/regime repair on HTF + minAtr findings.
 *
 * Autopsy: HTF 0.35% → +124% but early-year mild reds; minAtr_008 → +91%.
 * Bleed cells: SELL bull_chop/bear vacuum; BUY bull_chop vacuum (2025-26).
 * Tests stacks + cell denies with OOS holdout (2023-06-01).
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-ada-f3-residual-clean.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "ADAUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const OOS_END = "2023-06-01";
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
const oosEndMs = Date.parse(OOS_END);

const BLEED = [
  "SELL|va_rejection|bull_chop|vacuum",
  "SELL|va_rejection|bear_trend|vacuum",
  "SELL|va_rejection|weak_bear|vacuum",
  "BUY|va_rejection|bull_chop|vacuum",
  "BUY|va_rejection|weak_bear|vacuum",
];

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
  const oos = trades.filter((t) => Number(t.entryTs) >= oosEndMs);
  let oosEq = START;
  for (const t of oos) oosEq += Number(t.netPnl ?? 0);
  const is_ = trades.filter((t) => Number(t.entryTs) < oosEndMs);
  let isEq = START;
  for (const t of is_) isEq += Number(t.netPnl ?? 0);
  const red = Object.entries(years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  return {
    trades: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    oosN: oos.length,
    oosRet: oos.length ? +(((oosEq - START) / START) * 100).toFixed(2) : 0,
    isRet: is_.length ? +(((isEq - START) / START) * 100).toFixed(2) : 0,
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
  { id: "htf35", over: {} },
  { id: "htf40", over: { vpMinHtfSepPct: 0.004 } },
  { id: "htf45", over: { vpMinHtfSepPct: 0.0045 } },
  { id: "htf50", over: { vpMinHtfSepPct: 0.005 } },
  { id: "htf35+atr008", over: { vpMinAtrPct: 0.008 } },
  { id: "htf40+atr008", over: { vpMinHtfSepPct: 0.004, vpMinAtrPct: 0.008 } },
  { id: "htf45+atr008", over: { vpMinHtfSepPct: 0.0045, vpMinAtrPct: 0.008 } },
  { id: "htf35+bleed", over: { vpPreparedBlockCellKeys: BLEED } },
  { id: "htf35+atr008+bleed", over: { vpMinAtrPct: 0.008, vpPreparedBlockCellKeys: BLEED } },
  { id: "htf40+atr008+bleed", over: { vpMinHtfSepPct: 0.004, vpMinAtrPct: 0.008, vpPreparedBlockCellKeys: BLEED } },
  { id: "htf35+sellExt", over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.05 } },
  { id: "htf35+atr008+sellExt", over: { vpMinAtrPct: 0.008, vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.05 } },
  { id: "htf35+buyBody20", over: { vpBuyRejectionMinBody: 0.2 } },
  { id: "htf35+atr008+buyBody20", over: { vpMinAtrPct: 0.008, vpBuyRejectionMinBody: 0.2 } },
  { id: "htf35+SELL_only", over: { vpAllowedSides: ["SELL"] } },
  { id: "htf35+atr008+add_poc", over: { vpMinAtrPct: 0.008, vpAllowedSetups: ["va_rejection", "poc_bounce"] } },
];

console.log(`\n══ ADA F3 residual clean — OOS split ${OOS_END} ══`);
const ab = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  ab.push({ id: v.id, over: v.over, ...m });
  console.log(
    `${v.id.padEnd(24)} n=${String(m.trades).padStart(3)} ret=${String(m.ret).padStart(7)}% oos=${String(m.oosRet).padStart(7)}% is=${m.isRet}% cal=${m.calmar} clean=${m.clean} | ${m.red.join(",") || "none"}`,
  );
}

ab.sort(
  (a, b) =>
    Number(b.clean && b.oosRet > 0) - Number(a.clean && a.oosRet > 0) ||
    Number(b.oosRet > 0) - Number(a.oosRet > 0) ||
    b.calmar - a.calmar ||
    b.ret - a.ret,
);

console.log("\n══ Ranked (year-clean+OOS>0 → OOS>0 → cal) ══");
for (const r of ab.slice(0, 10)) {
  console.log(`${r.id.padEnd(24)} clean=${r.clean} ret=${r.ret}% oos=${r.oosRet}% n=${r.trades} | ${r.red.join(",") || "none"}`);
}

const best = ab.find((r) => r.clean && r.oosRet > 0) || ab.find((r) => r.oosRet > 0 && r.ret > 0) || ab[0];
fs.writeFileSync(path.join(__dirname, ".vp-freq-ada-f3-residual-clean.json"), JSON.stringify({ ab, best }, null, 2));
console.log(`\n══ Best: ${best?.id} ret=${best?.ret}% oos=${best?.oosRet}% clean=${best?.clean} ══`);
await closePool?.();
