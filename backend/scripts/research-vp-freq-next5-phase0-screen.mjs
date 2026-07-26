#!/usr/bin/env node
/**
 * VP FREQ Phase 0 multi-coin screen for next-5 candidates.
 * Coin-native — no copied cell locks. F0_open + F3_rej_only only (fast rank).
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-next5-phase0-screen.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = String(process.env.SYMBOLS || "ZECUSDT,DOGEUSDT,NEARUSDT,ADAUSDT,XLMUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const TF = "15m";
const FROM = process.env.FROM || "2021-01-01";
const TO = process.env.TO || "2026-05-31";
const OOS_END = process.env.OOS_END || "2023-06-01";
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

const FUNNELS = [
  {
    id: "F0_open",
    over: {
      vpAllowedSetups: [
        "lvn_vacuum",
        "vah_breakout",
        "val_breakdown",
        "poc_bounce",
        "va_rejection",
        "naked_poc",
      ],
    },
  },
  { id: "F3_rej_only", over: { vpAllowedSetups: ["va_rejection"] } },
  {
    id: "F1_val_rej",
    over: { vpAllowedSetups: ["val_breakdown", "va_rejection"] },
  },
];

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
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
  eq = START_USDT;
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

const all = [];
for (const symbol of SYMBOLS) {
  const core = coreFor(symbol);
  const padFrom = volumeProfilePadFromMs(fromMs, TF, core);
  console.error(`\n=== ${symbol} load ===`);
  if (process.env.SKIP_ENSURE !== "1") {
    await ensureKlines(symbol, TF, { from: padFrom, to: toMs, market: "futures" });
    try {
      await ensureFunding(symbol, { from: padFrom, to: toMs });
    } catch (e) {
      console.error(`funding ensure fail ${symbol}: ${e.message || e}`);
    }
  }
  const candles = await readCandles(symbol, TF, padFrom, toMs, { market: "futures" });
  const funding = await readFundingRates(symbol, padFrom, toMs).catch(() => []);
  console.error(`candles=${candles.length} funding=${funding.length}`);

  const rows = [];
  for (const f of FUNNELS) {
    console.error(`run ${symbol} ${f.id}`);
    const trades = await run(symbol, candles, funding, f.over);
    const full = metricsFor(trades);
    const oos = sliceMetrics(trades, fromMs, oosEndMs);
    const is = sliceMetrics(trades, oosEndMs, toMs);
    const row = { symbol, id: f.id, full, oos, is, years: full.years };
    rows.push(row);
    all.push(row);
    console.log(
      `${symbol.padEnd(10)} ${f.id.padEnd(14)} FULL n=${full.trades} tw=${full.tw} ret=${full.ret} pf=${full.pf} cal=${full.calmar} | OOS n=${oos.trades} ret=${oos.ret} pf=${oos.pf} | IS ret=${is.ret}`,
    );
    console.log(
      `  years ${Object.entries(full.years)
        .map(([y, s]) => `${y}:${s.n}/${s.retPct}%`)
        .join(" ")}`,
    );
  }
}

all.sort((a, b) => b.oos.ret - a.oos.ret || b.full.calmar - a.full.calmar);
console.log("\n══ Rank by OOS ret ══");
for (const r of all.slice(0, 15)) {
  console.log(
    `${r.symbol.padEnd(10)} ${r.id.padEnd(14)} OOS ${r.oos.ret}% n=${r.oos.trades} | FULL ${r.full.ret}% tw=${r.full.tw} cal=${r.full.calmar}`,
  );
}

const outPath = path.join(__dirname, ".vp-freq-next5-phase0-screen.json");
fs.writeFileSync(
  outPath,
  JSON.stringify({ generatedAt: new Date().toISOString(), from: FROM, to: TO, oosEnd: OOS_END, rows: all }, null, 2),
);
console.error("wrote", outPath);
await closePool?.();
