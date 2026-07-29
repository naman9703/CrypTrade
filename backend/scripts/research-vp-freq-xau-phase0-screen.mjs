#!/usr/bin/env node
/**
 * XAUUSDT VP FREQ Phase 0 screen — coin-native window.
 *
 * XAUUSDT futures onboard: 2025-12-11 (~7mo history as of 2026-07).
 * Standard 2021→2026 window is invalid; use available data only.
 *
 *   node scripts/research-vp-freq-xau-phase0-screen.mjs
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-xau-phase0-screen.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = process.env.SYMBOL || "XAUUSDT";
const TF = "15m";
/** XAUUSDT Binance futures onboard ~2025-12-11; pad 30d for VP macro lookback */
const FROM = process.env.FROM || "2025-11-01";
const TO = process.env.TO || "2026-05-31";
/** Holdout: last ~3mo as OOS proxy (limited history — not full WF cert) */
const OOS_END = process.env.OOS_END || "2026-03-01";
const START_USDT = 100;
const RISK_PCT = 2.5;
const LEVERAGE = 12;

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

const FUNNELS = {
  F3_rej_only: { vpAllowedSetups: ["va_rejection"] },
  F0_open: {
    vpAllowedSetups: [
      "lvn_vacuum",
      "vah_breakout",
      "val_breakdown",
      "poc_bounce",
      "va_rejection",
      "naked_poc",
    ],
  },
  F1_val_rej: { vpAllowedSetups: ["val_breakdown", "va_rejection"] },
  F2_poc: { vpAllowedSetups: ["poc_bounce", "va_rejection"] },
};

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function monthBucket(ts) {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function metricsFor(trades) {
  let eq = START_USDT;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of trades) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf: TF, startingEquity: START_USDT });
  const years = {};
  const months = {};
  eq = START_USDT;
  for (const t of trades) {
    const y = yearBucket(t.entryTs);
    const mo = monthBucket(t.entryTs);
    years[y] ??= { n: 0, start: eq };
    months[mo] ??= { n: 0, start: eq };
    years[y].n += 1;
    months[mo].n += 1;
    eq += Number(t.netPnl ?? 0);
    years[y].end = eq;
    months[mo].end = eq;
  }
  for (const y of Object.values(years)) {
    y.retPct = y.start ? +(((y.end - y.start) / y.start) * 100).toFixed(2) : 0;
  }
  for (const mo of Object.values(months)) {
    mo.retPct = mo.start ? +(((mo.end - mo.start) / mo.start) * 100).toFixed(2) : 0;
  }
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  const redYears = Object.entries(years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
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
    years,
    months,
    redYears,
    redMonths,
  };
}

function sliceMetrics(trades, lo, hi) {
  const subset = trades.filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
  let eq = START_USDT;
  const curve = [{ ts: lo, equity: eq }];
  for (const t of subset) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades: subset, equityCurve: curve, tf: TF, startingEquity: START_USDT });
  const weeks = Math.max(1, (hi - lo) / (7 * 864e5));
  return {
    trades: subset.length,
    tw: +(subset.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
  };
}

function coreFor(symbol) {
  return {
    ...VOLUME_PROFILE_BASE,
    ...VOLUME_PROFILE_FREQ_CORE,
    vpPlaybook: "CUSTOM",
    vpMinAdx: 0.0001,
    symbol,
    timeframe: TF,
    vpRequireHtfAlign: true,
    vpMinHtfSepPct: 0.0015,
    vpMinScore: 7,
    vpMinBarGap: 2,
    vpMaxTradesPerDay: 2,
    vpNoveltyEnabled: false,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: RISK_PCT,
    riskPerTradeUnit: "PCT",
    futuresLeverage: LEVERAGE,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
  };
}

async function run(symbol, candles, funding, over = {}) {
  const cfg = { ...coreFor(symbol), ...over, backtestSignalStartMs: fromMs };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) },
    symbol,
  });
  return (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

const core = coreFor(SYMBOL);
const padFrom = volumeProfilePadFromMs(fromMs, TF, core);
console.log(`\n══ XAU VP FREQ Phase 0 — ${SYMBOL} · ${FROM}→${TO} (OOS split ${OOS_END}) ══`);
console.error(`NOTE: XAUUSDT futures onboard ~2025-12-11 — multi-year cert NOT possible on this symbol.`);

if (process.env.SKIP_ENSURE !== "1") {
  await ensureKlines(SYMBOL, TF, { from: padFrom, to: toMs, market: "futures" });
  try {
    await ensureFunding(SYMBOL, { from: padFrom, to: toMs });
  } catch (e) {
    console.error(`funding ensure fail: ${e.message || e}`);
  }
}
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
const first = candles[0] ? new Date(candles[0].ts).toISOString().slice(0, 10) : "none";
const last = candles.at(-1) ? new Date(candles.at(-1).ts).toISOString().slice(0, 10) : "none";
console.error(`candles=${candles.length} funding=${funding.length} ${first}→${last}`);

if (candles.length < 5000) {
  console.error(`WARN: thin history (${candles.length} bars) — results are exploratory only`);
}

const results = [];
for (const [id, over] of Object.entries(FUNNELS)) {
  console.error(`run ${SYMBOL} ${id}`);
  const trades = await run(SYMBOL, candles, funding, over);
  const full = metricsFor(trades);
  const oos = sliceMetrics(trades, oosEndMs, toMs);
  const is_ = sliceMetrics(trades, fromMs, oosEndMs);
  results.push({ id, full, oos, is: is_ });
  console.log(
    `${id.padEnd(12)} FULL n=${full.trades} tw=${full.tw} ret=${full.ret}% pf=${full.pf} cal=${full.calmar} dd=${full.dd}% | OOS n=${oos.trades} ret=${oos.ret}% | IS ret=${is_.ret}%`,
  );
  if (full.redYears.length) console.log(`  redYears: ${full.redYears.join(", ")}`);
  if (full.redMonths.length) console.log(`  redMonths: ${full.redMonths.join(", ")}`);
}

const ranked = [...results].sort((a, b) => {
  const aOk = a.oos.ret > 0 && a.full.ret > 0 ? 1 : 0;
  const bOk = b.oos.ret > 0 && b.full.ret > 0 ? 1 : 0;
  if (bOk !== aOk) return bOk - aOk;
  if (b.oos.ret !== a.oos.ret) return b.oos.ret - a.oos.ret;
  if (b.full.calmar !== a.full.calmar) return b.full.calmar - a.full.calmar;
  return b.full.tw - a.full.tw;
});

console.log("\n══ Rank (OOS>0 & FULL>0 first) ══");
for (const r of ranked) {
  console.log(
    `${r.id.padEnd(12)} FULL ${r.full.ret}% cal=${r.full.calmar} tw=${r.full.tw} | OOS ${r.oos.ret}% n=${r.oos.trades}`,
  );
}

const best = ranked[0];
const out = {
  symbol: SYMBOL,
  window: { from: FROM, to: TO, oosEnd: OOS_END },
  candles: candles.length,
  dataRange: { first, last },
  note: "XAUUSDT ~7mo history — checkpoint only, not multi-year cert",
  results,
  best: best?.id ?? null,
};
fs.writeFileSync(path.join(__dirname, ".vp-freq-xau-phase0.json"), JSON.stringify(out, null, 2));
console.log(`\n══ Best funnel: ${best?.id ?? "NONE"} ══`);
await closePool?.();
