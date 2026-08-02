import axios from "axios";
import { getPool } from "../../db/pool.js";

const FAPI = process.env.BINANCE_FUTURES_REST_BASE || "https://fapi.binance.com";

/** Binance `/futures/data/openInterestHist` only serves the latest ~30 days. */
export const OI_API_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function liveOiApiWindow() {
  const now = Date.now();
  return {
    fromMs: now - OI_API_RETENTION_MS + 60_000,
    toMs: now,
  };
}

/** Intersect a research window with what Binance can serve (last 30d ending now). */
export function resolveOiApiWindow(requestedFromMs, requestedToMs) {
  const live = liveOiApiWindow();
  const fromMs = Math.max(Number(requestedFromMs), live.fromMs);
  const toMs = Math.min(Number(requestedToMs ?? live.toMs), live.toMs);
  const apiUnavailable = toMs < live.fromMs || fromMs > live.toMs;
  return {
    fromMs: apiUnavailable ? live.fromMs : fromMs,
    toMs: apiUnavailable ? live.toMs : toMs,
    apiUnavailable,
    apiLimited: fromMs > Number(requestedFromMs) || toMs < Number(requestedToMs ?? live.toMs),
    liveSync: true,
  };
}

async function fetchOiHist(symbol, period, win) {
  if (win.apiUnavailable) {
    return { rows: [], ...win };
  }
  const out = [];
  let end = win.toMs;
  let guard = 0;
  while (end > win.fromMs && guard < 100) {
    guard += 1;
    const { data } = await axios.get(`${FAPI}/futures/data/openInterestHist`, {
      params: {
        symbol,
        period,
        limit: 500,
        endTime: Math.floor(end),
      },
      timeout: 20_000,
    });
    if (!Array.isArray(data) || !data.length) break;
    for (const row of data) {
      const ts = Number(row.timestamp);
      const oi = Number(row.sumOpenInterestValue ?? row.sumOpenInterest);
      if (!Number.isFinite(ts) || !Number.isFinite(oi) || ts < win.fromMs) continue;
      out.push({ ts, oiUsdt: oi });
    }
    const first = Number(data[0].timestamp);
    if (!Number.isFinite(first) || data.length < 500) break;
    end = first - 1;
    if (first <= win.fromMs) break;
  }
  const byTs = new Map(out.map((r) => [r.ts, r]));
  return { rows: [...byTs.values()].sort((a, b) => a.ts - b.ts), ...win };
}

/** Historical global long/short account ratio (same 30-day API window as OI). */
async function fetchLsrHist(symbol, period, win) {
  if (win.apiUnavailable) {
    return { rows: [], ...win };
  }
  const out = [];
  let end = win.toMs;
  let guard = 0;
  while (end > win.fromMs && guard < 100) {
    guard += 1;
    const { data } = await axios.get(`${FAPI}/futures/data/globalLongShortAccountRatio`, {
      params: {
        symbol,
        period,
        limit: 500,
        endTime: Math.floor(end),
      },
      timeout: 20_000,
    });
    if (!Array.isArray(data) || !data.length) break;
    for (const row of data) {
      const ts = Number(row.timestamp);
      const lsr = Number(row.longShortRatio);
      if (!Number.isFinite(ts) || !Number.isFinite(lsr) || ts < win.fromMs) continue;
      out.push({ ts, longShortRatio: lsr });
    }
    const first = Number(data[0].timestamp);
    if (!Number.isFinite(first) || data.length < 500) break;
    end = first - 1;
    if (first <= win.fromMs) break;
  }
  const byTs = new Map(out.map((r) => [r.ts, r]));
  return { rows: [...byTs.values()].sort((a, b) => a.ts - b.ts), ...win };
}

function mergeOiAndLsr(oiRows, lsrRows) {
  const lsrByTs = new Map(lsrRows.map((r) => [r.ts, r.longShortRatio]));
  return oiRows.map((r) => ({
    ts: r.ts,
    oiUsdt: r.oiUsdt,
    longShortRatio: lsrByTs.get(r.ts) ?? null,
  }));
}

/**
 * @returns {Promise<{ inserted: number, oiPoints: number, lsrPoints: number }>}
 */
