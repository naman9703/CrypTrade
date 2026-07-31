#!/usr/bin/env node
/**
 * Collect live top-20 depth imbalance for MLCTS book proxy validation.
 * Logs one sample every SAMPLE_MS (default 30s — matches ~Vision snapshot cadence).
 *
 * Usage (backend/):
 *   SYMBOL=BTCUSDT SAMPLE_MS=30000 DURATION_HOURS=168 node scripts/collect-live-book-snapshots.mjs
 *
 * Output: scripts/.live-book-snapshots-<symbol>.jsonl
 * After collection, run: node scripts/research-mlcts-live-vision-correlation.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SYMBOL = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const SAMPLE_MS = Number(process.env.SAMPLE_MS || 30_000);
const DURATION_HOURS = Number(process.env.DURATION_HOURS || 168);
const FAPI = process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com";

const outPath = path.join(__dirname, `.live-book-snapshots-${SYMBOL}.jsonl`);

function liveImbalance(bids, asks) {
  const b = (bids ?? []).slice(0, 20);
  const a = (asks ?? []).slice(0, 20);
  const bidTotal = b.reduce((s, [, q]) => s + Number(q), 0);
  const askTotal = a.reduce((s, [, q]) => s + Number(q), 0);
  const total = bidTotal + askTotal;
  return total > 0 ? bidTotal / total : 0.5;
}

async function sampleOnce() {
  const { data } = await axios.get(`${FAPI}/fapi/v1/depth`, {
    params: { symbol: SYMBOL, limit: 20 },
    timeout: 10_000,
  });
  const row = {
    ts: Date.now(),
    symbol: SYMBOL,
    imbalanceRatio: liveImbalance(data.bids, data.asks),
    bidQty: (data.bids ?? []).slice(0, 20).reduce((s, [, q]) => s + Number(q), 0),
    askQty: (data.asks ?? []).slice(0, 20).reduce((s, [, q]) => s + Number(q), 0),
    source: "live_rest_depth20",
  };
  fs.appendFileSync(outPath, JSON.stringify(row) + "\n");
  return row;
}

const endAt = Date.now() + DURATION_HOURS * 3600_000;
console.error(`Collecting ${SYMBOL} live book every ${SAMPLE_MS}ms for ${DURATION_HOURS}h → ${outPath}`);

while (Date.now() < endAt) {
  try {
    const row = await sampleOnce();
    console.error(new Date(row.ts).toISOString(), "imb", row.imbalanceRatio.toFixed(4));
  } catch (err) {
    console.error("sample error:", err?.message || err);
  }
  await new Promise((r) => setTimeout(r, SAMPLE_MS));
}

console.error("done");
