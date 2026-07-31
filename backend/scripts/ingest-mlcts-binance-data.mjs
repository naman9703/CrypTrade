#!/usr/bin/env node
/**
 * Ingest Binance Vision metrics + bookDepth for MLCTS backtests.
 *
 * Usage (backend/):
 *   SYMBOLS=BTCUSDT FROM=2025-12-25 TO=2026-07-01 node scripts/ingest-mlcts-binance-data.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT").split(",").map((s) => s.trim());
const FROM = process.env.FROM || "2025-12-25";
const TO = process.env.TO || "2026-07-01";
const FORCE = process.env.FORCE === "1";

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureMlctsVisionData } = await import("../src/backtest/data/mlctsVisionIngest.js");
const { ensureFunding } = await import("../src/backtest/data/fundingIngest.js");
const { ensureKlines } = await import("../src/backtest/data/klineIngest.js");

const report = { generatedAt: new Date().toISOString(), from: FROM, to: TO, symbols: {} };

for (const symbol of SYMBOLS) {
  console.error(`\n=== ${symbol} MLCTS ingest ${FROM} → ${TO} ===`);
  await ensureKlines(symbol, "15m", { from: fromMs, to: toMs, market: "futures" }).catch((e) => {
    console.warn(`  klines warn: ${e?.message || e}`);
  });
  await ensureFunding(symbol, { from: fromMs, to: toMs }).catch((e) => {
    console.warn(`  funding warn: ${e?.message || e}`);
  });

  let lastDay = "";
  const vision = await ensureMlctsVisionData(symbol, fromMs, toMs, {
    force: FORCE,
    onProgress: ({ phase, day, i, n }) => {
      if (day !== lastDay) {
        lastDay = day;
        console.error(`  ${phase} ${day} (${i + 1}/${n})`);
      }
    },
  });
  report.symbols[symbol] = vision;
  console.error(
    `  done metrics cached=${vision.metrics.cached} book cached=${vision.book.cached}`,
  );
}

const outPath = path.join(__dirname, ".mlcts-vision-ingest-report.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outPath, report }, null, 2));
await closePool?.().catch(() => {});
