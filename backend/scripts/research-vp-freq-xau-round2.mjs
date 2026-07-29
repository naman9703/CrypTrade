#!/usr/bin/env node
/**
 * XAUUSDT VP FREQ — round-2: prune bleed setups, try 5m/1h, poc-focused.
 *
 * Round-1: va_rejection=0 with HTF; open book -22..-36%; val_breakdown worst bleeder.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-xau-round2.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "XAUUSDT";
const FROM = process.env.FROM || "2025-11-01";
const TO = process.env.TO || "2026-05-31";
const OOS_END = process.env.OOS_END || "2026-03-01";
const START = 100;
const TFS = (process.env.TFS || "15m,5m,1h").split(",").map((s) => s.trim());

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { ensureFunding, readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
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

function core(tf) {
  return {
    ...VOLUME_PROFILE_BASE,
    ...VOLUME_PROFILE_FREQ_CORE,
    vpPlaybook: "CUSTOM",
    vpMinAdx: 0.0001,
    symbol: SYMBOL,
    timeframe: tf,
    vpNoveltyEnabled: false,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0003,
    maxDailyLoss: 0,
  };
}

function monthBucket(ts) {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function metricsFor(trades, tf) {
  let eq = START;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of trades) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf, startingEquity: START });
  const months = {};
  eq = START;
  for (const t of trades) {
    const mo = monthBucket(t.entryTs);
    months[mo] ??= { start: eq };
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
  const redMonths = Object.entries(months).filter(([, s]) => s.retPct < 0).map(([y, s]) => `${y}=${s.retPct}%`);
  return {
    trades: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    oosN: oos.length,
    oosRet: oos.length ? +(((oosEq - START) / START) * 100).toFixed(2) : 0,
    redMonths,
    monthClean: redMonths.length === 0,
  };
}

async function run(candles, funding, tf, over = {}) {
  const cfg = { ...core(tf), ...over, backtestSignalStartMs: fromMs };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: tf,
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, tf) },
    symbol: SYMBOL,
  });
  return (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

const variants = (tf) => [
  { id: `${tf}_poc_only`, over: { vpAllowedSetups: ["poc_bounce"], vpRequireHtfAlign: false, vpMinScore: 5 } },
  { id: `${tf}_poc_naked`, over: { vpAllowedSetups: ["poc_bounce", "naked_poc"], vpRequireHtfAlign: false, vpMinScore: 5 } },
  { id: `${tf}_poc_rej_noHtf`, over: { vpAllowedSetups: ["poc_bounce", "va_rejection"], vpRequireHtfAlign: false, vpMinScore: 5 } },
  { id: `${tf}_poc_htf0003`, over: { vpAllowedSetups: ["poc_bounce"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0003, vpMinScore: 5 } },
  { id: `${tf}_no_val_vah`, over: { vpAllowedSetups: ["poc_bounce", "va_rejection", "lvn_vacuum", "naked_poc"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0005, vpMinScore: 6 } },
  { id: `${tf}_rej_noHtf`, over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: false, vpMinScore: 5, vpMinBarGap: 1 } },
  { id: `${tf}_rej_htf0003`, over: { vpAllowedSetups: ["va_rejection"], vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0003, vpMinScore: 5, vpMinBarGap: 1 } },
  { id: `${tf}_poc_SELL`, over: { vpAllowedSetups: ["poc_bounce"], vpRequireHtfAlign: false, vpMinScore: 5, vpAllowedSides: ["SELL"] } },
  { id: `${tf}_poc_BUY`, over: { vpAllowedSetups: ["poc_bounce"], vpRequireHtfAlign: false, vpMinScore: 5, vpAllowedSides: ["BUY"] } },
];

const all = [];
console.log(`\n══ XAU round-2 — ${FROM}→${TO} ══`);

for (const tf of TFS) {
  const c = core(tf);
  const padFrom = volumeProfilePadFromMs(fromMs, tf, c);
  if (process.env.SKIP_ENSURE !== "1") {
    await ensureKlines(SYMBOL, tf, { from: padFrom, to: toMs, market: "futures" });
    try {
      await ensureFunding(SYMBOL, { from: padFrom, to: toMs });
    } catch {}
  }
  const candles = await readCandles(SYMBOL, tf, padFrom, toMs, { market: "futures" });
  const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
  console.error(`\n${tf}: candles=${candles.length}`);
  for (const v of variants(tf)) {
    const trades = await run(candles, funding, tf, v.over);
    const m = metricsFor(trades, tf);
    all.push({ id: v.id, tf, ...m, over: v.over });
    if (m.trades > 0) {
      console.log(
        `${v.id.padEnd(24)} n=${String(m.trades).padStart(3)} tw=${m.tw} ret=${String(m.ret).padStart(7)}% cal=${String(m.calmar).padStart(6)} oos=${m.oosRet}% clean=${m.monthClean}`,
      );
    }
  }
}

const ranked = [...all]
  .filter((r) => r.trades >= 3)
  .sort((a, b) => {
    const aOk = a.ret > 0 && a.oosRet >= 0 ? 1 : 0;
    const bOk = b.ret > 0 && b.oosRet >= 0 ? 1 : 0;
    if (bOk !== aOk) return bOk - aOk;
    if (b.monthClean !== a.monthClean) return (b.monthClean ? 1 : 0) - (a.monthClean ? 1 : 0);
    return b.calmar - a.calmar || b.ret - a.ret;
  });

console.log("\n══ Top (n≥3) ══");
for (const r of ranked.slice(0, 10)) {
  console.log(`${r.id.padEnd(24)} ret=${r.ret}% cal=${r.calmar} tw=${r.tw} oos=${r.oosRet}% n=${r.trades}`);
}

const best = ranked.find((r) => r.ret > 0 && r.oosRet >= 0);
console.log(`\n══ Best positive: ${best ? `${best.id} ret=${best.ret}%` : "NONE"} ══`);

fs.writeFileSync(path.join(__dirname, ".vp-freq-xau-round2.json"), JSON.stringify({ all, ranked: ranked.slice(0, 15), best }, null, 2));
await closePool?.();
