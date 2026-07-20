#!/usr/bin/env node
/**
 * Probe Coinalyze API — coverage, sample liquidation/OI, proxy vs Bybit OI drop.
 *
 * Usage: cd backend && node scripts/research-coinalyze-probe.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const COINS = (process.env.COINS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim());
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-01-01";
const INTERVAL = process.env.INTERVAL || "daily";
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const {
  fetchCoinalyzeFutureMarkets,
  resolveCoinalyzePerpSymbol,
  ensureCoinalyzeData,
  loadCoinalyzeSeries,
  fetchCoinalyzeLiquidationHist,
} = await import("../src/backtest/data/coinalyzeIngest.js");
const { loadObservableSeries } = await import("../src/backtest/data/observableFeatures.js");
const { nearestBefore } = await import("../src/backtest/data/l2Features.js");

if (!process.env.COINALYZE_API_KEY) {
  console.error("COINALYZE_API_KEY not set in backend/.env");
  process.exit(1);
}

const DEBUG_RECENT = process.argv.includes("--recent");

if (DEBUG_RECENT) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 7 * 86400;
  const from1y = sec(fromMs);
  const to1y = sec(toMs);
  const czSym = await resolveCoinalyzePerpSymbol("BTCUSDT");
  const { fetchCoinalyzeOiHist } = await import("../src/backtest/data/coinalyzeIngest.js");
  const liq7d = await fetchCoinalyzeLiquidationHist(czSym, "1hour", from * 1000, to * 1000);
  const liq1y = await fetchCoinalyzeLiquidationHist(czSym, "1hour", fromMs, toMs);
  const liqDaily = await fetchCoinalyzeLiquidationHist(czSym, "daily", fromMs, toMs);
  const oiDaily = await fetchCoinalyzeOiHist(czSym, "daily", fromMs, toMs);
  console.log("BTCUSDT_PERP.A coverage:");
  console.log("  1h last 7d:", liq7d.length);
  console.log("  1h 2025 window:", liq1y.length);
  console.log("  daily 2025 window:", liqDaily.length, "oi", oiDaily.length);
  if (liqDaily.length) console.log("  daily sample", liqDaily[0], liqDaily.at(-1));
  await closePool();
  process.exit(0);
}

function sec(ms) {
  return Math.floor(ms / 1000);
}

const markets = await fetchCoinalyzeFutureMarkets({ refresh: true });
console.log(`Coinalyze markets loaded: ${markets.length}`);

const report = { generatedAt: new Date().toISOString(), from: FROM, to: TO, coins: {} };

for (const sym of COINS) {
  const czSym = await resolveCoinalyzePerpSymbol(sym);
  console.log(`\n── ${sym} → ${czSym ?? "NOT FOUND"} ──`);
  if (!czSym) {
    report.coins[sym] = { error: "no_symbol" };
    continue;
  }

  const liveLiq = await fetchCoinalyzeLiquidationHist(czSym, INTERVAL, fromMs, toMs);
  console.log(`API liquidation bars (${INTERVAL}): ${liveLiq.length}`);
  if (liveLiq.length) {
    const totals = liveLiq.map((r) => r.liqLongUsd + r.liqShortUsd);
    const max = Math.max(...totals);
    const p95 = totals.sort((a, b) => a - b)[Math.floor(totals.length * 0.95)] ?? 0;
    console.log(`  liq total USD — max ${(max / 1e6).toFixed(2)}M | p95 ${(p95 / 1e6).toFixed(2)}M`);
  }

  const sync = await ensureCoinalyzeData(sym, fromMs, toMs, { interval: INTERVAL });
  const series = await loadCoinalyzeSeries(sym, fromMs, toMs, { interval: INTERVAL });
  const bybit = await loadObservableSeries(sym, fromMs, toMs, { skipBybit: false });

  let agreeDrop = 0;
  let n = 0;
  for (const liq of series.liquidations) {
    const oiNow = nearestBefore(bybit.bybit?.oi ?? [], liq.ts, "ts");
    const oi4h = nearestBefore(bybit.bybit?.oi ?? [], liq.ts - 4 * 3600_000, "ts");
    if (!oiNow || !oi4h || !(oi4h.oiUsdt > 0)) continue;
    const oiChg = (oiNow.oiUsdt - oi4h.oiUsdt) / oi4h.oiUsdt;
    const liqSpike = liq.liqTotalUsd > 5_000_000;
    const oiDrop = oiChg < -0.02;
    if (liqSpike || oiDrop) {
      n++;
      if (liqSpike && oiDrop) agreeDrop++;
    }
  }

  report.coins[sym] = {
    coinalyzeSymbol: czSym,
    apiLiqBars: liveLiq.length,
    dbLiqBars: series.liquidations.length,
    dbLiqDailyBars: series.liquidationsDaily?.length ?? 0,
    dbOiBars: series.oi.length,
    sync,
    liqSpikeOiDropAgreementPct: n ? (agreeDrop / n) * 100 : null,
  };
  console.log(`DB stored: liq=${series.liquidations.length} oi=${series.oi.length}`);
  console.log(`Liq spike (>5M) + Bybit OI drop agreement: ${report.coins[sym].liqSpikeOiDropAgreementPct?.toFixed(1) ?? "—"}%`);
}

const OUT = path.join(__dirname, ".research-coinalyze-probe.json");
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`\nWrote ${OUT}`);
await closePool();
