#!/usr/bin/env node
/**
 * Backfill `taker_buy_volume` (aggressor buy volume) from Binance futures klines.
 * This is the basis for REAL order flow (taker buy vs sell = aggressor imbalance);
 * without it the order-flow techniques silently fall back to a weak OHLC proxy.
 *
 * Usage:
 *   SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT TF=15m FROM=2025-01-01 node scripts/backfill-taker-volume.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim()).filter(Boolean);
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || new Date().toISOString().slice(0, 10);
const MARKET = process.env.MARKET || "futures";

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { fetchBinanceKlinesRange } = await import("../src/lib/binanceKlinesRest.js");
const { tfToMs, binanceInterval } = await import("../src/backtest/data/timeframe.js");

const pool = getPool();
const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();
const feedKind = MARKET === "spot" ? "BINANCE" : "BINANCE_FUTURES";
const interval = binanceInterval(TF);
const step = tfToMs(TF);

async function upsertTaker(client, sym, rows) {
  let n = 0;
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    const values = [];
    const params = [];
    let p = 1;
    for (const c of chunk) {
      values.push(`($${p++}, $${p++}, to_timestamp($${p++} / 1000.0), $${p++})`);
      params.push(sym, TF, c.ts, c.taker_buy_volume ?? null);
    }
    // Only touch taker_buy_volume; never clobber existing OHLC.
    const sql = `
      UPDATE ohlcv_candles AS o
      SET taker_buy_volume = v.tbv::float8
      FROM (VALUES ${values.join(", ")}) AS v(symbol, timeframe, open_time, tbv)
      WHERE o.symbol = v.symbol AND o.timeframe = v.timeframe::text AND o.open_time = v.open_time
    `;
    const res = await client.query(sql, params);
    n += res.rowCount || 0;
  }
  return n;
}

console.log(`\n=== Backfill taker_buy_volume — ${SYMBOLS.join(", ")} ${TF} ${FROM}->${TO} (${MARKET}) ===\n`);

// Dedicated client: lift the Timescale per-DML decompression cap (the hypertable
// is compressed, so updating historical chunks decompresses many tuples).
const client = await pool.connect();
await client.query("SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0");

for (const sym of SYMBOLS) {
  const t0 = Date.now();
  process.stdout.write(`${sym} ${TF}: fetching...`);
  const fetched = await fetchBinanceKlinesRange({
    symbol: sym,
    interval,
    startTime: fromMs,
    endTime: toMs,
    maxRows: 600_000,
    feedKind,
  });
  const withTaker = fetched.filter((r) => Number.isFinite(r.taker_buy_volume) && r.taker_buy_volume > 0);
  const updated = await upsertTaker(client, sym, fetched);
  console.log(
    `\r${sym} ${TF}: fetched=${fetched.length} (taker>0: ${withTaker.length}) updated_rows=${updated} in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
  );
}
client.release();

// Verify coverage.
console.log(`\nCoverage after backfill:`);
for (const sym of SYMBOLS) {
  const r = await pool.query(
    `select count(*) n, count(*) filter (where taker_buy_volume > 0) tbv from ohlcv_candles where symbol=$1 and timeframe=$2`,
    [sym, TF],
  );
  const row = r.rows[0];
  console.log(`  ${sym} ${TF}: ${row.tbv}/${row.n} rows have taker volume (${((row.tbv / Math.max(1, row.n)) * 100).toFixed(1)}%)`);
}

await closePool?.();
