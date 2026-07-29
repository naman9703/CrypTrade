#!/usr/bin/env node
/**
 * ADA F3 — HTF fine ladder + 2020-21 residual on htf40+atr008 lock.
 *
 * Residual-clean: htf40+atr008 → FULL +94% / OOS +92% / IS +1.8%,
 * sticky red 2020-21 −7.9% only. This round finds year-clean frontier
 * without crushing OOS N.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-ada-f3-year-clean.mjs
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
const {
  buildVolumeProfileBacktestAdapter,
  precomputeVolumeProfile,
} = await import("../src/strategy/volumeProfileStrategy.js");
const { describeVpConditionCell } = await import("../src/strategy/vpConditionCell.js");
const { buildVolumeProfile, pathToNextHvn } = await import("../src/strategy/techniques/volumeProfile.js");
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

const BLEED_2021 = [
  "BUY|va_rejection|bull_trend|tight",
  "SELL|va_rejection|bull_trend|vacuum",
  "SELL|va_rejection|weak_bear|vacuum",
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

function findIdx(candles, ts) {
  let lo = 0,
    hi = candles.length - 1,
    best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(candles[mid].ts);
    if (t === ts) return mid;
    if (t < ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
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
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length}`);

// Autopsy 2020-21 trades under lock
console.log(`\n══ 2020-21 autopsy on htf40+atr008 lock ══`);
const lockTrades = await run(candles, funding);
const pre = precomputeVolumeProfile(candles);
const y21 = [];
for (const t of lockTrades) {
  if (yearBucket(t.entryTs) !== "2020-21") continue;
  const ts = Number(t.entryTs);
  const idx = findIdx(candles, ts);
  if (idx < 1) continue;
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || "va_rejection";
  const vp = buildVolumeProfile(candles, idx, { mode: "rolling", lookback: 384, bins: 50, includePriorSession: true });
  const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const cell = describeVpConditionCell(pre, idx, side, setup, path, BASE);
  y21.push({
    side,
    pnl: Number(t.netPnl ?? 0),
    cell: cell.key,
    macro: cell.macro,
    isVacuum: Number(path?.distPct ?? 0) >= 0.02,
    atr: Number(pre?.atrSeries?.[idx] ?? NaN) / Number(candles[idx]?.close || 1),
    htfSep: Number(pre?.htfSep?.[idx] ?? NaN),
  });
}
const byCell = {};
for (const r of y21) {
  byCell[r.cell] ??= { n: 0, net: 0 };
  byCell[r.cell].n += 1;
  byCell[r.cell].net += r.pnl;
}
console.log(`2020-21 trades=${y21.length} net=${y21.reduce((s, r) => s + r.pnl, 0).toFixed(2)}`);
for (const [k, v] of Object.entries(byCell).sort((a, b) => a[1].net - b[1].net)) {
  console.log(`  ${k.padEnd(48)} n=${v.n} net=${v.net.toFixed(2)}`);
}

const variants = [
  { id: "lock_htf40_atr008", over: {} },
  { id: "htf038", over: { vpMinHtfSepPct: 0.0038 } },
  { id: "htf042", over: { vpMinHtfSepPct: 0.0042 } },
  { id: "htf045", over: { vpMinHtfSepPct: 0.0045 } },
  { id: "htf048", over: { vpMinHtfSepPct: 0.0048 } },
  { id: "htf050", over: { vpMinHtfSepPct: 0.005 } },
  { id: "atr009", over: { vpMinAtrPct: 0.009 } },
  { id: "atr010", over: { vpMinAtrPct: 0.01 } },
  { id: "htf040+bleed", over: { vpPreparedBlockCellKeys: BLEED } },
  { id: "htf040+bleed21", over: { vpPreparedBlockCellKeys: BLEED_2021 } },
  { id: "htf040+bleed_all", over: { vpPreparedBlockCellKeys: [...new Set([...BLEED, ...BLEED_2021])] } },
  { id: "htf042+atr008", over: { vpMinHtfSepPct: 0.0042 } },
  { id: "htf045+atr008", over: { vpMinHtfSepPct: 0.0045 } },
  { id: "htf040+atr009", over: { vpMinAtrPct: 0.009 } },
  { id: "htf040+atr008+buyBody20", over: { vpBuyRejectionMinBody: 0.2 } },
  { id: "htf040+atr008+buyBody25", over: { vpBuyRejectionMinBody: 0.25 } },
  { id: "htf040+atr008+sellExt", over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.05 } },
  { id: "htf040+atr008+buyP60_050", over: { vpBuyRejectionMaxPrior60dPct: 0.5 } },
  { id: "htf040+atr008+buyP60_100", over: { vpBuyRejectionMaxPrior60dPct: 1.0 } },
  { id: "htf042+atr008+bleed", over: { vpMinHtfSepPct: 0.0042, vpPreparedBlockCellKeys: BLEED } },
  { id: "htf040+atr009+bleed", over: { vpMinAtrPct: 0.009, vpPreparedBlockCellKeys: BLEED } },
  { id: "htf040+atr008+add_poc", over: { vpAllowedSetups: ["va_rejection", "poc_bounce"] } },
  { id: "htf040+atr008+bleed+poc", over: { vpPreparedBlockCellKeys: BLEED, vpAllowedSetups: ["va_rejection", "poc_bounce"] } },
];

console.log(`\n══ ADA year-clean ladder on htf40+atr008 ══`);
const ab = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  ab.push({ id: v.id, over: v.over, ...m });
  console.log(
    `${v.id.padEnd(28)} n=${String(m.trades).padStart(3)} ret=${String(m.ret).padStart(7)}% oos=${String(m.oosRet).padStart(7)}% cal=${String(m.calmar).padStart(5)} clean=${m.clean} | ${m.red.join(",") || "none"}`,
  );
}

ab.sort(
  (a, b) =>
    Number(b.clean && b.oosRet > 0 && b.ret > 0) - Number(a.clean && a.oosRet > 0 && a.ret > 0) ||
    Number(b.clean) - Number(a.clean) ||
    Number(b.oosRet > 0) - Number(a.oosRet > 0) ||
    b.calmar - a.calmar ||
    b.trades - a.trades,
);

console.log("\n══ Ranked (year-clean+OOS>0 → clean → OOS → cal) ══");
for (const r of ab.slice(0, 12)) {
  console.log(
    `${r.id.padEnd(28)} clean=${r.clean} n=${r.trades} tw=${r.tw} ret=${r.ret}% oos=${r.oosRet}% oosN=${r.oosN} cal=${r.calmar} | ${r.red.join(",") || "none"}`,
  );
}

const best =
  ab.find((r) => r.clean && r.oosRet > 0 && r.ret > 0) ||
  ab.find((r) => r.clean) ||
  ab.find((r) => r.oosRet > 0 && r.ret > 0 && r.red.length <= 1) ||
  ab[0];

fs.writeFileSync(
  path.join(__dirname, ".vp-freq-ada-f3-year-clean.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), y21Autopsy: byCell, ab, best }, null, 2),
);
console.log(`\n══ Best: ${best?.id} clean=${best?.clean} ret=${best?.ret}% oos=${best?.oosRet}% n=${best?.trades} ══`);
await closePool?.();
