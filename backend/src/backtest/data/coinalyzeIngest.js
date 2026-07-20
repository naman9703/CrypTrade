/**
 * Coinalyze REST API — liquidations, OI, L/S (aggregated futures).
 * Docs: https://api.coinalyze.net/v1/doc/
 */
import axios from "axios";
import { getPool } from "../../db/pool.js";

const BASE = process.env.COINALYZE_API_BASE || "https://api.coinalyze.net/v1";
const SOURCE = "coinalyze";
const PAGE_SLEEP_MS = Number(process.env.COINALYZE_PAGE_SLEEP_MS || 1600);

let marketCache = null;
let marketCacheAt = 0;

function apiKey() {
  const k = process.env.COINALYZE_API_KEY;
  if (!k) throw new Error("COINALYZE_API_KEY missing");
  return k;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeSymbol(symbol) {
  return String(symbol || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

async function coinalyzeGet(path, params, { retries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const { data, status, headers } = await axios.get(`${BASE}${path}`, {
        params,
        headers: { api_key: apiKey() },
        timeout: 45_000,
        validateStatus: (s) => s < 500,
      });
      if (status === 429) {
        const wait = Number(headers["retry-after"] || 5) * 1000;
        await sleep(wait);
        continue;
      }
      if (status === 401) throw new Error("coinalyze_invalid_api_key");
      if (status >= 400) throw new Error(`coinalyze_http_${status}: ${JSON.stringify(data)}`);
      return data;
    } catch (err) {
      lastErr = err;
      await sleep(PAGE_SLEEP_MS * (attempt + 1));
    }
  }
  throw lastErr;
}

export async function fetchCoinalyzeFutureMarkets({ refresh = false } = {}) {
  if (marketCache && !refresh && Date.now() - marketCacheAt < 3600_000) return marketCache;
  const rows = await coinalyzeGet("/future-markets", {});
  marketCache = Array.isArray(rows) ? rows : [];
  marketCacheAt = Date.now();
  return marketCache;
}

/** Map BTCUSDT → BTCUSDT_PERP.A (Binance USDT perp aggregate on Coinalyze). */
export async function resolveCoinalyzePerpSymbol(symbol, { exchangeCode = "A" } = {}) {
  const sym = normalizeSymbol(symbol);
  const base = sym.replace(/USDT$/, "");
  const markets = await fetchCoinalyzeFutureMarkets();
  const exact = markets.find(
    (m) =>
      m.is_perpetual &&
      m.quote_asset === "USDT" &&
      m.base_asset === base &&
      String(m.exchange || "").toUpperCase() === String(exchangeCode).toUpperCase(),
  );
  if (exact?.symbol) return exact.symbol;
  const fallback = `${base}USDT_PERP.${exchangeCode}`;
  const exists = markets.some((m) => m.symbol === fallback);
  return exists ? fallback : null;
}

function sec(ms) {
  return Math.floor(ms / 1000);
}

async function fetchHistory(endpoint, coinalyzeSymbol, interval, fromMs, toMs) {
  const data = await coinalyzeGet(`/${endpoint}`, {
    symbols: coinalyzeSymbol,
    interval,
    from: sec(fromMs),
    to: sec(toMs),
    convert_to_usd: "true",
  });
  const block = Array.isArray(data) ? data[0] : null;
  return block?.history ?? [];
}

export async function fetchCoinalyzeLiquidationHist(coinalyzeSymbol, interval, fromMs, toMs) {
  const hist = await fetchHistory("liquidation-history", coinalyzeSymbol, interval, fromMs, toMs);
  return hist
    .map((r) => ({
      ts: Number(r.t) * 1000,
      liqLongUsd: Number(r.l) || 0,
      liqShortUsd: Number(r.s) || 0,
    }))
    .filter((r) => r.ts >= fromMs && r.ts <= toMs)
    .sort((a, b) => a.ts - b.ts);
}

export async function fetchCoinalyzeOiHist(coinalyzeSymbol, interval, fromMs, toMs) {
  const hist = await fetchHistory("open-interest-history", coinalyzeSymbol, interval, fromMs, toMs);
  return hist
    .map((r) => ({
      ts: Number(r.t) * 1000,
      oiCloseUsd: Number(r.c) || 0,
    }))
    .filter((r) => r.ts >= fromMs && r.ts <= toMs)
    .sort((a, b) => a.ts - b.ts);
}

async function batchUpsert(pool, table, columns, rows, conflictCols, chunkSize = 300) {
  if (!rows.length) return 0;
  let affected = 0;
  const colList = columns.join(", ");
  const updates = columns
    .filter((c) => !conflictCols.includes(c))
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  const conflict = `(${conflictCols.join(", ")})`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const values = [];
    const params = [];
    let p = 1;
    for (const row of chunk) {
      const ph = columns.map(() => `$${p++}`);
      values.push(`(${ph.join(", ")})`);
      for (const c of columns) params.push(row[c]);
    }
    const sql = `INSERT INTO ${table} (${colList}) VALUES ${values.join(", ")}
      ON CONFLICT ${conflict} DO UPDATE SET ${updates}`;
    const res = await pool.query(sql, params);
    affected += res.rowCount ?? 0;
  }
  return affected;
}

export async function ensureCoinalyzeLiquidations(symbol, { from, to, interval = "1hour" } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_pool_unavailable");
  const sym = normalizeSymbol(symbol);
  const fromMs = typeof from === "number" ? from : Date.parse(from);
  const toMs = typeof to === "number" ? to : Date.parse(to);
  const czSym = await resolveCoinalyzePerpSymbol(sym);
  if (!czSym) return { inserted: 0, error: "no_coinalyze_symbol" };

  const rows = await fetchCoinalyzeLiquidationHist(czSym, interval, fromMs, toMs);
  const dbRows = rows.map((r) => ({
    symbol: sym,
    coinalyze_symbol: czSym,
    ts: new Date(r.ts),
    interval_name: interval,
    liq_long_usd: r.liqLongUsd,
    liq_short_usd: r.liqShortUsd,
    source: SOURCE,
  }));
  const inserted = await batchUpsert(
    pool,
    "historical_coinalyze_liquidations",
    ["symbol", "coinalyze_symbol", "ts", "interval_name", "liq_long_usd", "liq_short_usd", "source"],
    dbRows,
    ["symbol", "ts", "interval_name"],
  );
  return { inserted, rows: rows.length, coinalyzeSymbol: czSym };
}

export async function ensureCoinalyzeOi(symbol, { from, to, interval = "1hour" } = {}) {
  const pool = getPool();
  if (!pool) throw new Error("db_pool_unavailable");
  const sym = normalizeSymbol(symbol);
  const fromMs = typeof from === "number" ? from : Date.parse(from);
  const toMs = typeof to === "number" ? to : Date.parse(to);
  const czSym = await resolveCoinalyzePerpSymbol(sym);
  if (!czSym) return { inserted: 0, error: "no_coinalyze_symbol" };

  const rows = await fetchCoinalyzeOiHist(czSym, interval, fromMs, toMs);
  const dbRows = rows.map((r) => ({
    symbol: sym,
    coinalyze_symbol: czSym,
    ts: new Date(r.ts),
    interval_name: interval,
    oi_close_usd: r.oiCloseUsd,
    source: SOURCE,
  }));
  const inserted = await batchUpsert(
    pool,
    "historical_coinalyze_open_interest",
    ["symbol", "coinalyze_symbol", "ts", "interval_name", "oi_close_usd", "source"],
    dbRows,
    ["symbol", "ts", "interval_name"],
  );
  return { inserted, rows: rows.length, coinalyzeSymbol: czSym };
}

export async function readCoinalyzeLiquidations(symbol, fromMs, toMs, { interval = "1hour" } = {}) {
  const pool = getPool();
  if (!pool) return [];
  const sym = normalizeSymbol(symbol);
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts, liq_long_usd, liq_short_usd
     FROM historical_coinalyze_liquidations
     WHERE symbol = $1 AND interval_name = $2 AND ts >= to_timestamp($3 / 1000.0) AND ts <= to_timestamp($4 / 1000.0)
     ORDER BY ts ASC`,
    [sym, interval, fromMs, toMs],
  );
  return rows.map((r) => ({
    ts: Number(r.ts),
    liqLongUsd: Number(r.liq_long_usd) || 0,
    liqShortUsd: Number(r.liq_short_usd) || 0,
    liqTotalUsd: (Number(r.liq_long_usd) || 0) + (Number(r.liq_short_usd) || 0),
  }));
}

export async function readCoinalyzeOi(symbol, fromMs, toMs, { interval = "1hour" } = {}) {
  const pool = getPool();
  if (!pool) return [];
  const sym = normalizeSymbol(symbol);
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts) * 1000 AS ts, oi_close_usd
     FROM historical_coinalyze_open_interest
     WHERE symbol = $1 AND interval_name = $2 AND ts >= to_timestamp($3 / 1000.0) AND ts <= to_timestamp($4 / 1000.0)
     ORDER BY ts ASC`,
    [sym, interval, fromMs, toMs],
  );
  return rows.map((r) => ({ ts: Number(r.ts), oiCloseUsd: Number(r.oi_close_usd) || 0 }));
}

