#!/usr/bin/env node
/**
 * ETH surgical bull60 VAL A/B — preserve ~485% lock window.
 *
 * Rejected: blanket block all bull60 VAL (kills 2025–26 +137%→+69%).
 * Candidates from dissect:
 *   v1 dump:   bull60 + prior20d≤−5% (multi-year −$26; 2025–26 ~1 trade)
 *   v2 nonvac: bull60 + non-vacuum (multi-year −$14; keeps vacuum 2025–26 edge)
 *   v3 both
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "ETHUSDT";
const TF = "15m";
const START = 100;

const WINDOWS = [
  { label: "lock_22_26", from: "2022-06-01", to: "2026-05-31" },
  { label: "oos_21_22", from: "2021-06-01", to: "2022-05-31" },
  { label: "oos_20_21", from: "2020-06-01", to: "2021-05-31" },
  { label: "full_20_26", from: "2020-01-01", to: "2026-05-31" },
];

const VARIANTS = [
  { label: "v0_restored", patch: {} },
  {
    label: "v1_bull60_dump",
    patch: {
      vpValSellBlockBull60Dump: true,
      vpValSellBull60Pct: 0.05,
      vpValSellBull60DumpPrior20dPct: -0.05,
    },
  },
  {
    label: "v2_bull60_nonvac",
    patch: { vpValSellBlockBull60NonVac: true, vpValSellBull60Pct: 0.05 },
  },
  {
    label: "v3_dump_and_nonvac",
    patch: {
      vpValSellBlockBull60Dump: true,
      vpValSellBlockBull60NonVac: true,
      vpValSellBull60Pct: 0.05,
      vpValSellBull60DumpPrior20dPct: -0.05,
    },
  },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_ETH_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

const cache = new Map();
async function load(from, to) {
  const k = `${from}|${to}`;
  if (cache.has(k)) return cache.get(k);
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const padFrom = volumeProfilePadFromMs(fromMs, TF, VOLUME_PROFILE_FREQ_ETH_15M);
  const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
  let funding = [];
  try { funding = await readFundingRates(SYMBOL, padFrom, toMs); } catch { funding = []; }
  const v = { candles, funding, fromMs, toMs };
  cache.set(k, v);
  return v;
}

async function run(from, to, patch) {
  const { candles, funding, fromMs, toMs } = await load(from, to);
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
    ...patch,
  };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE", candles, cfg, gateMode: "off", fundingRates: funding,
    startingUsdt: START, timeframe: TF, adapters, symbol: SYMBOL,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const years = {};
  let eq = START;
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    const y = yearBucket(t.entryTs ?? t.entry_time);
    years[y] ??= { n: 0, net: 0, start: eq };
    years[y].n += 1; years[y].net += pnl; eq += pnl; years[y].end = eq;
  }
  for (const r of Object.values(years)) r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  return { n: closed.length, ret: m.totalReturnPct, dd: m.maxDrawdownPct, calmar: m.calmar, years };
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
const out = { generatedAt: new Date().toISOString(), windows: {} };

console.log("\n=== ETH surgical bull60 VAL A/B ===\n");
for (const w of WINDOWS) {
  console.log(`--- ${w.label} ---`);
  out.windows[w.label] = {};
  for (const v of VARIANTS) {
    const r = await run(w.from, w.to, v.patch);
    out.windows[w.label][v.label] = r;
    console.log(
      `  ${v.label.padEnd(20)} N=${String(r.n).padStart(3)} ret=${fmt(r.ret).padStart(7)}% DD=${fmt(r.dd)}%`,
    );
    if (w.label === "lock_22_26" || w.label === "full_20_26") {
      console.log(
        `    years: ${Object.entries(r.years).map(([y, v2]) => `${y}=${fmt(v2.retPct)}%/${v2.n}`).join("  ")}`,
      );
    }
  }
  console.log("");
}

const base = out.windows.lock_22_26.v0_restored;
console.log("=== ACCEPTANCE (lock must stay ~≥450% / DD≲30% / N≳150) ===");
for (const lab of ["v1_bull60_dump", "v2_bull60_nonvac", "v3_dump_and_nonvac"]) {
  const lock = out.windows.lock_22_26[lab];
  const oos = out.windows.oos_21_22[lab];
  const lockOk = lock.ret >= 450 && lock.dd <= 30 && lock.n >= 150;
  const oosLift = oos.ret - out.windows.oos_21_22.v0_restored.ret;
  console.log(
    `  ${lab.padEnd(20)} lockOk=${lockOk} lock=${fmt(lock.ret)}%/${lock.n}t/DD${fmt(lock.dd)}  oos21-22=${fmt(oos.ret)}% (Δ ${oosLift >= 0 ? "+" : ""}${fmt(oosLift)})`,
  );
}

fs.writeFileSync(path.resolve(__dirname, ".vp-freq-eth-bull60-surgical-ab.json"), JSON.stringify(out, null, 2));
console.log("\nwrote .vp-freq-eth-bull60-surgical-ab.json");
await closePool?.();
