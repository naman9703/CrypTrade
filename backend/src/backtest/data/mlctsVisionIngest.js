/**
 * Binance Vision ingest for MLCTS: futures metrics (OI) + bookDepth → imbalance ratio.
 */
import axios from "axios";
import { getPool } from "../../db/pool.js";
import { calendarDaysInRange } from "../engine/trailTickSeries.js";
import {
  downloadVisionZip,
  extractFirstEntryFromZip,
} from "./visionTickIngest.js";

const VISION_BASE = "https://data.binance.vision/data";

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function visionDailyUrl(type, symbol, dayYmd) {
  const sym = normalizeSymbol(symbol);
  const d = String(dayYmd).slice(0, 10);
  return `${VISION_BASE}/futures/um/daily/${type}/${sym}/${sym}-${type}-${d}.zip`;
}

function parseVisionTs(raw) {
  const s = String(raw || "").trim();
  if (!s) return NaN;
  const iso = s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
  return Date.parse(iso);
}

/** @param {Buffer|string} csvBuf */
export function parseVisionMetricsCsv(csvBuf) {
  const text = Buffer.isBuffer(csvBuf) ? csvBuf.toString("utf8") : String(csvBuf);
  const out = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("create_time")) continue;
    const parts = s.split(",");
    if (parts.length < 4) continue;
    const ts = parseVisionTs(parts[0]);
    const oiContracts = Number(parts[2]);
    const oiUsdt = Number(parts[3]);
    const longShortRatio = parts.length > 6 ? Number(parts[6]) : NaN;
    const takerLsRatio = parts.length > 7 ? Number(parts[7]) : NaN;
    if (!Number.isFinite(ts) || !Number.isFinite(oiUsdt)) continue;
    out.push({
      ts,
      oiContracts: Number.isFinite(oiContracts) ? oiContracts : null,
      oiUsdt,
      longShortRatio: Number.isFinite(longShortRatio) ? longShortRatio : null,
      takerLsRatio: Number.isFinite(takerLsRatio) ? takerLsRatio : null,
    });
  }
  return out;
}

/**
 * Aggregate bookDepth rows per snapshot → bid/ask notional imbalance.
 *
 * PROXY — not identical to live orderBookCollector:
 *   Live:  sum(top-20 bid QTY) / (sum(bid QTY) + sum(ask QTY))
 *   Here:  sum(bid NOTIONAL at pct<0) / (bid_notional + ask_notional) for all bands (±1..±5)
 *
 * See scripts/research-mlcts-book-proxy-audit.mjs for distribution vs live sanity check.
 * CSV: timestamp, percentage, depth, notional — negative % = bid side, positive % = ask side.
 */
export function aggregateBookDepthImbalance(rows) {
  const byTs = new Map();
  for (const row of rows) {
    const ts = parseVisionTs(row.timestamp ?? row.ts);
    const pct = Number(row.percentage ?? row.pct);
    const notional = Number(row.notional);
    if (!Number.isFinite(ts) || !Number.isFinite(pct) || !Number.isFinite(notional)) continue;
    if (!byTs.has(ts)) byTs.set(ts, { bid: 0, ask: 0 });
    const g = byTs.get(ts);
    if (pct < 0) g.bid += notional;
    else if (pct > 0) g.ask += notional;
  }
  const out = [];
  for (const [ts, g] of byTs) {
    const total = g.bid + g.ask;
    const imbalanceRatio = total > 0 ? g.bid / total : 0.5;
    out.push({ ts, imbalanceRatio, bidNotional: g.bid, askNotional: g.ask });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** @param {Buffer|string} csvBuf */
export function parseBookDepthCsv(csvBuf) {
  const text = Buffer.isBuffer(csvBuf) ? csvBuf.toString("utf8") : String(csvBuf);
  const rows = [];
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("timestamp")) continue;
    const parts = s.split(",");
    if (parts.length < 4) continue;
    rows.push({
      timestamp: parts[0],
      percentage: Number(parts[1]),
      depth: Number(parts[2]),
      notional: Number(parts[3]),
    });
  }
  return aggregateBookDepthImbalance(rows);
}