export async function ensureCoinalyzeData(symbol, fromMs, toMs, opts = {}) {
  const interval = opts.interval || "daily";
  const results = { liquidations: null, oi: null, hourly: null };
  results.liquidations = await ensureCoinalyzeLiquidations(symbol, { from: fromMs, to: toMs, interval });
  results.oi = await ensureCoinalyzeOi(symbol, { from: fromMs, to: toMs, interval });
  // Rolling window — last ~70d of 1h bars for intraday abstention
  const recentFrom = Math.max(fromMs, Date.now() - 70 * 86400_000);
  if (toMs > recentFrom && interval !== "1hour") {
    results.hourly = {
      liquidations: await ensureCoinalyzeLiquidations(symbol, {
        from: recentFrom,
        to: toMs,
        interval: "1hour",
      }),
      oi: await ensureCoinalyzeOi(symbol, { from: recentFrom, to: toMs, interval: "1hour" }),
    };
  }
  return results;
}

export async function loadCoinalyzeSeries(symbol, fromMs, toMs, opts = {}) {
  const interval = opts.interval || "daily";
  const [liquidations, oi, liq1h, oi1h] = await Promise.all([
    readCoinalyzeLiquidations(symbol, fromMs, toMs, { interval }),
    readCoinalyzeOi(symbol, fromMs, toMs, { interval }),
    readCoinalyzeLiquidations(symbol, fromMs, toMs, { interval: "1hour" }),
    readCoinalyzeOi(symbol, fromMs, toMs, { interval: "1hour" }),
  ]);
  return {
    liquidations: liq1h,
    liquidationsDaily: liquidations,
    oi: oi1h,
    oiDaily: oi,
    symbol,
    source: SOURCE,
    interval: liq1h.length ? "1hour" : interval,
  };
}
