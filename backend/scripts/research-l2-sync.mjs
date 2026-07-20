#!/usr/bin/env node
/**
 * Sync L2 data (funding + OI) from Binance Futures for research window.
 *
 * Usage: cd backend && node scripts/research-l2-sync.mjs
 *        cd backend && node scripts/research-l2-sync.mjs --coins BTCUSDT,ETHUSDT
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const FROM = argValue("--from", "2022-01-01");
const TO = argValue("--to", "2026-06-01");
const COINS = argValue("--coins", "BTCUSDT,BNBUSDT,ETHUSDT,SOLUSDT,XRPUSDT")
  .split(",")
  .map((s) => s.trim());

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureL2Data, loadL2Series, l2CoverageSummary } = await import("../src/backtest/data/l2Features.js");

const report = { generatedAt: new Date().toISOString(), from: FROM, to: TO, coins: {} };

for (const symbol of COINS) {
  process.stdout.write(`L2 sync ${symbol}...\n`);
  const ensured = await ensureL2Data(symbol, fromMs, toMs);
  const series = await loadL2Series(symbol, fromMs, toMs);
  const cov = l2CoverageSummary(series, fromMs, toMs);
  report.coins[symbol] = { ensured, coverage: cov };
  console.log(`  funding=${cov.fundingPoints} oi=${cov.oiPoints} pts`);
}

console.log(JSON.stringify(report, null, 2));
await closePool();
