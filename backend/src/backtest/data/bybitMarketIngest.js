/**
 * Bybit v5 public market data — OI + account ratio (cross-venue proxy).
 * Docs: https://bybit-exchange.github.io/docs/v5/market/open-interest
 */
import axios from "axios";
import { getPool } from "../../db/pool.js";
import { readCandles } from "./klineIngest.js";

const BYBIT = process.env.BYBIT_REST_BASE || "https://api.bytick.com";
const SOURCE = "bybit";
const PAGE_SLEEP_MS = Number(process.env.BYBIT_PAGE_SLEEP_MS || 800);

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function batchUpsert(pool, { columns, conflictSql, rows, rowPlaceholders, chunkSize = 400 }) {
  let affected = 0;
  const cols = columns.join(", ");
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const params = [];
    let p = 1;
    for (const row of chunk) {
      const { sql, params: rp } = rowPlaceholders(row, p);
      values.push(sql);
      params.push(...rp);
      p += rp.length;
    }
    const sql = `INSERT INTO ${conflictSql.table} (${cols}) VALUES ${values.join(", ")} ${conflictSql.clause}`;
    const res = await pool.query(sql, params);
    affected += res.rowCount ?? 0;
  }
  return affected;
}

async function bybitGet(path, params, { retries = 5 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const { data } = await axios.get(`${BYBIT}${path}`, { params, timeout: 30_000 });
      if (data?.retCode !== 0) {
        throw new Error(data?.retMsg || `bybit_error_${data?.retCode}`);
      }
      return data.result;
    } catch (err) {
      lastErr = err;
      const wait = Math.min(30_000, PAGE_SLEEP_MS * (attempt + 1) * 2);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/** Paginate OI history backward via nextPageCursor. */
export async function fetchBybitOpenInterestHist(symbol, intervalTime, fromMs, toMs) {
  const sym = normalizeSymbol(symbol);
  const out = [];
  let cursor = "";
  for (let guard = 0; guard < 800; guard++) {
    const params = {
      category: "linear",
      symbol: sym,
      intervalTime,
      limit: 200,
    };
    if (cursor) {
      params.cursor = cursor;
    } else {
      params.endTime = toMs;
    }
    const result = await bybitGet("/v5/market/open-interest", params);
    const list = result?.list ?? [];
    if (!list.length) break;
    for (const row of list) {
      const ts = Number(row.timestamp);
      const oiBase = Number(row.openInterest);
      if (!Number.isFinite(ts) || !Number.isFinite(oiBase) || ts < fromMs || ts > toMs) continue;
      out.push({ ts, oiBase, oiSingle: Number(row.singleOpenInterest) });
    }
    const oldest = Number(list[list.length - 1].timestamp);
    cursor = result?.nextPageCursor || "";
    if (!cursor || oldest <= fromMs) break;
    await sleep(PAGE_SLEEP_MS);
  }
  const byTs = new Map(out.map((r) => [r.ts, r]));
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/** Paginate account ratio backward. */
export async function fetchBybitAccountRatioHist(symbol, period, fromMs, toMs) {
  const sym = normalizeSymbol(symbol);
  const out = [];
  let cursor = "";
  for (let guard = 0; guard < 800; guard++) {
    const params = {
      category: "linear",
      symbol: sym,
      period,
      limit: 500,
    };
    if (cursor) {
      params.cursor = cursor;
    } else {
      params.endTime = toMs;
    }
    const result = await bybitGet("/v5/market/account-ratio", params);
    const list = result?.list ?? [];
    if (!list.length) break;
    for (const row of list) {
      const ts = Number(row.timestamp);
      const buy = Number(row.buyRatio);
      const sell = Number(row.sellRatio);
      if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue;
      out.push({ ts, buyRatio: buy, sellRatio: sell });
    }
    const oldest = Number(list[list.length - 1].timestamp);
    cursor = result?.nextPageCursor || "";
    if (!cursor || oldest <= fromMs) break;
    await sleep(PAGE_SLEEP_MS);
  }
  const byTs = new Map(out.map((r) => [r.ts, r]));
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/** Attach USD notional using nearest 15m futures close (Binance candles in DB). */
export async function attachOiUsdtFromCandles(symbol, oiRows, fromMs, toMs) {
  if (!oiRows.length) return [];
  const winFrom = Math.min(fromMs, ...oiRows.map((r) => r.ts)) - 3_600_000;
  const winTo = Math.max(toMs, ...oiRows.map((r) => r.ts)) + 3_600_000;
  const candles = await readCandles(symbol, "15m", winFrom, winTo, { market: "futures" }).catch(() => []);
  if (!candles?.length) {
    return oiRows.map((r) => ({ ...r, oiUsdt: null }));
  }
  let ci = 0;
  return oiRows.map((r) => {
    while (ci + 1 < candles.length && candles[ci + 1].ts <= r.ts) ci++;
    const px = candles[ci]?.close ?? candles[ci]?.c;
    const oiUsdt = px > 0 && r.oiBase > 0 ? r.oiBase * px : null;
    return { ...r, oiUsdt };
  });
}

const OI_UPSERT = {
  columns: ["symbol", "ts", "interval_time", "oi_base", "oi_usdt", "source"],
  conflictSql: {
    table: "historical_bybit_open_interest",
    clause: `ON CONFLICT (symbol, ts, interval_time) DO UPDATE SET
      oi_base = EXCLUDED.oi_base,
      oi_usdt = COALESCE(EXCLUDED.oi_usdt, historical_bybit_open_interest.oi_usdt),
      source = EXCLUDED.source`,
  },
};

async function upsertBybitOiRows(pool, sym, intervalTime, rows) {
  if (!rows.length) return 0;
  return batchUpsert(pool, {
    ...OI_UPSERT,
    rows,
    rowPlaceholders: (r, p) => ({
      sql: `($${p}, to_timestamp($${p + 1} / 1000.0), $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5})`,
      params: [sym, r.ts, intervalTime, r.oiBase, r.oiUsdt, SOURCE],
    }),
  });
}

/** Stream OI pages to DB — avoids holding full history in memory. */
async function syncBybitOpenInterest(symbol, intervalTime, fromMs, toMs, { onPage, force = false } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const intervalMs = intervalTime === "1h" ? 3_600_000 : 900_000;
  const expected = Math.max(1, Math.floor((toMs - fromMs) / intervalMs) * 0.9);
  if (!force) {
    const existing = await pool.query(
      `SELECT count(*)::int AS n
         FROM historical_bybit_open_interest
        WHERE symbol = $1 AND interval_time = $2
          AND ts >= to_timestamp($3 / 1000.0)
          AND ts <= to_timestamp($4 / 1000.0)`,
      [sym, intervalTime, fromMs, toMs],
    );
    const n = existing.rows[0]?.n ?? 0;
    if (n >= expected) {
      return { inserted: 0, points: n, source: SOURCE, intervalTime, skipped: true };
    }
  }
  let cursor = "";
  let inserted = 0;
  let points = 0;
  for (let guard = 0; guard < 800; guard++) {
    const params = {
      category: "linear",
      symbol: sym,
      intervalTime,
      limit: 200,
    };
    if (cursor) params.cursor = cursor;
    else params.endTime = toMs;
    const result = await bybitGet("/v5/market/open-interest", params);
    const list = result?.list ?? [];
    if (!list.length) break;
    const page = [];
    for (const row of list) {
      const ts = Number(row.timestamp);
      const oiBase = Number(row.openInterest);
      if (!Number.isFinite(ts) || !Number.isFinite(oiBase) || ts < fromMs || ts > toMs) continue;
      page.push({ ts, oiBase, oiSingle: Number(row.singleOpenInterest) });
    }
    if (page.length) {
      const rows = await attachOiUsdtFromCandles(sym, page, fromMs, toMs);
      inserted += await upsertBybitOiRows(pool, sym, intervalTime, rows);
      points += rows.length;
      onPage?.({ page: guard + 1, batch: rows.length, total: points });
    }
    const oldest = Number(list[list.length - 1].timestamp);
    cursor = result?.nextPageCursor || "";
    if (!cursor || oldest <= fromMs) break;
    await sleep(PAGE_SLEEP_MS);
  }
  return { inserted, points, source: SOURCE, intervalTime };
}

export async function ensureBybitOpenInterest(symbol, { from, to, intervalTime = "15min", onPage } = {}) {
  const fromMs = Number(from);
  const toMs = Number(to ?? Date.now());
  return syncBybitOpenInterest(symbol, intervalTime, fromMs, toMs, { onPage });
}

export async function ensureBybitAccountRatio(symbol, { from, to, period = "1h", force = false } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_not_configured");
  const sym = normalizeSymbol(symbol);
  const fromMs = Number(from);
  const toMs = Number(to ?? Date.now());
  if (!force) {
    const expected = Math.max(1, Math.floor((toMs - fromMs) / 3_600_000) * 0.9);
    const existing = await pool.query(
      `SELECT count(*)::int AS n
         FROM historical_bybit_account_ratio
        WHERE symbol = $1 AND period = $2
          AND ts >= to_timestamp($3 / 1000.0)
          AND ts <= to_timestamp($4 / 1000.0)`,
      [sym, period, fromMs, toMs],
    );
    const n = existing.rows[0]?.n ?? 0;
    if (n >= expected) {
      return { inserted: 0, points: n, source: SOURCE, period, skipped: true };
    }
  }
  const rows = await fetchBybitAccountRatioHist(sym, period, fromMs, toMs);
  const inserted = await batchUpsert(pool, {
    columns: ["symbol", "ts", "period", "buy_ratio", "sell_ratio", "source"],
    conflictSql: {
      table: "historical_bybit_account_ratio",
      clause: `ON CONFLICT (symbol, ts, period) DO UPDATE SET
      buy_ratio = EXCLUDED.buy_ratio,
      sell_ratio = EXCLUDED.sell_ratio,
      source = EXCLUDED.source`,
    },
    rows,
    rowPlaceholders: (r, p) => ({
      sql: `($${p}, to_timestamp($${p + 1} / 1000.0), $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5})`,
      params: [sym, r.ts, period, r.buyRatio, r.sellRatio, SOURCE],
    }),
  });
  return { inserted, points: rows.length, source: SOURCE, period };
}

export async function ensureBybitPositioning(symbol, fromMs, toMs, opts = {}) {
  const oiInterval = opts.oiIntervalTime ?? "15min";
  const lsrPeriod = opts.lsrPeriod ?? "1h";
  const onPage = opts.onPage;
  const oi = await ensureBybitOpenInterest(symbol, {
    from: fromMs,
    to: toMs,
    intervalTime: oiInterval,
    onPage,
  }).catch((e) => ({ inserted: 0, error: e.message }));
  const lsr = await ensureBybitAccountRatio(symbol, { from: fromMs, to: toMs, period: lsrPeriod }).catch((e) => ({
    inserted: 0,
    error: e.message,
  }));
  return { oi, lsr, source: SOURCE };
}

export async function readBybitOpenInterest(symbol, fromMs, toMs, intervalTime = "15min") {
  const pool = getPool();
  if (!pool) return [];
  const sym = normalizeSymbol(symbol);
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts,
            oi_base::float8 AS oi_base,
            oi_usdt::float8 AS oi_usdt
       FROM historical_bybit_open_interest
      WHERE symbol = $1 AND interval_time = $2
        AND ts >= to_timestamp($3 / 1000.0)
        AND ts <= to_timestamp($4 / 1000.0)
      ORDER BY ts ASC`,
    [sym, intervalTime, fromMs, toMs],
  );
  return r.rows.map((row) => ({
    ts: Math.round(Number(row.ts)),
    oiBase: Number(row.oi_base),
    oiUsdt: row.oi_usdt != null ? Number(row.oi_usdt) : null,
    source: SOURCE,
  }));
}

export async function readBybitAccountRatio(symbol, fromMs, toMs, period = "1h") {
  const pool = getPool();
  if (!pool) return [];
  const sym = normalizeSymbol(symbol);
  const r = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts,
            buy_ratio::float8 AS buy_ratio,
            sell_ratio::float8 AS sell_ratio
       FROM historical_bybit_account_ratio
      WHERE symbol = $1 AND period = $2
        AND ts >= to_timestamp($3 / 1000.0)
        AND ts <= to_timestamp($4 / 1000.0)
      ORDER BY ts ASC`,
    [sym, period, fromMs, toMs],
  );
  return r.rows.map((row) => ({
    ts: Math.round(Number(row.ts)),
    buyRatio: Number(row.buy_ratio),
    sellRatio: Number(row.sell_ratio),
    longShortRatio: row.sell_ratio > 0 ? Number(row.buy_ratio) / Number(row.sell_ratio) : null,
    source: SOURCE,
  }));
}

export async function loadBybitSeries(symbol, fromMs, toMs, opts = {}) {
  const oiInterval = opts.oiIntervalTime ?? "15min";
  const lsrPeriod = opts.lsrPeriod ?? "1h";
  const [oi, lsr] = await Promise.all([
    readBybitOpenInterest(symbol, fromMs, toMs, oiInterval).catch(() => []),
    readBybitAccountRatio(symbol, fromMs, toMs, lsrPeriod).catch(() => []),
  ]);
  return { oi, lsr, symbol, source: SOURCE, fromMs, toMs };
}
