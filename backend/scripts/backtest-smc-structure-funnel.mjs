#!/usr/bin/env node
/**
 * SMC structure funnel — confirmed swings, BOS, CHoCH counts (no entries).
 * Usage: node scripts/backtest-smc-structure-funnel.mjs [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = "BNBUSDT";
const tf = "15m";
const fromMs = Date.parse(process.argv[2] || "2026-01-01");
const toMs = Date.parse(process.argv[3] || "2026-05-27");
const WARMUP = 80;

const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { getConfirmedSwings } = await import("../src/strategy/techniques/marketStructure.js");
const { getTrendStructureAt } = await import("../src/strategy/techniques/trendStructure.js");
const { detectMarketBos, detectMarketChoch } = await import("../src/strategy/techniques/bosChoch.js");

const opts = {
  intradaySmcSwingLeft: 2,
  intradaySmcSwingRight: 2,
  intradaySmcSwingConfirmBars: 2,
  intradaySmcChochRequireTrend: false,
};

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
await closePool();

if (!candles.length) {
  console.error("No candles — sync klines first.");
  process.exit(1);
}

const counts = {
  bars: 0,
  swingHighs: 0,
  swingLows: 0,
  bullishBos: 0,
  bearishBos: 0,
  bullishChoch: 0,
  bearishChoch: 0,
  bullishTrend: 0,
  bearishTrend: 0,
};

for (let i = WARMUP; i < candles.length; i++) {
  if (candles[i].ts < fromMs || candles[i].ts > toMs) continue;
  counts.bars++;
  const sw = getConfirmedSwings(candles, i, opts);
  counts.swingHighs += sw.highs.filter((h) => h.confirmedAt === i).length;
  counts.swingLows += sw.lows.filter((l) => l.confirmedAt === i).length;

  const trend = getTrendStructureAt(candles, i, opts);
  if (trend.state === "BULLISH") counts.bullishTrend++;
  if (trend.state === "BEARISH") counts.bearishTrend++;

  const bosBuy = detectMarketBos(candles, i, "BUY", opts);
  const bosSell = detectMarketBos(candles, i, "SELL", opts);
  if (bosBuy.ok) counts.bullishBos++;
  if (bosSell.ok) counts.bearishBos++;

  const chochBuy = detectMarketChoch(candles, i, "BUY", opts);
  const chochSell = detectMarketChoch(candles, i, "SELL", opts);
  if (chochBuy.ok) counts.bullishChoch++;
  if (chochSell.ok) counts.bearishChoch++;
}

console.log(JSON.stringify({ symbol, tf, fromMs, toMs, counts }, null, 2));
