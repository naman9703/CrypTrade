/**
 * Binance Vision aggTrades ingest + Timescale cache for tick trailing audit.
 */

import zlib from "node:zlib";
import axios from "axios";
import { getPool } from "../../db/pool.js";
import { calendarDaysInRange } from "../engine/trailTickSeries.js";

const VISION_BASE = "https://data.binance.vision/data";
const REST_BASE =
  process.env.BINANCE_LIVE_FUTURES_REST_BASE ||
  process.env.BINANCE_FUTURES_REST_BASE ||
  "https://fapi.binance.com";

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function normalizeRestRoot(url) {
  let s = String(url || "").trim().replace(/\/+$/, "");
  if (s.endsWith("/api")) s = s.slice(0, -4);
  if (s.endsWith("/fapi")) s = s.slice(0, -5);
  return s || "https://fapi.binance.com";
}

/**
 * Extract first file from a single-entry Binance daily zip (deflate).
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function extractFirstEntryFromZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 30) throw new Error("invalid_zip");
  if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
    throw new Error("not_zip_local_header");
  }
  const compMethod = buf.readUInt16LE(8);
  const compSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;
  const compressed = buf.subarray(dataStart, dataStart + compSize);
  if (compMethod === 0) return Buffer.from(compressed);
  if (compMethod === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`unsupported_zip_method_${compMethod}`);
}

/** @returns {string} */
export function visionAggTradesUrl(symbol, dateYmd, market = "um") {
  const sym = normalizeSymbol(symbol);
  const d = String(dateYmd).slice(0, 10);
  return `${VISION_BASE}/futures/${market}/daily/aggTrades/${sym}/${sym}-aggTrades-${d}.zip`;
}

/**
 * Parse Vision aggTrades CSV line (no header).
 * agg_id, price, qty, first_id, last_id, transact_time, is_buyer_maker
 */
export function parseAggTradesLine(line) {
  const s = String(line || "").trim();
  if (!s) return null;
  const parts = s.split(",");
  if (parts.length < 7) return null;
  const aggId = Number(parts[0]);
  const price = Number(parts[1]);
  const qty = Number(parts[2]);
  const ts = Number(parts[5]);
  const isBuyerMaker = String(parts[6]).toLowerCase() === "true";
  if (!Number.isFinite(aggId) || !Number.isFinite(price) || !Number.isFinite(ts)) return null;
  return { aggId, price, qty, ts, isBuyerMaker };
}

/**
 * @param {Buffer|string} csvBuf
 * @param {{ fromMs?: number, toMs?: number }} [filter]
 */
export function parseAggTradesCsv(csvBuf, filter = {}) {
  const text = Buffer.isBuffer(csvBuf) ? csvBuf.toString("utf8") : String(csvBuf);
  const fromMs = filter.fromMs != null ? Number(filter.fromMs) : null;
  const toMs = filter.toMs != null ? Number(filter.toMs) : null;
  const out = [];
  for (const line of text.split("\n")) {
    const row = parseAggTradesLine(line);
    if (!row) continue;
    if (fromMs != null && row.ts < fromMs) continue;
    if (toMs != null && row.ts > toMs) continue;
    out.push(row);
  }
  return out;
}

export async function downloadVisionZip(url) {
  const { data } = await axios.get(url, { responseType: "arraybuffer", timeout: 120_000 });
  return Buffer.from(data);
}

async function insertAggTradesBatch(symbol, rows) {
  const pool = getPool();
  if (!pool || !rows.length) return 0;
  const sym = normalizeSymbol(symbol);
  const chunk = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    const slice = rows.slice(i, i + chunk);
    const params = [];
    const values = [];
    for (const r of slice) {
      const base = params.length;
      params.push(sym, new Date(r.ts), r.price, r.qty ?? null, r.isBuyerMaker ?? null, r.aggId);
      values.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
      );
    }
    await pool.query(
      `INSERT INTO futures_agg_trades (symbol, ts, price, qty, is_buyer_maker, agg_id)
       VALUES ${values.join(",")}
       ON CONFLICT (symbol, ts, agg_id) DO NOTHING`,
      params,
    );
    inserted += slice.length;
  }
  return inserted;
}

async function countCachedAggTrades(symbol, fromMs, toMs) {
  const pool = getPool();
  if (!pool) return 0;
  const sym = normalizeSymbol(symbol);
  const r = await pool.query(
    `SELECT COUNT(*)::bigint AS c
       FROM futures_agg_trades
      WHERE symbol = $1
        AND ts >= to_timestamp($2 / 1000.0)
        AND ts <= to_timestamp($3 / 1000.0)`,
    [sym, Number(fromMs), Number(toMs)],
  );
  return Number(r.rows[0]?.c ?? 0);
}

