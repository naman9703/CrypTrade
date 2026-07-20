#!/usr/bin/env node
/**
 * Confirm locked ETH Layer1+Layer3 preset on OOS year windows (no certification).
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const WINDOWS = [
  { label: "full", from: "2020-01-01", to: "2026-05-31" },
  { label: "y20_21", from: "2020-06-01", to: "2021-05-31" },
  { label: "y21_22", from: "2021-06-01", to: "2022-05-31" },
  { label: "y22_23", from: "2022-06-01", to: "2023-05-31" },
  { label: "y23_24", from: "2023-06-01", to: "2024-05-31" },
  { label: "y24_25", from: "2024-06-01", to: "2025-05-31" },
  { label: "y25_26", from: "2025-06-01", to: "2026-05-31" },
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const { VOLUME_PROFILE_FREQ_ETH_15M, volumeProfilePadFromMs } = await import("../src/strategy/presets/volumeProfileOptimized.js");

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

const cache = new Map();
async function run(from, to) {
  const k = `${from}|${to}`;
  if (!cache.has(k)) {
    const fromMs = Date.parse(from);
    const toMs = Date.parse(to);
    const padFrom = volumeProfilePadFromMs(fromMs, "15m", VOLUME_PROFILE_FREQ_ETH_15M);
    const candles = await readCandles("ETHUSDT", "15m", padFrom, toMs, { market: "futures" });
    let funding = [];
    try { funding = await readFundingRates("ETHUSDT", padFrom, toMs); } catch { funding = []; }
    cache.set(k, { candles, funding, fromMs, toMs });
  }
  const { candles, funding, fromMs, toMs } = cache.get(k);
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    symbol: "ETHUSDT", timeframe: "15m", marketMode: "FUTURES", strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE", riskPerTrade: 2.5, riskPerTradeUnit: "PCT",
    futuresLeverage: 12, backtestPositionSizing: "RISK_AT_SL", slippagePct: 0.0005,
    maxDailyLoss: 0, backtestSignalStartMs: fromMs,
  };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, "15m") };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE", candles, cfg, gateMode: "off", fundingRates: funding,
    startingUsdt: 100, timeframe: "15m", adapters, symbol: "ETHUSDT",
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: "15m", startingEquity: 100 });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const years = {};
  let eq = 100;
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    const y = yearBucket(t.entryTs ?? t.entry_time);
    years[y] ??= { n: 0, net: 0, start: eq };
    years[y].n += 1; years[y].net += pnl; eq += pnl; years[y].end = eq;
  }
  for (const r of Object.values(years)) r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  const weeks = (toMs - fromMs) / (7 * 86_400_000);
  return { n: closed.length, tPerWk: closed.length / weeks, ret: m.totalReturnPct, dd: m.maxDrawdownPct, calmar: m.calmar, years };
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");
const out = { generatedAt: new Date().toISOString(), preset: "VOLUME_PROFILE_FREQ_ETH_15M", windows: {} };
console.log("\n=== ETH locked Layer1+Layer3 confirm ===\n");
for (const w of WINDOWS) {
  const r = await run(w.from, w.to);
  out.windows[w.label] = r;
  console.log(`${w.label.padEnd(8)} N=${String(r.n).padStart(3)} ${fmt(r.tPerWk, 2)}/wk ret=${fmt(r.ret).padStart(7)}% DD=${fmt(r.dd)}% Calmar=${fmt(r.calmar, 2)}`);
  if (w.label === "full") {
    console.log(`  years: ${Object.entries(r.years).map(([y, v]) => `${y}=${fmt(v.retPct)}%/${v.n}`).join("  ")}`);
  }
}
fs.writeFileSync(path.resolve(__dirname, ".vp-freq-eth-layer3-confirm.json"), JSON.stringify(out, null, 2));
console.log("\nwrote .vp-freq-eth-layer3-confirm.json");
await closePool?.();
