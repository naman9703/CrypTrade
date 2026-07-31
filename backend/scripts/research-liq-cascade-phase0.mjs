#!/usr/bin/env node
/**
 * LIQ_CASCADE Phase 0 — cascade event harvest + fade vs continuation forward returns.
 *
 * Causal: events are counted once per COMPLETED liq bar (bar-close availability),
 * forward returns start at the first candle at/after bar close, and frequency is
 * computed over the actual liq data coverage span (not the requested window).
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-cascade-phase0.mjs
 *   LIQ_SOURCE=force_orders FROM=2026-05-01 TO=2026-07-29 LIQ_INTERVAL=1min node scripts/research-liq-cascade-phase0.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOLS = (process.env.SYMBOLS || "BTCUSDT,ETHUSDT,BNBUSDT").split(",").map((s) => s.trim());
const FROM = process.env.FROM || "2024-06-01";
const TO = process.env.TO || "2026-06-01";
const TF = process.env.TF || "1m";
const HORIZONS = [5, 15, 60];

const LIQ_Z = Number(process.env.LIQ_Z || 1.8);
const MIN_LIQ_USD = Number(process.env.MIN_LIQ_USD || 30_000);
const MIN_OI_DROP = Number(process.env.MIN_OI_DROP || 0.12);
const OI_GATE_MODE = process.env.OI_GATE_MODE || "window";
const OI_WINDOW_BARS = Number(process.env.OI_WINDOW_BARS || 3);
const LIQ_SOURCE = process.env.LIQ_SOURCE || "coinalyze";

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { prepareLiqBars, prepareOiBars, lookupAtOrBefore, liqIntervalToMs, resolveOiGate } = await import(
  "../src/strategy/techniques/liqCascade.js"
);
const { loadLiqCascadeMarketSeries, liqCascadePadFromMs } = await import(
  "../src/strategy/liqCascadeIntraday.js"
);

function candleIdxAtOrAfter(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(candles[mid].ts) >= ts) {
      best = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return best;
}

function forwardRet(candles, idx, horizon) {
  const j = idx + horizon;
  if (idx == null || j >= candles.length) return null;
  const c0 = Number(candles[idx].close);
  const c1 = Number(candles[j].close);
  if (!(c0 > 0)) return null;
  return ((c1 - c0) / c0) * 100;
}

async function harvestSymbol(symbol) {
  const padFrom = liqCascadePadFromMs(fromMs, TF);
  const candles = await readCandles(symbol, TF, padFrom, toMs, { market: "futures" });
  const { liqSeries, oiSeries, interval, source, tickCount } = await loadLiqCascadeMarketSeries(
    symbol,
    padFrom,
    toMs,
    {
      liqCascadeInterval: process.env.LIQ_INTERVAL || "5min",
      liqCascadeLiqSource: LIQ_SOURCE,
    },
  );
  const intervalMs = liqIntervalToMs(interval);
  const liqBars = prepareLiqBars(liqSeries, { intervalMs, lookbackBars: 48 });
  const oiBars = prepareOiBars(oiSeries, intervalMs);

  const events = [];
  for (const bar of liqBars) {
    if (bar.ts < fromMs || bar.ts >= toMs) continue;
    if (bar.z == null || bar.z < LIQ_Z) continue;
    if (bar.totalUsd < MIN_LIQ_USD) continue;
    if (bar.dom !== "longs" && bar.dom !== "shorts") continue;
    const oiGate = resolveOiGate(oiBars, bar.ts, {
      oiGateMode: OI_GATE_MODE,
      oiWindowBars: OI_WINDOW_BARS,
      minOiDropPct: MIN_OI_DROP,
    });
    const oiDrop = oiGate.dropPct;
    const idx = candleIdxAtOrAfter(candles, bar.ts); // first candle after bar closes
    const ev = {
      ts: bar.ts,
      dom: bar.dom,
      z: +bar.z.toFixed(2),
      liqUsd: Math.round(bar.totalUsd),
      oiDrop: oiDrop != null ? +oiDrop.toFixed(3) : null,
      oiGateMode: oiGate.mode,
      oiPass: oiGate.ok,
      fadeRet: {},
      contRet: {},
    };
    for (const h of HORIZONS) {
      const r = forwardRet(candles, idx, h);
      if (r == null) continue;
      ev.fadeRet[h] = ev.dom === "longs" ? r : -r;
      ev.contRet[h] = ev.dom === "longs" ? -r : r;
    }
    events.push(ev);
  }

  // Frequency over actual liq data coverage, not the requested window.
  const covFrom = liqBars.length ? Math.max(liqBars[0].ts, fromMs) : fromMs;
  const covTo = liqBars.length ? Math.min(liqBars[liqBars.length - 1].ts, toMs) : toMs;
  const weeks = Math.max((covTo - covFrom) / (7 * 864e5), 1e-9);

  const mean = (arr, key, h) => {
    const vals = arr.map((e) => e[key][h]).filter((x) => x != null && Number.isFinite(x));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const oiPassEvents = events.filter((e) => e.oiPass);

  return {
    symbol,
    interval,
    liqSource: source ?? LIQ_SOURCE,
    tickCount: tickCount ?? null,
    candleBars: candles.length,
    liqBars: liqSeries.length,
    coverage: { from: new Date(covFrom).toISOString(), to: new Date(covTo).toISOString(), weeks: +weeks.toFixed(2) },
    events: events.length,
    eventsPerWeek: +(events.length / weeks).toFixed(2),
    eventsOiPass: oiPassEvents.length,
    fadeMeanR15: mean(events, "fadeRet", 15),
    contMeanR15: mean(events, "contRet", 15),
    fadeMeanR60: mean(events, "fadeRet", 60),
    contMeanR60: mean(events, "contRet", 60),
    fadeMeanR15OiPass: mean(oiPassEvents, "fadeRet", 15),
    contMeanR15OiPass: mean(oiPassEvents, "contRet", 15),
    sample: events.slice(0, 5),
  };
}

console.log(`\n=== LIQ_CASCADE Phase 0 (causal) ${FROM} → ${TO} ${TF} z>=${LIQ_Z} source=${LIQ_SOURCE} ===\n`);
const results = [];
for (const symbol of SYMBOLS) {
  const row = await harvestSymbol(symbol);
  results.push(row);
  console.log(
    `${symbol.padEnd(8)} events=${String(row.events).padStart(4)} (${row.eventsPerWeek}/wk over ${row.coverage.weeks}wk) oiPass=${row.eventsOiPass} fade15=${row.fadeMeanR15?.toFixed(3) ?? "n/a"} cont15=${row.contMeanR15?.toFixed(3) ?? "n/a"} fade60=${row.fadeMeanR60?.toFixed(3) ?? "n/a"} cont60=${row.contMeanR60?.toFixed(3) ?? "n/a"}`,
  );
}

const totalEvents = results.reduce((a, r) => a + r.events, 0);
const avgTw = results.length ? results.reduce((a, r) => a + r.eventsPerWeek, 0) / results.length : 0;
const verdict =
  totalEvents >= 30 && avgTw >= 2
    ? "PROCEED_FULL_SIM"
    : totalEvents >= 10
      ? "PROCEED_THIN_N"
      : "REJECT_INSUFFICIENT_EVENTS";

console.log(`\nTotal events=${totalEvents} avg=${avgTw.toFixed(2)}/wk/symbol → ${verdict}`);

fs.writeFileSync(
  path.join(__dirname, ".liq-cascade-phase0.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), params: { LIQ_Z, MIN_LIQ_USD, MIN_OI_DROP, LIQ_SOURCE }, results, totalEvents, avgTw, verdict }, null, 2),
);
await closePool?.();
