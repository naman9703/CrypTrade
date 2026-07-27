#!/usr/bin/env node
/**
 * NEAR F3 year-clean — frequency restore (one change each).
 * Baseline: locked year-clean sleeve (HTF align + sep 0.0045, va_rejection only).
 *   sep_0045: n=35 tw=0.12 ret=+193% cal=1.60 dd=14.6 — all years ≥0.
 * Accept only if: all years ≥0 AND tw↑ AND FULL ret not crushed (> baseline−40pp).
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-near-f3-freq-restore.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "NEARUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
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

const LOCK = {
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
  // Year-clean lock for NEAR
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0045,
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
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  return {
    trades: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    years,
  };
}

async function run(candles, funding, over = {}) {
  const cfg = { ...LOCK, ...over, backtestSignalStartMs: fromMs };
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

const VARIANTS = [
  { id: "H0_year_clean_lock", over: {} },
  // Throttle / gate loosens
  { id: "gap1", over: { vpMinBarGap: 1 } },
  { id: "score6", over: { vpMinScore: 6 } },
  { id: "maxDay3", over: { vpMaxTradesPerDay: 3 } },
  { id: "sep_0040", over: { vpMinHtfSepPct: 0.004 } },
  // Setup expansion (primary path to meaningful freq) — keep va_rejection base
  { id: "add_poc", over: { vpAllowedSetups: ["va_rejection", "poc_bounce"] } },
  { id: "add_val", over: { vpAllowedSetups: ["va_rejection", "val_breakdown"] } },
  { id: "add_vah", over: { vpAllowedSetups: ["va_rejection", "vah_breakout"] } },
  { id: "add_lvn", over: { vpAllowedSetups: ["va_rejection", "lvn_vacuum"] } },
  { id: "add_naked", over: { vpAllowedSetups: ["va_rejection", "naked_poc"] } },
  { id: "add_poc_score6", over: { vpAllowedSetups: ["va_rejection", "poc_bounce"], vpMinScore: 6 } },
  { id: "add_poc_gap1", over: { vpAllowedSetups: ["va_rejection", "poc_bounce"], vpMinBarGap: 1 } },
];

const padFrom = volumeProfilePadFromMs(fromMs, TF, LOCK);
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);

const results = [];
let h0 = null;

console.log(`\n══ NEAR year-clean freq restore A/B ══`);
for (const v of VARIANTS) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  if (!h0) h0 = m;
  const red = Object.entries(m.years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  const allNonNeg = red.length === 0;
  const twUp = m.tw > h0.tw + 0.01;
  const retOk = m.ret >= h0.ret - 40;
  const accept = allNonNeg && twUp && retOk;
  const row = { id: v.id, over: v.over, ...m, red, allNonNeg, twUp, retOk, accept };
  results.push(row);
  console.log(
    `${v.id}\n  FULL n=${m.trades} tw=${m.tw} ret=${m.ret}% pf=${m.pf} cal=${m.calmar}\n  years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}\n  RED: ${red.join(" ") || "none"} | yearClean=${allNonNeg} tw↑=${twUp} retOk=${retOk} → ${accept ? "ACCEPT" : "reject"}`,
  );
}

results.sort(
  (a, b) =>
    Number(b.accept) - Number(a.accept) ||
    Number(b.allNonNeg) - Number(a.allNonNeg) ||
    b.tw - a.tw ||
    b.ret - a.ret,
);

console.log("\n══ Ranked ══");
for (const r of results) {
  console.log(
    `${r.id.padEnd(24)} accept=${r.accept} yearClean=${r.allNonNeg} tw=${r.tw} (Δ${+(r.tw - h0.tw).toFixed(2)}) ret=${r.ret}% cal=${r.calmar} | RED:${r.red.join(",") || "none"}`,
  );
}

const accepted = results.filter((r) => r.accept);
console.log(`\n══ Accepted restores: ${accepted.length} ══`);
for (const r of accepted) {
  console.log(`  ${r.id} tw=${r.tw} ret=${r.ret}% cal=${r.calmar}`);
}

const outPath = path.join(__dirname, ".vp-freq-near-f3-freq-restore.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), h0, results, accepted }, null, 2));
console.error("wrote", outPath);
await closePool?.();
