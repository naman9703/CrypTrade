/**
 * Append-only JSONL logs so Activity + trade WS payloads survive backend restarts.
 * Default paths are per TRADING_MODE under data/modes/<slug>/ (see tradingModePersistence.js).
 */
import fs from "fs";
import path from "path";
import {
  getTradingModePersistenceSlug,
  maybeMigrateLegacyModeFiles,
  resolveModeDataRootDir,
  resolveModeScopedDir,
  tradingModeToPersistenceSlug,
} from "./tradingModePersistence.js";
import { filterStrictPortfolioTradesAfterMerge } from "./tradeLedgerClassification.js";

const MAX_ACTIVITY_LINES = Number(process.env.ACTIVITY_LOG_MAX_LINES || 8000);
const MAX_TRADE_WS_LINES = Number(process.env.TRADE_WS_LOG_MAX_LINES || 4000);
const TRIM_BYTE_HINT = Number(process.env.ACTIVITY_LOG_TRIM_BYTES || 2_000_000);

/** WS hello / trades_snapshot: how many rows to merge from trade-ws-events.jsonl (per mode). */
export const TRADE_HISTORY_SNAPSHOT_MAX = Math.max(
  100,
  Math.min(20_000, Number(process.env.TRADE_HISTORY_SNAPSHOT_MAX || MAX_TRADE_WS_LINES)),
);

