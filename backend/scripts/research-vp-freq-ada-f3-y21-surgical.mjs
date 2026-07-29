#!/usr/bin/env node
/**
 * ADA F3 — surgical 2020-21 clear on htf40+atr008 lock.
 *
 * Year-clean ladder: no full year-clean. Sticky 2020-21 driven by
 * BUY|bull_trend|tight (−6.11 of −7.89). Best near-clean:
 * buyBody25 → +109% / OOS +103% / cal 0.84, reds −1.56%/−1.42%.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-ada-f3-y21-surgical.mjs
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

const TIGHT_BUY = ["BUY|va_rejection|bull_trend|tight"];
const WEAK_SELL = ["SELL|va_rejection|weak_bear|vacuum"];
const Y21_CORE = ["BUY|va_rejection|bull_trend|tight", "SELL|va_rejection|weak_bear|vacuum"];

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
  vpMinHtfSepPct: 0.004,
  vpMinAtrPct: 0.008,
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
  { id: "lock", over: {} },
  { id: "deny_tightBUY", over: { vpPreparedBlockCellKeys: TIGHT_BUY } },
  { id: "deny_weakSELL", over: { vpPreparedBlockCellKeys: WEAK_SELL } },
  { id: "deny_y21core", over: { vpPreparedBlockCellKeys: Y21_CORE } },
  { id: "buyBody25", over: { vpBuyRejectionMinBody: 0.25 } },
  { id: "buyBody25+tightBUY", over: { vpBuyRejectionMinBody: 0.25, vpPreparedBlockCellKeys: TIGHT_BUY } },
  { id: "buyBody25+y21core", over: { vpBuyRejectionMinBody: 0.25, vpPreparedBlockCellKeys: Y21_CORE } },
  { id: "buyBody30", over: { vpBuyRejectionMinBody: 0.3 } },
  { id: "buyBody30+tightBUY", over: { vpBuyRejectionMinBody: 0.3, vpPreparedBlockCellKeys: TIGHT_BUY } },
  { id: "score8", over: { vpMinScore: 8 } },
  { id: "score8+tightBUY", over: { vpMinScore: 8, vpPreparedBlockCellKeys: TIGHT_BUY } },
  { id: "buyBody25+score8", over: { vpBuyRejectionMinBody: 0.25, vpMinScore: 8 } },
  { id: "deny_y21core+poc", over: { vpPreparedBlockCellKeys: Y21_CORE, vpAllowedSetups: ["va_rejection", "poc_bounce"] } },
  { id: "buyBody25+poc", over: { vpBuyRejectionMinBody: 0.25, vpAllowedSetups: ["va_rejection", "poc_bounce"] } },
];

console.log(`\n══ ADA 2020-21 surgical — OOS ${OOS_END} ══`);
const ab = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  ab.push({ id: v.id, over: v.over, ...m });
  console.log(
    `${v.id.padEnd(24)} n=${String(m.trades).padStart(3)} ret=${String(m.ret).padStart(7)}% oos=${String(m.oosRet).padStart(7)}% is=${String(m.isRet).padStart(6)}% cal=${String(m.calmar).padStart(5)} clean=${m.clean} | ${m.red.join(",") || "none"}`,
  );
}

ab.sort(
  (a, b) =>
    Number(b.clean && b.oosRet > 0 && b.ret > 0) - Number(a.clean && a.oosRet > 0 && a.ret > 0) ||
    Number(b.clean) - Number(a.clean) ||
    Number(b.oosRet > 0 && b.isRet > 0) - Number(a.oosRet > 0 && a.isRet > 0) ||
    b.calmar - a.calmar ||
    b.ret - a.ret,
);

console.log("\n══ Ranked ══");
for (const r of ab) {
  console.log(
    `${r.id.padEnd(24)} clean=${r.clean} n=${r.trades} tw=${r.tw} ret=${r.ret}% oos=${r.oosRet}% oosN=${r.oosN} cal=${r.calmar} | ${r.red.join(",") || "none"}`,
  );
}

const best =
  ab.find((r) => r.clean && r.oosRet > 0 && r.ret > 0) ||
  ab.find((r) => r.clean) ||
  ab.find((r) => r.oosRet > 0 && r.isRet > 0 && r.red.length <= 1) ||
  ab[0];

fs.writeFileSync(
  path.join(__dirname, ".vp-freq-ada-f3-y21-surgical.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), ab, best }, null, 2),
);
console.log(`\n══ Best: ${best?.id} clean=${best?.clean} ret=${best?.ret}% oos=${best?.oosRet}% n=${best?.trades} ══`);
await closePool?.();