async function countCachedMetrics(symbol, fromMs, toMs) {
  const pool = getPool();
  if (!pool) return 0;
  const r = await pool.query(
    `SELECT COUNT(*)::bigint AS c FROM futures_vision_metrics
      WHERE symbol = $1 AND ts >= to_timestamp($2/1000.0) AND ts <= to_timestamp($3/1000.0)`,
    [normalizeSymbol(symbol), fromMs, toMs],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function countCachedBookImb(symbol, fromMs, toMs) {
  const pool = getPool();
  if (!pool) return 0;
  const r = await pool.query(
    `SELECT COUNT(*)::bigint AS c FROM futures_book_depth_imbalance
      WHERE symbol = $1 AND ts >= to_timestamp($2/1000.0) AND ts <= to_timestamp($3/1000.0)`,
    [normalizeSymbol(symbol), fromMs, toMs],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function insertMetricsBatch(symbol, rows) {
  const pool = getPool();
  if (!pool || !rows.length) return 0;
  const sym = normalizeSymbol(symbol);
  const chunk = 200;
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params = [];
    const values = [];
    for (const r of slice) {
      const b = params.length;
      params.push(sym, new Date(r.ts), r.oiContracts, r.oiUsdt, r.longShortRatio, r.takerLsRatio);
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`);
    }
    await pool.query(
      `INSERT INTO futures_vision_metrics (symbol, ts, oi_contracts, oi_usdt, taker_ls_ratio, long_short_ratio)
       VALUES ${values.join(",")}
       ON CONFLICT (symbol, ts) DO UPDATE SET
         oi_contracts = EXCLUDED.oi_contracts,
         oi_usdt = EXCLUDED.oi_usdt,
         taker_ls_ratio = EXCLUDED.taker_ls_ratio,
         long_short_ratio = EXCLUDED.long_short_ratio`,
      params,
    );
    n += slice.length;
  }
  return n;
}

async function insertBookImbBatch(symbol, rows) {
  const pool = getPool();
  if (!pool || !rows.length) return 0;
  const sym = normalizeSymbol(symbol);
  const chunk = 200;
  let n = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params = [];
    const values = [];
    for (const r of slice) {
      const b = params.length;
      params.push(sym, new Date(r.ts), r.imbalanceRatio, r.bidNotional, r.askNotional);
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`);
    }
    await pool.query(
      `INSERT INTO futures_book_depth_imbalance (symbol, ts, imbalance_ratio, bid_notional, ask_notional)
       VALUES ${values.join(",")}
       ON CONFLICT (symbol, ts) DO UPDATE SET
         imbalance_ratio = EXCLUDED.imbalance_ratio,
         bid_notional = EXCLUDED.bid_notional,
         ask_notional = EXCLUDED.ask_notional`,
      params,
    );
    n += slice.length;
  }
  return n;
}

async function ingestVisionDay(symbol, type, parseFn, insertFn, day, fromMs, toMs) {
  const url = visionDailyUrl(type, symbol, day);
  try {
    const zip = await downloadVisionZip(url);
    const csv = extractFirstEntryFromZip(zip);
    let rows = parseFn(csv);
    rows = rows.filter((r) => r.ts >= fromMs && r.ts <= toMs);
    if (!rows.length) return { day, rows: 0, inserted: 0, skipped: true };
    const inserted = await insertFn(symbol, rows);
    return { day, rows: rows.length, inserted };
  } catch (err) {
    return { day, error: String(err?.message || err).slice(0, 120) };
  }
}

/**
 * Ensure Vision metrics + bookDepth cached for [fromMs, toMs].
 */
export async function ensureMlctsVisionData(symbol, fromMs, toMs, opts = {}) {
  const sym = normalizeSymbol(symbol);
  const from = Number(fromMs);
  const to = Number(toMs);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const force = opts.force === true;
  const metricsCached = await countCachedMetrics(sym, from, to);
  const bookCached = await countCachedBookImb(sym, from, to);
  const days = calendarDaysInRange(from, to);
  const report = { symbol: sym, days: days.length, metrics: { inserted: 0 }, book: { inserted: 0 } };

  if (!force && metricsCached > 100 && bookCached > 1000) {
    report.skipped = true;
    report.metrics.cached = metricsCached;
    report.book.cached = bookCached;
    return report;
  }

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    onProgress?.({ phase: "metrics", day, i, n: days.length });
    const m = await ingestVisionDay(sym, "metrics", parseVisionMetricsCsv, insertMetricsBatch, day, from, to);
    report.metrics.inserted += m.inserted ?? 0;
    if (m.error) report.metrics.errors = (report.metrics.errors ?? 0) + 1;

    onProgress?.({ phase: "bookDepth", day, i, n: days.length });
    const b = await ingestVisionDay(sym, "bookDepth", parseBookDepthCsv, insertBookImbBatch, day, from, to);
    report.book.inserted += b.inserted ?? 0;
    if (b.error) report.book.errors = (report.book.errors ?? 0) + 1;
  }

  report.metrics.cached = await countCachedMetrics(sym, from, to);
  report.book.cached = await countCachedBookImb(sym, from, to);
  return report;
}

async function loadVisionDayRows(symbol, type, parseFn, day, fromMs, toMs) {
  const url = visionDailyUrl(type, symbol, day);
  try {
    const zip = await downloadVisionZip(url);
    const csv = extractFirstEntryFromZip(zip);
    return parseFn(csv).filter((r) => r.ts >= fromMs && r.ts <= toMs);
  } catch {
    return [];
  }
}

/** Download Vision metrics + bookDepth into memory (no DB). */
export async function loadMlctsVisionFeedsMemory(symbol, fromMs, toMs, opts = {}) {
  const sym = normalizeSymbol(symbol);
  const from = Number(fromMs);
  const to = Number(toMs);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const days = calendarDaysInRange(from, to);
  const metricsRaw = [];
  const bookImbalanceSeries = [];

  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    onProgress?.({ phase: "metrics", day, i, n: days.length });
    metricsRaw.push(...(await loadVisionDayRows(sym, "metrics", parseVisionMetricsCsv, day, from, to)));
    onProgress?.({ phase: "bookDepth", day, i, n: days.length });
    bookImbalanceSeries.push(...(await loadVisionDayRows(sym, "bookDepth", parseBookDepthCsv, day, from, to)));
  }

  metricsRaw.sort((a, b) => a.ts - b.ts);
  bookImbalanceSeries.sort((a, b) => a.ts - b.ts);

  return {
    symbol: sym,
    days: days.length,
    visionMetrics: metricsRaw,
    oiSeries: normalizeVisionMetricsOiSeries(metricsRaw),
    bookImbalanceSeries,
  };
}