/** @param {string} [persistenceSlug] data/modes/<slug>/; defaults to active UI mode slug */
export function resolveActivityLogPath(persistenceSlug) {
  const r = process.env.ACTIVITY_LOG_PATH;
  if (r && String(r).trim()) {
    const s = String(r).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const slug = persistenceSlug != null && String(persistenceSlug).trim()
    ? String(persistenceSlug).trim()
    : getTradingModePersistenceSlug();
  maybeMigrateLegacyModeFiles(slug);
  return path.join(resolveModeDataRootDir(), slug, "activity-log.jsonl");
}

/** @param {string} [persistenceSlug] */
export function resolveTradeWsLogPath(persistenceSlug) {
  const r = process.env.TRADE_WS_LOG_PATH;
  if (r && String(r).trim()) {
    const s = String(r).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const slug = persistenceSlug != null && String(persistenceSlug).trim()
    ? String(persistenceSlug).trim()
    : getTradingModePersistenceSlug();
  maybeMigrateLegacyModeFiles(slug);
  return path.join(resolveModeDataRootDir(), slug, "trade-ws-events.jsonl");
}

function ensureDirForFile(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function trimJsonlTail(p, maxLines) {
  try {
    const st = fs.statSync(p);
    if (st.size < TRIM_BYTE_HINT) return;
    const txt = fs.readFileSync(p, "utf8");
    const lines = txt.split("\n").filter((line) => line.trim().length);
    if (lines.length <= maxLines) return;
    const keep = lines.slice(-maxLines);
    const tmp = `${p}.trim.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${keep.join("\n")}\n`, "utf8");
    fs.renameSync(tmp, p);
  } catch {
    /* ignore */
  }
}

/** @param {Record<string, unknown>} entry Must be JSON-serializable. @param {string} [persistenceSlug] */
export function appendActivityLogEntry(entry, persistenceSlug) {
  const p = resolveActivityLogPath(persistenceSlug);
  ensureDirForFile(p);
  const line = `${JSON.stringify(entry)}\n`;
  fs.appendFileSync(p, line, "utf8");
  trimJsonlTail(p, MAX_ACTIVITY_LINES);
}

/** Newest first (for UI). @param {number} [limit=500] @param {string} [persistenceSlug] */
export function readActivityLogRecent(limit = 500, persistenceSlug) {
  const p = resolveActivityLogPath(persistenceSlug);
  if (!fs.existsSync(p)) return [];
  const txt = fs.readFileSync(p, "utf8");
  const lines = txt.split("\n").filter((line) => line.trim().length);
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    try {
      out.push(JSON.parse(lines[i]));
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

/**
 * @param {Record<string, unknown>} payload Trade WS payload (OPEN/CLOSE, …)
 * @param {string} [persistenceSlug] When omitted, uses `payload.originTradingMode` → slug, else active mode slug.
 */
export function appendTradeWsEvent(payload, persistenceSlug) {
  let slug = persistenceSlug;
  if (slug == null || !String(slug).trim()) {
    const om = payload && typeof payload === "object" ? payload.originTradingMode : null;
    slug = om != null && String(om).trim() ? tradingModeToPersistenceSlug(String(om)) : getTradingModePersistenceSlug();
  } else {
    slug = String(slug).trim();
  }
  const p = resolveTradeWsLogPath(slug);
  ensureDirForFile(p);
  const row = { ...payload, _loggedAt: new Date().toISOString() };
  const line = `${JSON.stringify(row)}\n`;
  fs.appendFileSync(p, line, "utf8");
  trimJsonlTail(p, MAX_TRADE_WS_LINES);
}

/** Oldest first for merging with exchange `getTrades`. @param {number} [limit=400] @param {string} [persistenceSlug] */
export function readTradeWsEvents(limit = 400, persistenceSlug) {
  const p = resolveTradeWsLogPath(persistenceSlug);
  if (!fs.existsSync(p)) return [];
  const txt = fs.readFileSync(p, "utf8");
  const lines = txt.split("\n").filter((line) => line.trim().length);
  const slice = lines.slice(Math.max(0, lines.length - limit));
  const out = [];
  for (const line of slice) {
    try {
      const o = JSON.parse(line);
      delete o._loggedAt;
      out.push(o);
    } catch {
      /* skip */
    }
  }
  return out;
}

function tradeTsSortMs(t) {
  const raw = t?.ts ?? t?.exitTs;
  if (raw == null) return 0;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  const ms = Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Stable key for merge map:
 * - Binance USD-M CLOSE: `meta.tranId` → `close_tran:…` (unique vs OPEN position id).
 * - Paper futures CLOSE reuses the position id as `id` (same string as OPEN); without a tranId,
 *   falling back to `String(id)` would collide with OPEN and drop one leg — use `close_id:…`.
 * - Binance USD-M OPEN: `id` is often `fut_<SYMBOL>` (one per symbol for position linking), so **not**
 *   unique per round-trip — key by `meta.orderId` (exchange entry order id) when present.
 */
function tradeMergeKey(t) {
  if (!t) return null;
  if (String(t.type) === "CLOSE") {
    const tid =
      t.meta?.tranId ??
      (Array.isArray(t.meta?.tranIds) && t.meta.tranIds.length
        ? t.meta.tranIds[t.meta.tranIds.length - 1]
        : null);
    if (tid != null && String(tid) !== "") return `close_tran:${String(tid)}`;
    if (t.id != null && String(t.id) !== "") return `close_id:${String(t.id)}`;
    return null;
  }
  if (String(t.type) === "OPEN") {
    const oid =
      t.meta?.orderId ?? t.meta?.binanceOrderId ?? t.meta?.exchangeOrderId ?? t.meta?.entryOrderId;
    if (oid != null && String(oid).trim() !== "") return `open_ord:${String(oid).trim()}`;
  }
  if (t.id != null && String(t.id) !== "") return String(t.id);
  return null;
}

export function mergeTradesById(tradeWsEvents, exchangeTrades) {
  const m = new Map();
  for (const t of tradeWsEvents || []) {
    const k = tradeMergeKey(t);
    if (k) m.set(k, t);
  }
  for (const t of exchangeTrades || []) {
    const k = tradeMergeKey(t);
    if (k) m.set(k, t);
  }
  return Array.from(m.values()).sort((a, b) => {
    const ta = tradeTsSortMs(a);
    const tb = tradeTsSortMs(b);
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
}

/**
 * Per-mode persisted `trade-ws-events.jsonl` + in-memory/exchange `getTrades()` (same merge as WS hello).
 * @param {string} mode TRADING_MODE
 * @param {unknown[]} exchangeTrades
 */
export function mergePersistedTradesWithExchange(mode, exchangeTrades) {
  const slug = tradingModeToPersistenceSlug(mode);
  const fromAudit = readTradeWsEvents(TRADE_HISTORY_SNAPSHOT_MAX, slug);
  const merged = filterStrictPortfolioTradesAfterMerge(
    mode,
    mergeTradesById(fromAudit, exchangeTrades || []),
  );
  return merged.slice(-TRADE_HISTORY_SNAPSHOT_MAX);
}
