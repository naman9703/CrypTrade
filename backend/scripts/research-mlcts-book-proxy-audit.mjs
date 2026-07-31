#!/usr/bin/env node
/**
 * Audit Vision bookDepth → imbalanceRatio proxy vs live top-20 volume formula.
 *
 * Live (orderBookCollector):  imb = sum(bid_qty top20) / (sum(bid_qty) + sum(ask_qty))
 * Vision (mlctsVisionIngest): imb = sum(bid_notional at pct<0) / (bid_notional + ask_notional)
 *   over ALL percentage bands in each snapshot (typically ±1..±5).
 *
 * Usage (backend/): node scripts/research-mlcts-book-proxy-audit.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import axios from "axios";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const SAMPLE_DAYS = Number(process.env.SAMPLE_DAYS || 3);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const {
  aggregateBookDepthImbalance,
  readBookImbalanceSeries,
} = await import("../src/backtest/data/mlctsVisionIngest.js");
const { downloadVisionZip, extractFirstEntryFromZip } = await import("../src/backtest/data/visionTickIngest.js");

function liveImbalanceFromDepth(bids, asks, levels = 20) {
  const b = (bids ?? []).slice(0, levels);
  const a = (asks ?? []).slice(0, levels);
  const bidTotal = b.reduce((s, [, q]) => s + Number(q), 0);
  const askTotal = a.reduce((s, [, q]) => s + Number(q), 0);
  const total = bidTotal + askTotal;
  return total > 0 ? bidTotal / total : 0.5;
}

function visionImbalanceNearBands(rows) {
  const byTs = new Map();
  for (const row of rows) {
    const ts = row.ts;
    const pct = Number(row.percentage);
    const notional = Number(row.notional);
    if (!Number.isFinite(ts) || !Number.isFinite(pct) || !Number.isFinite(notional)) continue;
    if (Math.abs(pct) > 2) continue;
    if (!byTs.has(ts)) byTs.set(ts, { bid: 0, ask: 0 });
    const g = byTs.get(ts);
    if (pct < 0) g.bid += notional;
    else if (pct > 0) g.ask += notional;
  }
  const out = [];
  for (const [ts, g] of byTs) {
    const total = g.bid + g.ask;
    out.push({ ts, imbalanceRatio: total > 0 ? g.bid / total : 0.5 });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function stats(arr) {
  if (!arr.length) return { n: 0, mean: null, std: null, p10: null, p50: null, p90: null };
  const s = [...arr].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const var_ = s.reduce((a, v) => a + (v - mean) ** 2, 0) / s.length;
  const q = (p) => s[Math.floor((s.length - 1) * p)];
  return {
    n: s.length,
    mean: +mean.toFixed(4),
    std: +Math.sqrt(var_).toFixed(4),
    p10: +q(0.1).toFixed(4),
    p50: +q(0.5).toFixed(4),
    p90: +q(0.9).toFixed(4),
  };
}

let liveNow = null;
try {
  const { data } = await axios.get("https://fapi.binance.com/fapi/v1/depth", {
    params: { symbol: SYMBOL, limit: 20 },
    timeout: 15_000,
  });
  liveNow = {
    ts: Date.now(),
    imbalanceRatio: liveImbalanceFromDepth(data.bids, data.asks, 20),
    bidLevels: data.bids?.length ?? 0,
    askLevels: data.asks?.length ?? 0,
  };
} catch (err) {
  liveNow = { error: String(err?.message || err) };
}

const fromMs = Date.parse("2026-01-01");
const toMs = Date.parse("2026-07-01");
const visionSeries = await readBookImbalanceSeries(SYMBOL, fromMs, toMs);
const visionImbs = visionSeries.map((r) => r.imbalanceRatio);

const sampleDays = ["2026-01-15", "2026-03-01", "2026-05-15"].slice(0, SAMPLE_DAYS);
const dayComparisons = [];
for (const day of sampleDays) {
  try {
    const url = `https://data.binance.vision/data/futures/um/daily/bookDepth/${SYMBOL}/${SYMBOL}-bookDepth-${day}.zip`;
    const zip = await downloadVisionZip(url);
    const csv = extractFirstEntryFromZip(zip);
    const text = csv.toString("utf8");
    const rawRows = [];
    for (const line of text.split("\n")) {
      if (!line || line.startsWith("timestamp")) continue;
      const p = line.split(",");
      if (p.length < 4) continue;
      rawRows.push({
        timestamp: p[0],
        percentage: Number(p[1]),
        notional: Number(p[3]),
      });
    }
    const full = aggregateBookDepthImbalance(
      rawRows.map((r) => ({ ts: r.timestamp, percentage: r.percentage, notional: r.notional })),
    );
    const near = visionImbalanceNearBands(
      rawRows.map((r) => ({
        ts: Date.parse(r.timestamp.replace(" ", "T") + "Z"),
        percentage: r.percentage,
        notional: r.notional,
      })),
    );
    dayComparisons.push({
      day,
      snapshots: full.length,
      fullBand: stats(full.map((r) => r.imbalanceRatio)),
      nearBandPm2: stats(near.map((r) => r.imbalanceRatio)),
      meanDeltaFullVsNear:
        full.length && near.length
          ? +(
              full.reduce((a, r) => a + r.imbalanceRatio, 0) / full.length -
              near.reduce((a, r) => a + r.imbalanceRatio, 0) / near.length
            ).toFixed(4)
          : null,
    });
  } catch (err) {
    dayComparisons.push({ day, error: String(err?.message || err).slice(0, 120) });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  formulas: {
    live:
      "imbalanceRatio = sum(top20 bid qty) / (sum(top20 bid qty) + sum(top20 ask qty))",
    visionFullBands:
      "imbalanceRatio = sum(notional where percentage<0) / (bid_notional + ask_notional) over all bands",
    visionNearBands:
      "same but |percentage|<=2 only — sensitivity variant, NOT used in production ingest",
  },
  liveSnapshotNow: liveNow,
  visionDbWindow: {
    from: "2026-01-01",
    to: "2026-07-01",
    snapshots: visionImbs.length,
    distribution: stats(visionImbs),
  },
  sampleDayComparisons: dayComparisons,
  validityNotes: [
    "Live uses top-20 level QTY; Vision uses NOTIONAL summed across % bands.",
    "Vision includes deeper bands which can bias imbalance vs touch-only live metric.",
    "Contemporaneous live-vs-vision correlation is not yet established from this audit alone.",
    "Production ingest uses visionFullBands.",
  ],
};

const outPath = path.join(__dirname, ".mlcts-book-proxy-audit.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ outPath, report }, null, 2));
await closePool?.().catch(() => {});
