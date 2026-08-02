#!/usr/bin/env node
/**
 * Compare Binance OI ingest vs Coinalyze OI at aligned timestamps.
 * Verifies whether Coinalyze data (used by LIQ_CASCADE backtests) matches exchange truth.
 *
 * Usage (backend/):
 *   node scripts/compare-oi-coinalyze-vs-binance.mjs
 *   SYMBOL=ETHUSDT PERIOD=1h node scripts/compare-oi-coinalyze-vs-binance.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = String(process.env.SYMBOL || "BTCUSDT").toUpperCase();
const PERIOD = String(process.env.PERIOD || "1h"); // Binance period + Coinalyze interval for compare
const PERIOD_MS =
  PERIOD === "5m"
    ? 300_000
    : PERIOD === "15m"
      ? 900_000
      : PERIOD === "30m"
        ? 1_800_000
      : PERIOD === "1hour" || PERIOD === "1h"
        ? 3_600_000
        : 3_600_000;
const CZ_INTERVAL =
  PERIOD === "1h" || PERIOD === "1hour"
    ? "1hour"
    : PERIOD === "5m"
      ? "5min"
      : PERIOD === "15m"
        ? "15min"
        : PERIOD === "30m"
          ? "30min"
          : PERIOD;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureOpenInterest, readOpenInterest, OI_API_RETENTION_MS } = await import(
  "../src/backtest/data/openInterestIngest.js",
);
const {
  ensureCoinalyzeOi,
  readCoinalyzeOi,
  resolveCoinalyzePerpSymbol,
  fetchCoinalyzeOiHist,
} = await import("../src/backtest/data/coinalyzeIngest.js");
const axios = (await import("axios")).default;

const FAPI = process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com";
const now = Date.now();
const fromMs = now - Math.min(OI_API_RETENTION_MS - 3600_000, 14 * 86400_000); // last ~14d within Binance 30d cap
const toMs = now;

/** Direct Binance fetch for arbitrary period (ingest helper defaults to rolling 30d 1h). */
async function fetchBinanceOiPeriod(symbol, period, winFrom, winTo) {
  const out = [];
  let end = winTo;
  let guard = 0;
  while (end > winFrom && guard < 120) {
    guard += 1;
    const { data } = await axios.get(`${FAPI}/futures/data/openInterestHist`, {
      params: { symbol, period, limit: 500, endTime: Math.floor(end) },
      timeout: 20_000,
    });
    if (!Array.isArray(data) || !data.length) break;
    for (const row of data) {
      const ts = Number(row.timestamp);
      const oi = Number(row.sumOpenInterestValue ?? row.sumOpenInterest);
      if (!Number.isFinite(ts) || !Number.isFinite(oi) || ts < winFrom || ts > winTo) continue;
      out.push({ ts, oiUsdt: oi });
    }
    const first = Number(data[0].timestamp);
    if (!Number.isFinite(first) || data.length < 500) break;
    end = first - 1;
    if (first <= winFrom) break;
  }
  const byTs = new Map(out.map((r) => [r.ts, r]));
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

function pctDiff(a, b) {
  if (!(a > 0) || !(b > 0)) return null;
  return ((b - a) / a) * 100;
}

function stats(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  return {
    n: arr.length,
    mean: +mean.toFixed(4),
    median: +sorted[Math.floor(sorted.length / 2)].toFixed(4),
    p95: +sorted[Math.floor(sorted.length * 0.95)].toFixed(4),
    maxAbs: +Math.max(...arr.map(Math.abs)).toFixed(4),
  };
}

function dropPct(prev, cur) {
  if (!(prev > 0)) return null;
  return ((prev - cur) / prev) * 100;
}

// Sync DB caches
await ensureOpenInterest(SYMBOL, { from: fromMs, to: toMs, period: PERIOD === "5m" ? "1h" : PERIOD }).catch(
  (e) => console.warn("ensureOpenInterest:", e.message),
);
await ensureCoinalyzeOi(SYMBOL, { from: fromMs, to: toMs, interval: CZ_INTERVAL }).catch((e) =>
  console.warn("ensureCoinalyzeOi:", e.message),
);

const czSym = await resolveCoinalyzePerpSymbol(SYMBOL).catch(() => null);

// Live API pulls for apples-to-apples (DB may be stale)
const [binanceLive, coinalyzeLive] = await Promise.all([
  fetchBinanceOiPeriod(SYMBOL, PERIOD, fromMs, toMs).catch((e) => {
    console.warn("binanceLive:", e.message);
    return [];
  }),
  czSym
    ? fetchCoinalyzeOiHist(czSym, CZ_INTERVAL, fromMs, toMs).catch((e) => {
        console.warn("coinalyzeLive:", e.message);
        return [];
      })
    : [],
]);

const binanceDb = await readOpenInterest(SYMBOL, fromMs, toMs);
const coinalyzeDb = await readCoinalyzeOi(SYMBOL, fromMs, toMs, { interval: CZ_INTERVAL });

// Align on interval START ts (Coinalyze convention; Binance hist timestamps match period open)
const binanceByTs = new Map(binanceLive.map((r) => [r.ts, r.oiUsdt]));
const coinalyzeByTs = new Map(coinalyzeLive.map((r) => [r.ts, r.oiCloseUsd]));

const aligned = [];
for (const [ts, binOi] of binanceByTs) {
  const czOi = coinalyzeByTs.get(ts);
  if (czOi == null || !(binOi > 0) || !(czOi > 0)) continue;
  const diffPct = pctDiff(binOi, czOi);
  aligned.push({
    ts,
    iso: new Date(ts).toISOString(),
    binanceOiUsd: Math.round(binOi),
    coinalyzeOiUsd: Math.round(czOi),
    diffPct: diffPct != null ? +diffPct.toFixed(4) : null,
    ratio: +(czOi / binOi).toFixed(6),
  });
}
aligned.sort((a, b) => a.ts - b.ts);

const diffPcts = aligned.map((r) => r.diffPct).filter((x) => x != null);
const levelStats = stats(diffPcts.map(Math.abs));

// Drop-pct comparison (what LIQ_CASCADE OI gate actually uses)
const dropCompare = [];
for (let i = 1; i < aligned.length; i++) {
  const prev = aligned[i - 1];
  const cur = aligned[i];
  const binDrop = dropPct(prev.binanceOiUsd, cur.binanceOiUsd);
  const czDrop = dropPct(prev.coinalyzeOiUsd, cur.coinalyzeOiUsd);
  if (binDrop == null || czDrop == null) continue;
  const gateBin = binDrop >= 0.12;
  const gateCz = czDrop >= 0.12;
  dropCompare.push({
    barClose: new Date(cur.ts + PERIOD_MS).toISOString(),
    binDropPct: +binDrop.toFixed(4),
    czDropPct: +czDrop.toFixed(4),
    dropDelta: +(czDrop - binDrop).toFixed(4),
    gatePassBinance: gateBin,
    gatePassCoinalyze: gateCz,
    gateMismatch: gateBin !== gateCz,
  });
}
const gateMismatches = dropCompare.filter((r) => r.gateMismatch);
const dropDeltaStats = stats(dropCompare.map((r) => Math.abs(r.dropDelta)));

// Coverage
const coverage = {
  symbol: SYMBOL,
  coinalyzeSymbol: czSym,
  period: PERIOD,
  coinalyzeInterval: CZ_INTERVAL,
  window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() },
  binanceLivePoints: binanceLive.length,
  coinalyzeLivePoints: coinalyzeLive.length,
  binanceDbPoints: binanceDb.length,
  coinalyzeDbPoints: coinalyzeDb.length,
  alignedPoints: aligned.length,
};

