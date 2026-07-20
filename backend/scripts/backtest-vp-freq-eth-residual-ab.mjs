#!/usr/bin/env node
/**
 * ETH VP FREQ — one-change residual bleed cut on allowlist.
 * Hypothesis: drop SELL|val_breakdown|bull_chop|vacuum (biggest 2019-20 bleeder,
 * barely-prepared +$5.1 full) to lift Calmar over 1.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const TF = "15m";
const SYMBOL = "ETHUSDT";
const START_USDT = 100;

const CORE = [
  "BUY|vah_breakout|bull_trend|structured",
  "BUY|vah_breakout|weak_bear|vacuum",
  "SELL|val_breakdown|bear_trend|tight",
  "BUY|va_rejection|bull_trend|tight",
  "SELL|val_breakdown|bull_trend|vacuum",
  "BUY|vah_breakout|bull_chop|structured",
  "SELL|val_breakdown|bear_trend|structured",
  "SELL|val_breakdown|bear_trend|vacuum",
];
const BULL_CHOP_VAC = "SELL|val_breakdown|bull_chop|vacuum";
const BUY_BULL_STRUCT = "BUY|vah_breakout|bull_trend|structured";

const WINDOWS = [
  { label: "full", from: "2020-01-01", to: "2026-05-31" },
  { label: "y19_20", from: "2020-01-01", to: "2020-05-31" },
  { label: "y20_21", from: "2020-06-01", to: "2021-05-31" },
  { label: "y21_22", from: "2021-06-01", to: "2022-05-31" },
  { label: "y22_23", from: "2022-06-01", to: "2023-05-31" },
  { label: "y25_26", from: "2025-06-01", to: "2026-05-31" },
];

const VARIANTS = [
  { label: "v2_locked", keys: [...CORE, BULL_CHOP_VAC] },
  { label: "v3_drop_bullchop_vac", keys: CORE },
  { label: "v4_drop_buy_bull_struct", keys: [...CORE.filter((k) => k !== BUY_BULL_STRUCT), BULL_CHOP_VAC] },
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

async function run(from, to, keys) {
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
    vpPreparedAllowlistOnly: true,
    vpPreparedCellKeys: keys,
  };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START_USDT,
    timeframe: TF,
    adapters,
    symbol: SYMBOL,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START_USDT });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const years = {};
  let eq = START_USDT;
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    const y = yearBucket(t.entryTs ?? t.entry_time);
    years[y] ??= { n: 0, net: 0, start: eq };
    years[y].n += 1;
    years[y].net += pnl;
    eq += pnl;
    years[y].end = eq;
  }
  for (const r of Object.values(years)) r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  const weeks = (toMs - fromMs) / (7 * 86_400_000);
  return {
    n: closed.length,
    tPerWk: closed.length / weeks,
    ret: m.totalReturnPct,
    cagr: m.cagrPct,
    dd: m.maxDrawdownPct,
    calmar: m.calmar,
    pf: m.profitFactor,
    years,
  };
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
const out = { generatedAt: new Date().toISOString(), variants: {}, windows: {} };

console.log("\n=== ETH residual bleed one-change A/B ===\n");
for (const w of WINDOWS) {
  console.log(`--- ${w.label} ---`);
  out.windows[w.label] = {};
  for (const v of VARIANTS) {
    const r = await run(w.from, w.to, v.keys);
    out.windows[w.label][v.label] = r;
    console.log(
      `  ${v.label.padEnd(26)} N=${String(r.n).padStart(3)} ret=${fmt(r.ret).padStart(7)}% DD=${fmt(r.dd)}% Calmar=${fmt(r.calmar, 2)}`,
    );
    if (w.label === "full") {
      const ys = Object.entries(r.years).map(([y, v2]) => `${y}=${fmt(v2.retPct)}%/${v2.n}`).join("  ");
      console.log(`    years: ${ys}`);
    }
  }
  console.log("");
}

const outPath = path.resolve(__dirname, ".vp-freq-eth-residual-ab.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log("wrote", outPath);
await closePool?.();
