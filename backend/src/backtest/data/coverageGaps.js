/**
 * Plan exact timestamp ranges for patch backfills (remaining days / holes),
 * instead of re-fetching an entire multi-year window.
 */

import { getPool } from "../../db/pool.js";
import { tfToMs } from "./timeframe.js";

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

export function preferredOhlcSources(market = "futures") {
  // Include legacy `binance` rows so coverage/patch don't treat the window as empty
  // when older ingest wrote that source before venue-specific labels.
  return market === "spot" ? ["binance_spot", "binance"] : ["binance_futures", "binance"];
}

/**
 * Merge overlapping / adjacent [from,to) ranges (ms).
 * @param {Array<{ from: number, to: number }>} ranges
 * @returns {Array<{ from: number, to: number }>}
 */
export function mergeTimeRanges(ranges) {
  const sorted = (ranges || [])
    .map((r) => ({ from: Number(r.from), to: Number(r.to) }))
    .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to > r.from)
    .sort((a, b) => a.from - b.from);
  if (!sorted.length) return [];
  const out = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.from <= last.to) {
      last.to = Math.max(last.to, cur.to);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/**
 * @param {Array<{ from: number, to: number }>} ranges
 */
export function summarizeRanges(ranges, stepMs) {
  const merged = mergeTimeRanges(ranges);
  const remainingMs = merged.reduce((acc, r) => acc + (r.to - r.from), 0);
  const step = Math.max(1, Number(stepMs) || 1);
  const remainingBars = Math.max(0, Math.floor(remainingMs / step));
  const remainingDays = remainingMs / (24 * 60 * 60 * 1000);
  return {
    ranges: merged,
    remainingMs,
    remainingBars,
    remainingDays,
    patchFrom: merged.length ? merged[0].from : null,
    patchTo: merged.length ? merged[merged.length - 1].to : null,
  };
}

/**
 * Build patch ranges for OHLC (or any step series) from min/max + monthly holes.
 * Uses exact maxTs as the trailing sync start so upserts overlap smoothly.
 *
 * @param {object} opts
 * @param {number} opts.from
 * @param {number} opts.to
 * @param {number} opts.stepMs
 * @param {number|null} opts.minTs
 * @param {number|null} opts.maxTs
 * @param {Array<{ month: string, have: number, expected: number, coveragePct: number }>} [opts.monthly]
 * @param {number} [opts.monthHolePct=99] months below this are treated as holes
 */
export function planPatchRangesFromCoverage({
  from,
  to,
  stepMs,
  minTs,
  maxTs,
  monthly = [],
  monthHolePct = 99,
} = {}) {
  const fromMs = Number(from);
  const toMs = Number(to);
  const step = Math.max(1, Number(stepMs) || 1);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    return summarizeRanges([], step);
  }

  // Align "to" to last closed bar so we don't chase the in-progress candle.
  const closedTo = Math.min(toMs, Math.floor(toMs / step) * step);
  if (closedTo <= fromMs) return summarizeRanges([], step);

  const ranges = [];

  if (minTs == null && maxTs == null) {
    ranges.push({ from: fromMs, to: closedTo });
    return summarizeRanges(ranges, step);
  }

  // Leading hole: requested window starts before first stored bar.
  if (minTs == null || minTs > fromMs + step) {
    ranges.push({ from: fromMs, to: Math.min(closedTo, minTs ?? closedTo) });
  }

  // Incomplete months (historical holes) — skip nearly-full tip months (use maxTs patch).
  for (const m of monthly || []) {
    const pct = Number(m.coveragePct);
    if (!(pct < monthHolePct)) continue;
    const [yStr, moStr] = String(m.month || "").split("-");
    const y = Number(yStr);
    const mo = Number(moStr);
    if (!Number.isFinite(y) || !Number.isFinite(mo)) continue;
    const monthStart = Date.UTC(y, mo - 1, 1);
    const monthEnd = Date.UTC(y, mo, 1);
    const sliceFrom = Math.max(fromMs, monthStart);
    const sliceTo = Math.min(closedTo, monthEnd);
    if (sliceTo <= sliceFrom) continue;

    const tipInMonth =
      maxTs != null && Number.isFinite(maxTs) && maxTs >= sliceFrom && maxTs < sliceTo;
    // Nearly full month with only a tip missing → exact timestamp patch, not whole month.
    if (tipInMonth && pct >= 50) {
      ranges.push({ from: maxTs, to: sliceTo });
    } else {
      ranges.push({ from: sliceFrom, to: sliceTo });
    }
  }

  // Trailing tip from exact maxTs (overlap one bar for smooth upsert).
  if (maxTs != null && Number.isFinite(maxTs) && maxTs + step < closedTo) {
    ranges.push({ from: maxTs, to: closedTo });
  }

  return summarizeRanges(ranges, step);
}

/**
 * Source-aware OHLC coverage bounds for patch planning.
 * @returns {Promise<{ minTs: number|null, maxTs: number|null, have: number }>}
 */
export async function getOhlcBounds(symbol, tf, { from, to, market = "futures" } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const timeframe = String(tf || "15m").toLowerCase();
  const sources = preferredOhlcSources(market);
  const params = [sym, timeframe, sources];
  let where = "symbol = $1 AND timeframe = $2 AND source = ANY($3::text[])";
  if (from != null) {
    params.push(Number(from));
    where += ` AND open_time >= to_timestamp($${params.length} / 1000.0)`;
  }
  if (to != null) {
    params.push(Number(to));
    where += ` AND open_time < to_timestamp($${params.length} / 1000.0)`;
  }
  const r = await pool.query(
    `SELECT COUNT(*)::int AS have,
            MIN(EXTRACT(EPOCH FROM open_time) * 1000) AS min_ts,
            MAX(EXTRACT(EPOCH FROM open_time) * 1000) AS max_ts
       FROM ohlcv_candles
      WHERE ${where}`,
    params,
  );
  return {
    have: Number(r.rows[0]?.have ?? 0),
    minTs: r.rows[0]?.min_ts != null ? Math.round(Number(r.rows[0].min_ts)) : null,
    maxTs: r.rows[0]?.max_ts != null ? Math.round(Number(r.rows[0].max_ts)) : null,
  };
}

/**
 * Plan patch ranges for trade OHLC using DB bounds + monthly holes.
 */
export async function planOhlcPatchRanges(symbol, tf, from, to, { market = "futures", monthly = null } = {}) {
  const timeframe = String(tf || "15m").toLowerCase();
  const step = tfToMs(timeframe);
  const fromMs = Number(from);
  const toMs = Number(to);
  const bounds = await getOhlcBounds(symbol, timeframe, { from: fromMs, to: toMs, market });

  let months = monthly;
  if (!Array.isArray(months)) {
    const { getMonthlyCoverage } = await import("./dataCoverage.js");
    months = await getMonthlyCoverage(symbol, timeframe, fromMs, toMs, { market });
  }

  return {
    ...planPatchRangesFromCoverage({
      from: fromMs,
      to: toMs,
      stepMs: step,
      minTs: bounds.minTs,
      maxTs: bounds.maxTs,
      monthly: months,
    }),
    minTs: bounds.minTs,
    maxTs: bounds.maxTs,
    have: bounds.have,
    stepMs: step,
  };
}