export async function ensureOpenInterest(symbol, { from, to, period = "1h" } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const requestedFromMs = Number(from);
  const requestedToMs = Number(to ?? Date.now());
  // Always sync the live 30d window — Binance cannot serve older OI; DB accumulates over time.
  const win = liveOiApiWindow();
  const [oiPack, lsrPack] = await Promise.all([
    fetchOiHist(sym, period, { ...win, apiUnavailable: false, apiLimited: true, liveSync: true }),
    fetchLsrHist(sym, period, { ...win, apiUnavailable: false, apiLimited: true, liveSync: true }).catch(() => ({
      rows: [],
      apiLimited: true,
      ...win,
    })),
  ]);
  const merged = mergeOiAndLsr(oiPack.rows, lsrPack.rows);
  const sql = `
    INSERT INTO historical_open_interest (symbol, ts, oi_usdt, long_short_ratio)
    VALUES ($1, to_timestamp($2 / 1000.0), $3, $4)
    ON CONFLICT (symbol, ts) DO UPDATE SET
      oi_usdt = EXCLUDED.oi_usdt,
      long_short_ratio = COALESCE(EXCLUDED.long_short_ratio, historical_open_interest.long_short_ratio)
  `;
  let inserted = 0;
  for (const r of merged) {
    const res = await pool.query(sql, [sym, r.ts, r.oiUsdt, r.longShortRatio]);
    if (res.rowCount > 0) inserted += 1;
  }
  return {
    inserted,
    oiPoints: oiPack.rows.length,
    lsrPoints: lsrPack.rows.length,
    apiLimited: true,
    liveSync: true,
    requestedFromMs,
    requestedToMs,
    effectiveFromMs: oiPack.fromMs,
    effectiveToMs: oiPack.toMs,
  };
}

/**
 * @returns {Promise<Array<{ ts: number, oiUsdt: number, longShortRatio?: number }>>}
 */
export async function readOpenInterest(symbol, fromMs, toMs) {
  const pool = getPool();
  if (!pool) return [];
  const sym = normalizeSymbol(symbol);
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts,
            oi_usdt::float8 AS oi_usdt,
            long_short_ratio::float8 AS long_short_ratio
       FROM historical_open_interest
      WHERE symbol = $1
        AND ts >= to_timestamp($2 / 1000.0)
        AND ts <= to_timestamp($3 / 1000.0)
      ORDER BY ts ASC`,
    [sym, fromMs, toMs],
  );
  return r.rows.map((row) => ({
    ts: Math.round(Number(row.ts)),
    oiUsdt: Number(row.oi_usdt),
    longShortRatio: row.long_short_ratio != null ? Number(row.long_short_ratio) : undefined,
  }));
}

/** Binance `/futures/data/openInterestHist` period for a liq-cascade liq interval. */
export function binanceOiPeriodForLiqInterval(liqInterval) {
  const s = String(liqInterval || "5min").toLowerCase();
  if (s === "1min") return "5m"; // Binance has no 1m OI — use 5m, aligned separately
  if (s === "5min") return "5m";
  if (s === "15min") return "15m";
  if (s === "30min") return "30m";
  if (s === "1hour" || s === "1h") return "1h";
  return "5m";
}

export function binanceOiPeriodToMs(period) {
  if (period === "5m") return 300_000;
  if (period === "15m") return 900_000;
  if (period === "30m") return 1_800_000;
  if (period === "1h") return 3_600_000;
  return 300_000;
}

function filterOiRowsToPeriod(rows, periodMs) {
  if (!rows?.length || !(periodMs > 0)) return rows ?? [];
  return rows.filter((r) => r.ts % periodMs === 0);
}

/**
 * Load OI for LIQ_CASCADE in Coinalyze-compatible shape `{ ts, oiCloseUsd }`.
 * Uses Binance futures OI hist (cached in historical_open_interest).
 * @returns {Promise<{ oiSeries: object[], oiIntervalMs: number, binancePeriod: string }>}
 */
export async function loadCascadeOiFromBinance(symbol, fromMs, toMs, liqInterval = "5min") {
  const binancePeriod = binanceOiPeriodForLiqInterval(liqInterval);
  const oiIntervalMs = binanceOiPeriodToMs(binancePeriod);
  await ensureOpenInterest(symbol, { from: fromMs, to: toMs, period: binancePeriod }).catch(() => {});
  const raw = await readOpenInterest(symbol, fromMs, toMs);
  const filtered = filterOiRowsToPeriod(raw, oiIntervalMs);
  const oiSeries = filtered.map((r) => ({ ts: r.ts, oiCloseUsd: r.oiUsdt }));
  return { oiSeries, oiIntervalMs, binancePeriod };
}