export async function readAggTrades(symbol, fromMs, toMs) {
  const pool = getPool();
  if (!pool) return [];
  const sym = normalizeSymbol(symbol);
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts,
            price::float8 AS price,
            qty::float8 AS qty,
            is_buyer_maker AS "isBuyerMaker",
            agg_id AS "aggId"
       FROM futures_agg_trades
      WHERE symbol = $1
        AND ts >= to_timestamp($2 / 1000.0)
        AND ts <= to_timestamp($3 / 1000.0)
      ORDER BY ts ASC, agg_id ASC`,
    [sym, Number(fromMs), Number(toMs)],
  );
  return r.rows.map((row) => ({
    ts: Math.round(Number(row.ts)),
    price: Number(row.price),
    qty: row.qty != null ? Number(row.qty) : null,
    isBuyerMaker: row.isBuyerMaker === true,
    aggId: Number(row.aggId),
  }));
}

async function fetchAggTradesRestHour(symbol, startMs, endMs) {
  const sym = normalizeSymbol(symbol);
  const base = normalizeRestRoot(REST_BASE);
  const out = [];
  let fromId = undefined;
  for (let guard = 0; guard < 5000; guard++) {
    const params = { symbol: sym, startTime: startMs, endTime: endMs, limit: 1000 };
    if (fromId != null) params.fromId = fromId;
    const { data } = await axios.get(`${base}/fapi/v1/aggTrades`, { params, timeout: 30_000 });
    if (!Array.isArray(data) || !data.length) break;
    for (const row of data) {
      out.push({
        aggId: Number(row.a),
        price: Number(row.p),
        qty: Number(row.qq ?? row.q),
        ts: Number(row.T),
        isBuyerMaker: row.m === true,
      });
    }
    const last = data[data.length - 1];
    const nextId = Number(last.a) + 1;
    if (data.length < 1000 || nextId === fromId) break;
    fromId = nextId;
    if (Number(last.T) >= endMs) break;
  }
  return out;
}

async function fetchAggTradesRestRange(symbol, fromMs, toMs) {
  const HOUR = 3_600_000;
  const out = [];
  for (let t = fromMs; t <= toMs; t += HOUR) {
    const end = Math.min(t + HOUR - 1, toMs);
    const chunk = await fetchAggTradesRestHour(symbol, t, end);
    out.push(...chunk);
  }
  return out;
}

/**
 * Ensure aggTrades cached for [fromMs, toMs].
 * @param {string} symbol
 * @param {number} fromMs
 * @param {number} toMs
 * @param {{ onProgress?: (p: { phase: string, pct?: number, detail?: string }) => void }} [opts]
 */
export async function ensureAggTradesForWindow(symbol, fromMs, toMs, opts = {}) {
  const sym = normalizeSymbol(symbol);
  const from = Number(fromMs);
  const to = Number(toMs);
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  if (!sym || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return { cached: 0, fetched: 0, days: [] };
  }

  const existing = await countCachedAggTrades(sym, from, to);
  if (existing > 0) {
    onProgress?.({ phase: "cache_hit", pct: 100, detail: `${existing} ticks cached` });
    return { cached: existing, fetched: 0, days: calendarDaysInRange(from, to) };
  }

  const days = calendarDaysInRange(from, to);
  let fetched = 0;
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    onProgress?.({
      phase: "download",
      pct: Math.round((i / Math.max(1, days.length)) * 80),
      detail: `${sym} ${day}`,
    });
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const dayEnd = dayStart + 86_400_000 - 1;
    const filterFrom = Math.max(from, dayStart);
    const filterTo = Math.min(to, dayEnd);
    let rows = [];
    try {
      const url = visionAggTradesUrl(sym, day);
      const zip = await downloadVisionZip(url);
      const csv = extractFirstEntryFromZip(zip);
      rows = parseAggTradesCsv(csv, { fromMs: filterFrom, toMs: filterTo });
    } catch {
      try {
        rows = await fetchAggTradesRestRange(sym, filterFrom, filterTo);
      } catch {
        rows = [];
      }
    }
    if (rows.length) {
      fetched += await insertAggTradesBatch(sym, rows);
    }
  }

  onProgress?.({ phase: "done", pct: 100, detail: `inserted ${fetched}` });
  const cached = await countCachedAggTrades(sym, from, to);
  return { cached, fetched, days };
}

/**
 * Rough tick estimate: ~15 ticks/sec active futures (conservative for BTC).
 */
export function estimateTickCount(holdMs) {
  const ms = Math.max(0, Number(holdMs) || 0);
  return Math.round((ms / 1000) * 15);
}
