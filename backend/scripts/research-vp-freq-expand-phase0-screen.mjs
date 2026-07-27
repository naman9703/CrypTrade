#!/usr/bin/env node
/**
 * VP FREQ expanded Phase 0 screen — coins beyond next-5 + already-sleeved majors.
 *
 * Excludes: BTC/ETH/BNB/SOL/AVAX (locked streams), DOGE/NEAR (low-freq sleeves),
 * ZEC/ADA/XLM (reject/defer), XRP (parked thin-N / reject 2026-07-22).
 *
 * Fast rank: F3_rej_only first. Top candidates get F0 + F1.
 * Ensures klines/funding unless SKIP_ENSURE=1.
 *
 *   node scripts/research-vp-freq-expand-phase0-screen.mjs
 *   SYMBOLS=LINKUSDT,DOTUSDT SKIP_ENSURE=1 node scripts/research-vp-freq-expand-phase0-screen.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = String(
  process.env.SYMBOLS ||
    "LINKUSDT,DOTUSDT,ATOMUSDT,UNIUSDT,AAVEUSDT,FILUSDT,LTCUSDT,TRXUSDT,INJUSDT,APTUSDT,OPUSDT,ARBUSDT,SUIUSDT,ICPUSDT",
)
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
const TOP_DEEP = Math.max(1, Math.floor(Number(process.env.TOP_DEEP || 4)));

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
};

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
  const redYears = Object.entries(years)
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
    redYears,
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
const skipped = [];

console.log(`\n══ VP FREQ expand Phase 0 — ${SYMBOLS.length} symbols · ${FROM}→${TO} ══`);

for (const symbol of SYMBOLS) {
  const core = coreFor(symbol);
  const padFrom = volumeProfilePadFromMs(fromMs, TF, core);
  console.error(`\n=== ${symbol} load ===`);
  try {
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
    const first = candles[0] ? new Date(candles[0].ts).toISOString().slice(0, 10) : "none";
    const last = candles.at(-1) ? new Date(candles.at(-1).ts).toISOString().slice(0, 10) : "none";
    console.error(`candles=${candles.length} funding=${funding.length} ${first}→${last}`);
    if (candles.length < 20_000) {
      skipped.push({ symbol, reason: `too_few_candles=${candles.length}` });
      console.error(`SKIP ${symbol}: insufficient history`);
      continue;
    }

    console.error(`run ${symbol} F3_rej_only`);
    const trades = await run(symbol, candles, funding, FUNNELS.F3_rej_only);
    const full = metricsFor(trades);
    const oos = sliceMetrics(trades, fromMs, oosEndMs);
    const is = sliceMetrics(trades, oosEndMs, toMs);
    const row = {
      symbol,
      id: "F3_rej_only",
      candles: candles.length,
      first,
      last,
      full,
      oos,
      is,
      years: full.years,
      _candles: candles,
      _funding: funding,
    };
    all.push(row);
    console.log(
      `${symbol.padEnd(10)} F3_rej_only   FULL n=${full.trades} tw=${full.tw} ret=${full.ret}% pf=${full.pf} cal=${full.calmar} | OOS n=${oos.trades} ret=${oos.ret}% | IS ret=${is.ret}%`,
    );
    console.log(
      `  years ${Object.entries(full.years)
        .map(([y, s]) => `${y}:${s.n}/${s.retPct}%`)
        .join(" ")}`,
    );
    console.log(`  RED: ${full.redYears.join(" ") || "none"}`);
  } catch (e) {
    skipped.push({ symbol, reason: String(e.message || e) });
    console.error(`FAIL ${symbol}: ${e.message || e}`);
  }
}

// Rank F3: prefer OOS>0 + FULL>0, then OOS ret, then Calmar, then tw
const f3 = all.filter((r) => r.id === "F3_rej_only");
f3.sort(
  (a, b) =>
    Number(b.oos.ret > 0 && b.full.ret > 0) - Number(a.oos.ret > 0 && a.full.ret > 0) ||
    Number(b.oos.ret > 0) - Number(a.oos.ret > 0) ||
    b.oos.ret - a.oos.ret ||
    b.full.calmar - a.full.calmar ||
    b.full.tw - a.full.tw,
);

console.log("\n══ F3 rank (usable first: OOS>0 & FULL>0) ══");
for (const r of f3) {
  const usable = r.oos.ret > 0 && r.full.ret > 0;
  console.log(
    `${usable ? "★" : " "} ${r.symbol.padEnd(10)} OOS ${String(r.oos.ret).padStart(7)}% n=${String(r.oos.trades).padStart(3)} | FULL ${String(r.full.ret).padStart(7)}% tw=${r.full.tw} cal=${r.full.calmar} | red=${r.full.redYears.length}`,
  );
}

const deepIds = f3.slice(0, TOP_DEEP).map((r) => r.symbol);
console.log(`\n══ Deep funnels on top ${TOP_DEEP}: ${deepIds.join(", ") || "none"} ══`);

for (const symbol of deepIds) {
  const base = f3.find((r) => r.symbol === symbol);
  if (!base?._candles) continue;
  for (const id of ["F0_open", "F1_val_rej"]) {
    console.error(`run ${symbol} ${id}`);
    const trades = await run(symbol, base._candles, base._funding, FUNNELS[id]);
    const full = metricsFor(trades);
    const oos = sliceMetrics(trades, fromMs, oosEndMs);
    const is = sliceMetrics(trades, oosEndMs, toMs);
    const row = { symbol, id, candles: base.candles, first: base.first, last: base.last, full, oos, is, years: full.years };
    all.push(row);
    console.log(
      `${symbol.padEnd(10)} ${id.padEnd(14)} FULL n=${full.trades} tw=${full.tw} ret=${full.ret}% pf=${full.pf} cal=${full.calmar} | OOS n=${oos.trades} ret=${oos.ret}% | IS ret=${is.ret}%`,
    );
    console.log(`  RED: ${full.redYears.join(" ") || "none"}`);
  }
}

const serializable = all.map(({ _candles, _funding, ...r }) => r);
const best =
  f3.find((r) => r.oos.ret > 0 && r.full.ret > 0) ||
  f3.find((r) => r.oos.ret > 0) ||
  f3[0] ||
  null;

console.log(`\n══ Next deep-work pick: ${best ? `${best.symbol} F3 (OOS ${best.oos.ret}% / FULL ${best.full.ret}% / tw ${best.full.tw})` : "NONE"} ══`);
if (skipped.length) {
  console.log("Skipped:", skipped.map((s) => `${s.symbol}(${s.reason})`).join("; "));
}

const outPath = path.join(__dirname, ".vp-freq-expand-phase0-screen.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      from: FROM,
      to: TO,
      oosEnd: OOS_END,
      symbols: SYMBOLS,
      skipped,
      best: best
        ? {
            symbol: best.symbol,
            id: best.id,
            oos: best.oos,
            full: { trades: best.full.trades, tw: best.full.tw, ret: best.full.ret, calmar: best.full.calmar, pf: best.full.pf, redYears: best.full.redYears },
            years: best.years,
          }
        : null,
      rows: serializable,
    },
    null,
    2,
  ),
);
console.error("wrote", outPath);
await closePool?.();
