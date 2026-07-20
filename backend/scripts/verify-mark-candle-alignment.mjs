#!/usr/bin/env node
/** Verify 1m mark OHLC aggregates match trade 5m/15m/1h candles on sample windows. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = process.argv[2] || "BTCUSDT";
const fromIso = process.argv[3] || "2025-06-29T09:00:00.000Z";
const toIso = process.argv[4] || "2025-06-29T11:00:00.000Z";
const fromMs = new Date(fromIso).getTime();
const toMs = new Date(toIso).getTime();

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readMicroTrailBars } = await import("../src/backtest/data/markPriceIngest.js");

function aggFrom1m(bars, bucketMs) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const bucket = Math.floor(b.ts / bucketMs) * bucketMs;
    if (!cur || cur.ts !== bucket) {
      if (cur) out.push(cur);
      cur = { ts: bucket, open: b.open, high: b.high, low: b.low, close: b.close };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function compare(tf, tradeBars, mark1m) {
  const bucketMs =
    tf === "5m" ? 300_000 : tf === "15m" ? 900_000 : tf === "1h" ? 3_600_000 : 60_000;
  const fromMark = aggFrom1m(mark1m, bucketMs);
  const mism = [];
  for (const tb of tradeBars) {
    const mb = fromMark.find((b) => b.ts === tb.ts);
    if (!mb) {
      mism.push({ ts: tb.ts, issue: "missing_mark_agg" });
      continue;
    }
    const tol = tb.close * 0.0001;
    if (Math.abs(mb.close - tb.close) > tol || Math.abs(mb.high - tb.high) > tol || Math.abs(mb.low - tb.low) > tol) {
      mism.push({
        ts: tb.ts,
        trade: { o: tb.open, h: tb.high, l: tb.low, c: tb.close },
        markAgg: { o: mb.open, h: mb.high, l: mb.low, c: mb.close },
      });
    }
  }
  return mism;
}

const mark1m = await readMicroTrailBars(symbol, fromMs, toMs, { priceSource: "mark" });
const report = {};
for (const tf of ["5m", "15m", "1h"]) {
  const trade = await readCandles(symbol, tf, fromMs, toMs);
  report[tf] = {
    tradeBars: trade.length,
    mark1mBars: mark1m.length,
    mismatches: compare(tf, trade, mark1m).slice(0, 5),
    mismatchCount: compare(tf, trade, mark1m).length,
  };
}

console.log(JSON.stringify({ symbol, from: fromIso, to: toIso, report }, null, 2));
await closePool();
process.exit(Object.values(report).some((r) => r.mismatchCount > 0) ? 1 : 0);
