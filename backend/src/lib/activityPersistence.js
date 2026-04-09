/**
 * Append-only JSONL logs so Activity + trade WS payloads survive backend restarts.
 * Default paths are per TRADING_MODE under data/modes/<slug>/ (see tradingModePersistence.js).
 */
import fs from "fs";
import path from "path";
import {
  getTradingModePersistenceSlug,
  maybeMigrateLegacyModeFiles,
  resolveModeScopedDir,
} from "./tradingModePersistence.js";

const MAX_ACTIVITY_LINES = Number(process.env.ACTIVITY_LOG_MAX_LINES || 8000);
const MAX_TRADE_WS_LINES = Number(process.env.TRADE_WS_LOG_MAX_LINES || 4000);
const TRIM_BYTE_HINT = Number(process.env.ACTIVITY_LOG_TRIM_BYTES || 2_000_000);

/** WS hello / trades_snapshot: how many rows to merge from trade-ws-events.jsonl (per mode). */
export const TRADE_HISTORY_SNAPSHOT_MAX = Math.max(
  100,
  Math.min(20_000, Number(process.env.TRADE_HISTORY_SNAPSHOT_MAX || MAX_TRADE_WS_LINES)),
);

export function resolveActivityLogPath() {
  const r = process.env.ACTIVITY_LOG_PATH;
  if (r && String(r).trim()) {
    const s = String(r).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const slug = getTradingModePersistenceSlug();
  maybeMigrateLegacyModeFiles(slug);
  return path.join(resolveModeScopedDir(), "activity-log.jsonl");
}

export function resolveTradeWsLogPath() {
  const r = process.env.TRADE_WS_LOG_PATH;
  if (r && String(r).trim()) {
    const s = String(r).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const slug = getTradingModePersistenceSlug();
  maybeMigrateLegacyModeFiles(slug);
  return path.join(resolveModeScopedDir(), "trade-ws-events.jsonl");
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

/** @param {Record<string, unknown>} entry Must be JSON-serializable. */
export function appendActivityLogEntry(entry) {
  const p = resolveActivityLogPath();
  ensureDirForFile(p);
  const line = `${JSON.stringify(entry)}\n`;
  fs.appendFileSync(p, line, "utf8");
  trimJsonlTail(p, MAX_ACTIVITY_LINES);
}

/** Newest first (for UI). @param {number} [limit=500] */
export function readActivityLogRecent(limit = 500) {
  const p = resolveActivityLogPath();
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

/** @param {Record<string, unknown>} payload Trade WS payload (OPEN/CLOSE, …) */
export function appendTradeWsEvent(payload) {
  const p = resolveTradeWsLogPath();
  ensureDirForFile(p);
  const row = { ...payload, _loggedAt: new Date().toISOString() };
  const line = `${JSON.stringify(row)}\n`;
  fs.appendFileSync(p, line, "utf8");
  trimJsonlTail(p, MAX_TRADE_WS_LINES);
}

/** Oldest first for merging with exchange `getTrades`. @param {number} [limit=400] */
export function readTradeWsEvents(limit = 400) {
  const p = resolveTradeWsLogPath();
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

export function mergeTradesById(tradeWsEvents, exchangeTrades) {
  const m = new Map();
  for (const t of tradeWsEvents || []) {
    if (t?.id != null && String(t.id) !== "") m.set(String(t.id), t);
  }
  for (const t of exchangeTrades || []) {
    if (t?.id != null && String(t.id) !== "") m.set(String(t.id), t);
  }
  return Array.from(m.values()).sort((a, b) => {
    const ta = Number(a.ts ?? a.exitTs ?? 0);
    const tb = Number(b.ts ?? b.exitTs ?? 0);
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
}
