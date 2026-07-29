#!/usr/bin/env node
/**
 * Ingest Coinalyze 1min/5min liquidations + OI for LIQ_CASCADE backtests.
 * Probes interval history depth per symbol.
 *
 * Usage (backend/): SKIP_ENSURE=1 node scripts/ingest-liq-cascade-data.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim());
const FROM = process.env.FROM || "2024-01-01";
const TO = process.env.TO || "2026-06-01";
const INTERVALS = (process.env.INTERVALS || "5min,1min,1hour").split(",").map((s) => s.trim());

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines } = await import("../src/backtest/data/klineIngest.js");
const {
  ensureCoinalyzeLiquidations,
  ensureCoinalyzeOi,
  fetchCoinalyzeLiquidationHist,
  resolveCoinalyzePerpSymbol,
} = await import("../src/backtest/data/coinalyzeIngest.js");

async function probeInterval(symbol, interval) {
  const cz = await resolveCoinalyzePerpSymbol(symbol);
  if (!cz) return { interval, error: "no_coinalyze_symbol" };
  try {
    const hist = await fetchCoinalyzeLiquidationHist(cz, interval, fromMs, toMs);
    const first = hist[0]?.ts ?? null;
    const last = hist[hist.length - 1]?.ts ?? null;
    return { interval, rows: hist.length, firstTs: first, lastTs: last, coinalyzeSymbol: cz };
  } catch (err) {
    return { interval, error: String(err?.message || err) };
  }
}

console.log(`\n=== LIQ_CASCADE data ingest ${FROM} → ${TO} ===\n`);
const report = { generatedAt: new Date().toISOString(), symbols: {} };

for (const symbol of SYMBOLS) {
  console.log(`\n--- ${symbol} ---`);
  report.symbols[symbol] = { probes: [], ingest: {} };

  for (const interval of INTERVALS) {
    const probe = await probeInterval(symbol, interval);
    report.symbols[symbol].probes.push(probe);
    console.log(
      `  probe ${interval}: ${probe.error ? probe.error : `rows=${probe.rows} ${probe.firstTs ? new Date(probe.firstTs).toISOString().slice(0, 10) : "?"} → ${probe.lastTs ? new Date(probe.lastTs).toISOString().slice(0, 10) : "?"}`}`,
    );
  }

  const useInterval =
    report.symbols[symbol].probes.find((p) => p.interval === "5min" && (p.rows ?? 0) > 100)?.interval ||
    report.symbols[symbol].probes.find((p) => p.interval === "1min" && (p.rows ?? 0) > 100)?.interval ||
    "1hour";

  console.log(`  ingesting interval=${useInterval}`);
  report.symbols[symbol].useInterval = useInterval;

  const liq = await ensureCoinalyzeLiquidations(symbol, { from: fromMs, to: toMs, interval: useInterval });
  const oi = await ensureCoinalyzeOi(symbol, { from: fromMs, to: toMs, interval: useInterval });
  report.symbols[symbol].ingest = { liquidations: liq, oi };

  await ensureKlines(symbol, "1m", { from: fromMs, to: toMs, market: "futures" }).catch((e) => {
    console.warn(`  klines 1m warn: ${e?.message || e}`);
  });
  console.log(`  liq inserted=${liq.inserted ?? 0} oi inserted=${oi.inserted ?? 0}`);
}

const out = path.join(__dirname, ".liq-cascade-ingest-report.json");
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nWrote ${out}`);
await closePool?.();