/** 5m Vision metrics → OI series with 4h change (48 × 5m bars). */
export function normalizeVisionMetricsOiSeries(rows) {
  const sorted = [...rows].sort((a, b) => a.ts - b.ts);
  const out = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i];
    const j = i - 48;
    const prev = j >= 0 ? sorted[j] : sorted[0];
    const oiNow = Number(cur.oiUsdt);
    const oiPrev = Number(prev?.oiUsdt ?? oiNow);
    const changePct = j >= 0 && oiPrev > 0 ? ((oiNow - oiPrev) / oiPrev) * 100 : 0;
    out.push({
      ts: cur.ts,
      oiUsdt: oiNow,
      changePct,
      change4hPct: changePct,
      source: "vision_metrics",
    });
  }
  return out;
}

export async function readVisionMetrics(symbol, fromMs, toMs) {
  const pool = getPool();
  if (!pool) return [];
  const sym = normalizeSymbol(symbol);
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts,
            oi_usdt::float8 AS "oiUsdt",
            taker_ls_ratio::float8 AS "takerLsRatio",
            long_short_ratio::float8 AS "longShortRatio"
       FROM futures_vision_metrics
      WHERE symbol = $1
        AND ts >= to_timestamp($2 / 1000.0)
        AND ts <= to_timestamp($3 / 1000.0)
      ORDER BY ts ASC`,
    [sym, fromMs, toMs],
  );
  return r.rows.map((row) => ({
    ts: Math.round(Number(row.ts)),
    oiUsdt: Number(row.oiUsdt),
    takerLsRatio: row.takerLsRatio != null ? Number(row.takerLsRatio) : null,
    longShortRatio: row.longShortRatio != null ? Number(row.longShortRatio) : null,
  }));
}

export async function readBookImbalanceSeries(symbol, fromMs, toMs) {
  const pool = getPool();
  if (!pool) return [];
  const sym = normalizeSymbol(symbol);
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts,
            imbalance_ratio::float8 AS "imbalanceRatio",
            bid_notional::float8 AS "bidNotional",
            ask_notional::float8 AS "askNotional"
       FROM futures_book_depth_imbalance
      WHERE symbol = $1
        AND ts >= to_timestamp($2 / 1000.0)
        AND ts <= to_timestamp($3 / 1000.0)
      ORDER BY ts ASC`,
    [sym, fromMs, toMs],
  );
  return r.rows.map((row) => ({
    ts: Math.round(Number(row.ts)),
    imbalanceRatio: Number(row.imbalanceRatio),
    bidNotional: row.bidNotional != null ? Number(row.bidNotional) : null,
    askNotional: row.askNotional != null ? Number(row.askNotional) : null,
  }));
}

/** Prefer Vision 5m OI; merge REST 1h for recent gaps if needed. */
export function mergeMlctsOiSeries(visionOi, restOi) {
  const byTs = new Map();
  for (const r of restOi ?? []) {
    if (r?.ts != null) byTs.set(r.ts, { ...r, source: r.source ?? "rest" });
  }
  for (const r of visionOi ?? []) {
    if (r?.ts != null) byTs.set(r.ts, r);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}
