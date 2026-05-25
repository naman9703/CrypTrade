#!/usr/bin/env node
/**
 * CLI: backfill historical data for backtests.
 *   npm --workspace backend run backtest:sync -- --symbol BTCUSDT --tf 15m --from 2023-01-01
 *
 * Pulls klines, funding rates (futures), open interest (futures), and the
 * Fear & Greed history (global) into the simulator's `historical_*` tables.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const { initPool, closePool } = await import("../src/db/pool.js");
const { ensureKlines } = await import("../src/backtest/data/klineIngest.js");
const { ensureFunding } = await import("../src/backtest/data/fundingIngest.js");
const { ensureOpenInterest } = await import("../src/backtest/data/openInterestIngest.js");
const { ensureFearGreed } = await import("../src/backtest/data/fearGreedIngest.js");
const { getCoverage } = await import("../src/backtest/data/dataCoverage.js");

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const symbol = String(arg("symbol", "BTCUSDT")).toUpperCase();
const tf = String(arg("tf", "15m"));
const from = arg("from", "");
const to = arg("to", "");
const market = String(arg("market", "futures")).toLowerCase() === "spot" ? "spot" : "futures";
const fromMs = from ? Date.parse(from) : Date.now() - 365 * 24 * 60 * 60 * 1000;
const toMs = to ? Date.parse(to) : Date.now();
if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
  console.error(`invalid range from=${from} to=${to}`);
  process.exit(1);
}

await initPool({ info: () => {}, warn: () => {}, error: console.error });

try {
  console.log(`syncing ${symbol} ${tf} ${market} ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}`);
  const k = await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market });
  console.log(`  klines: inserted=${k.inserted} gaps_filled=${k.gaps}`);
  if (market === "futures") {
    const f = await ensureFunding(symbol, { from: fromMs, to: toMs });
    console.log(`  funding: inserted=${f.inserted}`);
    const oi = await ensureOpenInterest(symbol, { from: fromMs, to: toMs, period: "1h" });
    console.log(`  open_interest: inserted=${oi.inserted}`);
  }
  const fng = await ensureFearGreed({ limit: 0 });
  console.log(`  fear_greed: inserted=${fng.inserted}`);
  const cov = await getCoverage(symbol, tf, { from: fromMs, to: toMs });
  console.log(
    `  coverage: have=${cov.have}/${cov.expected} (${cov.coveragePct != null ? cov.coveragePct.toFixed(2) : "?"}%)`,
  );
} finally {
  await closePool();
}
