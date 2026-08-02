#!/usr/bin/env node
/**
 * MICRO_EVENT tick-replay harvest — evaluate force_order ticks with confluence features.
 *
 * v1: replays DB force_orders + 1m liq bar proxy (bar-close fallback path).
 * Full sub-minute CVD/book replay requires vision tick ingest (document limitation).
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-micro-event-tick-replay.mjs
 *   DAYS=7 SYMBOLS=BTCUSDT,ETHUSDT node scripts/research-micro-event-tick-replay.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const DAYS = Number(process.env.DAYS || 7);
const TF = process.env.TF || "1m";
const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim());
const OUT =
  process.env.OUT ||
  path.join(__dirname, `.micro-event-tick-replay-${DAYS}d.csv`);

const toMs = Date.now();
const fromMs = toMs - DAYS * 24 * 60 * 60 * 1000;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readRecentForceOrders } = await import("../src/intelligence/collectors/forceOrderPersist.js");
const { aggregateTicksToLiqSeries } = await import("../src/strategy/liqCascadeIntraday.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { evaluateMicroEventFromSnapshot, optsFromMicroEventCfg } = await import(
  "../src/strategy/techniques/microEvent.js"
);
const { MICRO_EVENT_BTC_1M } = await import("../src/strategy/presets/microEventOptimized.js");

function csvEscape(v) {
  if (v == null || v === "") return "";
  const s = String(v);
  return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
}

function domFromBar(bar, domRatio = 1.2) {
  const longUsd = Number(bar.liqLongUsd ?? 0);
  const shortUsd = Number(bar.liqShortUsd ?? 0);
  if (longUsd > shortUsd * domRatio) return "longs";
  if (shortUsd > longUsd * domRatio) return "shorts";
  return "neutral";
}

const headers = [
  "symbol",
  "ts",
  "iso",
  "liqTotalUsd",
  "liqDom",
  "liqZLike",
  "action",
  "score",
  "failedGate",
  "layers",
  "hits",
  "price",
];

const rows = [headers.join(",")];
let passCount = 0;
let skipCount = 0;

for (const symbol of SYMBOLS) {
  const cfg = { ...MICRO_EVENT_BTC_1M, symbol };
  const opts = optsFromMicroEventCfg(cfg);
  const padFrom = fromMs - 2 * 60 * 60_000;
  await ensureKlines(symbol, TF, { from: padFrom, to: toMs, market: "futures" }).catch(() => {});
  const candles = await readCandles(symbol, TF, padFrom, toMs, { market: "futures" });
  const ticks = await readRecentForceOrders(symbol, fromMs, toMs);
  const liqSeries = aggregateTicksToLiqSeries(ticks, 60_000, fromMs, toMs);

  for (const bar of liqSeries) {
    const ts = Number(bar.ts);
    if (!(ts >= fromMs)) continue;
    const totalUsd = Number(bar.liqLongUsd ?? 0) + Number(bar.liqShortUsd ?? 0);
    const dom = domFromBar(bar, opts.liqDomRatio);
    const zLike = totalUsd / Math.max(opts.liqMinUsd, 1);
    const idx = candles.findIndex((c) => Number(c.ts) === ts);
    const price = idx >= 0 ? Number(candles[idx]?.close ?? 0) : 0;

    const snapshot = {
      symbol,
      tsMs: ts,
      liqLongUsd: Number(bar.liqLongUsd ?? 0),
      liqShortUsd: Number(bar.liqShortUsd ?? 0),
      liqTotalUsd: totalUsd,
      liqDom: dom,
      liqZLike: zLike,
      oiDeltaPct1m: null,
      oiDeltaPct5m: null,
      bookImbalance: null,
      bidWallUsd: null,
      askWallUsd: null,
      aggressiveBuyUsd60s: 0,
      aggressiveSellUsd60s: 0,
      cvdSlope60s: 0,
      fundingZ: null,
      crowdedSide: "neutral",
      calendarActive: false,
      calendarEvents: [],
      lastPrice: price,
    };

    const ev = evaluateMicroEventFromSnapshot(snapshot, cfg, price);
    if (ev.action) passCount += 1;
    else skipCount += 1;

    const layers = ev.audit?.layers ?? {};
    const layerStr = Object.entries(layers)
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join("+");
    const hitStr = (ev.hits ?? ev.audit?.hits ?? []).map((h) => h.type).join("+");

    rows.push(
      [
        symbol,
        ts,
        new Date(ts).toISOString(),
        totalUsd.toFixed(0),
        dom,
        zLike.toFixed(2),
        ev.action ?? "",
        ev.confluenceScore ?? ev.audit?.score ?? 0,
        ev.audit?.failedGate ?? "",
        layerStr,
        hitStr,
        price > 0 ? price.toFixed(2) : "",
      ]
        .map(csvEscape)
        .join(","),
    );
  }

  console.log(`${symbol}: ${ticks.length} force ticks → ${liqSeries.length} 1m liq bars`);
}

fs.writeFileSync(OUT, rows.join("\n") + "\n");
console.log(`\nWrote ${rows.length - 1} rows → ${OUT}`);
console.log(`Pass=${passCount} Skip=${skipCount} (bar-close proxy — OI/book/CVD null in replay)`);

await closePool?.().catch(() => {});