const verdict =
  aligned.length < 10
    ? "INSUFFICIENT_OVERLAP"
    : levelStats.maxAbs <= 2
      ? "MATCH_GOOD"
      : levelStats.maxAbs <= 10
        ? "MATCH_ACCEPTABLE"
        : "MATERIAL_DIVERGENCE";

const report = {
  generatedAt: new Date().toISOString(),
  coverage,
  levelComparison: {
    verdict,
    absDiffPctStats: levelStats,
    note: "diffPct = (coinalyze - binance) / binance × 100 at same interval-start ts",
    sampleWorst: [...aligned].sort((a, b) => Math.abs(b.diffPct) - Math.abs(a.diffPct)).slice(0, 8),
    sampleRecent: aligned.slice(-8),
  },
  dropPctGateComparison: {
    bars: dropCompare.length,
    gateThresholdPct: 0.12,
    gateMismatches: gateMismatches.length,
    gateMismatchRate: dropCompare.length ? +(gateMismatches.length / dropCompare.length).toFixed(4) : null,
    dropDeltaAbsStats: dropDeltaStats,
    mismatchExamples: gateMismatches.slice(0, 12),
  },
  implications: {
    liqCascadeUses: "Coinalyze OI only (_liqCascadeOiSeries from readCoinalyzeOi)",
    binanceIngestUsedBy: "MLCTS / intelligence (historical_open_interest), NOT liq cascade",
    timestampNote:
      "Both compared at interval-start ts; LIQ_CASCADE prepareOiBars keys OI at ts+intervalMs (bar close)",
  },
};

const outPath = path.join(__dirname, `.oi-coinalyze-vs-binance-${SYMBOL}-${PERIOD}.json`);
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log(
  JSON.stringify(
    {
      symbol: SYMBOL,
      period: PERIOD,
      aligned: aligned.length,
      levelVerdict: verdict,
      absDiffMedianPct: levelStats?.median,
      absDiffMaxPct: levelStats?.maxAbs,
      gateMismatches: gateMismatches.length,
      gateMismatchRate: report.dropPctGateComparison.gateMismatchRate,
      outPath,
    },
    null,
    2,
  ),
);

await closePool?.();
