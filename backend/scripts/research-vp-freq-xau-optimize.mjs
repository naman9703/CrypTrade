#!/usr/bin/env node
/**
 * XAUUSDT VP FREQ — coin-native optimize ladder (short history window).
 *
 * Phase 0: F3=0 trades, F0=-25% (14n). Gold has lower vol — crypto-default HTF/score
 * gates likely over-filter. One-change ladder + soft autopsy on F0 book.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-xau-optimize.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "XAUUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2025-11-01";
const TO = process.env.TO || "2026-05-31";
const OOS_END = process.env.OOS_END || "2026-03-01";
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

const CORE = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
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
};

function monthBucket(ts) {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function metricsFor(trades) {
  let eq = START;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of trades) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf: TF, startingEquity: START });
  const months = {};
  eq = START;
  for (const t of trades) {
    const mo = monthBucket(t.entryTs);
    months[mo] ??= { n: 0, start: eq };
    months[mo].n += 1;
    eq += Number(t.netPnl ?? 0);
    months[mo].end = eq;
  }
  for (const mo of Object.values(months)) {
    mo.retPct = mo.start ? +(((mo.end - mo.start) / mo.start) * 100).toFixed(2) : 0;
  }
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  const oos = trades.filter((t) => Number(t.entryTs) >= oosEndMs);
  let oosEq = START;
  for (const t of oos) oosEq += Number(t.netPnl ?? 0);
  const redMonths = Object.entries(months)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  return {
    trades: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    oosN: oos.length,
    oosRet: oos.length ? +(((oosEq - START) / START) * 100).toFixed(2) : 0,
    months,
    redMonths,
    monthClean: redMonths.length === 0,
  };
}

async function run(candles, funding, over = {}) {
  const cfg = { ...CORE, ...over, backtestSignalStartMs: fromMs };
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

function priorPct(candles, idx, bars) {
  if (idx < bars) return null;
  const a = candles[idx - bars]?.close;
  const b = candles[idx]?.close;
  if (!(a > 0)) return null;
  return (b - a) / a;
}

function atrPctFromPre(pre, candles, idx) {
  const atr = Number(pre?.atrSeries?.[idx] ?? NaN);
  const c = Number(candles[idx]?.close ?? 0);
  return c > 0 && Number.isFinite(atr) ? atr / c : null;
}

function summarize(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.pnl > 0).length;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  return { n, wins, net: +net.toFixed(2), wr: n ? +((wins / n) * 100).toFixed(1) : 0 };
}

function avg(arr) {
  const v = arr.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function fmt(v) {
  return v == null ? "—" : (Math.abs(v) < 0.01 ? v.toFixed(4) : v.toFixed(3));
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, CORE);
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length}`);

const variants = [
  { id: "F0_open", over: { vpAllowedSetups: ["lvn_vacuum", "vah_breakout", "val_breakdown", "poc_bounce", "va_rejection", "naked_poc"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0015, vpMinScore: 7 } },
  { id: "F3_htf0015", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0015, vpMinScore: 7 } },
  { id: "F3_noHtf", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: false, vpMinScore: 7 } },
  { id: "F3_htf0005", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0005, vpMinScore: 7 } },
  { id: "F3_htf0003", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0003, vpMinScore: 7 } },
  { id: "F3_score5", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0005, vpMinScore: 5 } },
  { id: "F3_score5_noHtf", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: false, vpMinScore: 5 } },
  { id: "F1_val_rej", over: { vpAllowedSetups: ["val_breakdown", "va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0005, vpMinScore: 6 } },
  { id: "poc_rej", over: { vpAllowedSetups: ["poc_bounce", "va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0005, vpMinScore: 6 } },
  { id: "vac_rej", over: { vpAllowedSetups: ["lvn_vacuum", "va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0005, vpMinScore: 6 } },
  { id: "F3_minAtr002", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0005, vpMinScore: 6, vpMinAtrPct: 0.002 } },
  { id: "F3_minAtr003", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0005, vpMinScore: 6, vpMinAtrPct: 0.003 } },
  { id: "F3_sellExt", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0005, vpMinScore: 6, vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.03 } },
  { id: "F3_buyBody15", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0005, vpMinScore: 6, vpBuyRejectionMinBody: 0.15 } },
  { id: "F3_drop_vacuum", over: { vpAllowedSetups: ["vah_breakout", "val_breakdown", "poc_bounce", "va_rejection", "naked_poc"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0005, vpMinScore: 6 } },
  { id: "F3_htf0015_atr003", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0015, vpMinScore: 6, vpMinAtrPct: 0.003 } },
  { id: "F3_htf0015_sellExt", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0015, vpMinScore: 6, vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.03 } },
  { id: "F3_htf0015_dropBuy", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0015, vpMinScore: 6, vpAllowedSides: ["SELL"] } },
  { id: "F3_htf0015_dropSell", over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0015, vpMinScore: 6, vpAllowedSides: ["BUY"] } },
];

const results = [];
console.log(`\n══ XAU optimize ladder — ${FROM}→${TO} ══`);
for (const v of variants) {
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  results.push({ id: v.id, over: v.over, ...m });
  console.log(
    `${v.id.padEnd(22)} n=${String(m.trades).padStart(3)} tw=${m.tw} ret=${String(m.ret).padStart(7)}% cal=${String(m.calmar).padStart(6)} pf=${m.pf} oosN=${m.oosN} oosRet=${m.oosRet}% monthClean=${m.monthClean} reds=${m.redMonths.join(",") || "none"}`,
  );
}

const ranked = [...results]
  .filter((r) => r.trades >= 5)
  .sort((a, b) => {
    const aOk = a.ret > 0 && a.oosRet > 0 ? 1 : 0;
    const bOk = b.ret > 0 && b.oosRet > 0 ? 1 : 0;
    if (bOk !== aOk) return bOk - aOk;
    if (b.monthClean !== a.monthClean) return (b.monthClean ? 1 : 0) - (a.monthClean ? 1 : 0);
    if (b.calmar !== a.calmar) return b.calmar - a.calmar;
    return b.ret - a.ret;
  });

console.log("\n══ Rank (n≥5, positive first) ══");
for (const r of ranked.slice(0, 8)) {
  console.log(`${r.id.padEnd(22)} ret=${r.ret}% cal=${r.calmar} tw=${r.tw} oos=${r.oosRet}% n=${r.trades} clean=${r.monthClean}`);
}

// Autopsy best positive or F0 baseline
const autopsyId = ranked.find((r) => r.ret > 0)?.id ?? "F0_open";
const autopsyOver = variants.find((v) => v.id === autopsyId)?.over ?? variants[0].over;
const autopsyTrades = await run(candles, funding, autopsyOver);
const pre = precomputeVolumeProfile(candles);
const rows = [];
for (const t of autopsyTrades) {
  const ts = Number(t.entryTs);
  const idx = findIdx(candles, ts);
  if (idx < 1) continue;
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || "?";
  const vp = buildVolumeProfile(candles, idx, { mode: "rolling", lookback: 384, bins: 50, includePriorSession: true });
  const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const cell = describeVpConditionCell(pre, idx, side, setup, path, { ...CORE, ...autopsyOver });
  rows.push({
    month: monthBucket(ts),
    side,
    setup,
    pnl: Number(t.netPnl ?? 0),
    win: Number(t.netPnl ?? 0) > 0,
    cell: cell.key,
    macro: cell.macro,
    isVacuum: Number(path?.distPct ?? 0) >= 0.02,
    htfSep: Number(pre?.htfSep?.[idx] ?? NaN),
    atr: atrPctFromPre(pre, candles, idx),
    prior20d: priorPct(candles, idx, 96 * 20),
  });
}

const losers = rows.filter((r) => !r.win);
const winners = rows.filter((r) => r.win);
console.log(`\n══ Autopsy ${autopsyId} (${rows.length} trades) ══`);
console.log("losers", summarize(losers), "winners", summarize(winners));
for (const k of ["htfSep", "atr", "prior20d"]) {
  console.log(`  ${k.padEnd(10)} L=${fmt(avg(losers.map((r) => r[k])))} W=${fmt(avg(winners.map((r) => r[k])))}`);
}
const bySetup = {};
for (const r of rows) {
  bySetup[r.setup] ??= [];
  bySetup[r.setup].push(r);
}
console.log("\nby setup:");
for (const [s, rs] of Object.entries(bySetup).sort((a, b) => summarize(a[1]).net - summarize(b[1]).net)) {
  const sm = summarize(rs);
  console.log(`  ${s.padEnd(16)} n=${sm.n} net=${sm.net} wr=${sm.wr}%`);
}

const out = { symbol: SYMBOL, window: { from: FROM, to: TO }, results, ranked: ranked.slice(0, 10), autopsyId, autopsy: { rows: rows.length, bySetup } };
fs.writeFileSync(path.join(__dirname, ".vp-freq-xau-optimize.json"), JSON.stringify(out, null, 2));
await closePool?.();
