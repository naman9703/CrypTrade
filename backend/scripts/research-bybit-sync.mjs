#!/usr/bin/env node
/**
 * Sync Bybit positioning data (OI + account ratio) for research window.
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
const OI_INTERVAL = argValue("--oi-interval", "15min");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureBybitPositioning, loadBybitSeries } = await import("../src/backtest/data/bybitMarketIngest.js");

const report = { generatedAt: new Date().toISOString(), from: FROM, to: TO, source: "bybit", coins: {} };

for (const symbol of COINS) {
  process.stdout.write(`Bybit sync ${symbol} ${OI_INTERVAL}...\n`);
  const ensured = await ensureBybitPositioning(symbol, fromMs, toMs, {
    oiIntervalTime: OI_INTERVAL,
    lsrPeriod: "1h",
    onPage: ({ page, total }) => {
      if (page % 25 === 0) process.stdout.write(`  ${symbol} page ${page} (${total} pts)\n`);
    },
  });
  const series = await loadBybitSeries(symbol, fromMs, toMs, { oiIntervalTime: OI_INTERVAL });
  report.coins[symbol] = {
    ensured,
    oiPoints: series.oi.length,
    lsrPoints: series.lsr.length,
    fidelity: "cross_venue_proxy",
  };
  console.log(`  oi=${series.oi.length} lsr=${series.lsr.length}`);
}

console.log(JSON.stringify(report, null, 2));
await closePool();
