/**
 * Per-mode Supertrend flip history (chart list + state) under data/modes/<slug>/supertrend-signal-history.jsonl.
 * Separate from bot-trading-config.json so the file can grow without bloating UI config.
 */
import fs from "fs";
import path from "path";
import { readBotTradingConfig } from "./botTradingConfigStore.js";
import {
  getTradingModePersistenceSlug,
  maybeMigrateLegacyModeFiles,
  resolveModeDataRootDir,
} from "./tradingModePersistence.js";

const MAX_LINES = Number(process.env.SUPERTREND_SIGNAL_HISTORY_MAX_LINES || 8000);
const TRIM_BYTE_HINT = Number(process.env.SUPERTREND_SIGNAL_HISTORY_TRIM_BYTES || 2_000_000);

/** @param {string} [persistenceSlug] */
export function resolveSupertrendSignalHistoryPath(persistenceSlug) {
  const r = process.env.SUPERTREND_SIGNAL_HISTORY_PATH;
  if (r && String(r).trim()) {
    const s = String(r).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const slug =
    persistenceSlug != null && String(persistenceSlug).trim()
      ? String(persistenceSlug).trim()
      : getTradingModePersistenceSlug();
  maybeMigrateLegacyModeFiles(slug);
  return path.join(resolveModeDataRootDir(), slug, "supertrend-signal-history.jsonl");
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

/** Strip non-JSON / cap size for jsonl (full market decision snapshot). */
function sanitizeMarketDecisionSnapshotForDisk(m) {
  if (m == null || typeof m !== "object") return null;
  try {
    const s = JSON.stringify(m);
    if (s.length > 120_000) return null;
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function cleanRow(e) {
  if (!e || typeof e !== "object") return null;
  if (e.side !== "BUY" && e.side !== "SELL") return null;
  if (!Number.isFinite(Number(e.ts))) return null;
  const surf =
    e.surfPulse != null && Number.isFinite(Number(e.surfPulse)) ? Number(e.surfPulse) : null;
  const sbc =
    e.signalBarClose != null && Number.isFinite(Number(e.signalBarClose)) && Number(e.signalBarClose) > 0
      ? Number(e.signalBarClose)
      : null;
  const sbct =
    e.signalBarCloseTs != null && Number.isFinite(Number(e.signalBarCloseTs)) && Number(e.signalBarCloseTs) > 0
      ? Number(e.signalBarCloseTs)
      : null;
  const mqS = e.mqScore != null && Number.isFinite(Number(e.mqScore)) ? Number(e.mqScore) : null;
  const mqV = e.mqVerdict != null && String(e.mqVerdict).trim() ? String(e.mqVerdict).trim() : null;
  const mds = sanitizeMarketDecisionSnapshotForDisk(e.marketDecisionSnapshot);
  return {
    ts: Number(e.ts),
    side: e.side,
    symbol: String(e.symbol || "").toUpperCase(),
    timeframe: String(e.timeframe || ""),
    aiGate: e.aiGate != null && Number.isFinite(Number(e.aiGate)) ? Number(e.aiGate) : null,
    strength: e.strength != null && Number.isFinite(Number(e.strength)) ? Number(e.strength) : null,
    stAction: e.stAction != null ? String(e.stAction) : null,
    surfPulse: surf,
    ...(mqS != null ? { mqScore: mqS } : {}),
    ...(mqV != null ? { mqVerdict: mqV } : {}),
    ...(sbc != null ? { signalBarClose: sbc } : {}),
    ...(sbct != null ? { signalBarCloseTs: sbct } : {}),
    ...(mds ? { marketDecisionSnapshot: mds } : {}),
  };
}

/** @param {ReturnType<cleanRow>} entry @param {string} [persistenceSlug] */
export function appendSupertrendSignalHistoryEntry(entry, persistenceSlug) {
  const cleaned = cleanRow(entry);
  if (!cleaned?.symbol || !cleaned.timeframe) return;
  const p = resolveSupertrendSignalHistoryPath(persistenceSlug);
  ensureDirForFile(p);
  const row = { ...cleaned, _loggedAt: new Date().toISOString() };
  const line = `${JSON.stringify(row)}\n`;
  fs.appendFileSync(p, line, "utf8");
  trimJsonlTail(p, MAX_LINES);
}

/**
 * One-time: copy last-10 buffer from legacy bot-trading-config into jsonl when the jsonl is empty.
 */
/** @param {string} [persistenceSlug] */
export function maybeMigrateLegacySupertrendSignalHistory(persistenceSlug) {
  const p = resolveSupertrendSignalHistoryPath(persistenceSlug);
  try {
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return;
    const raw = readBotTradingConfig(persistenceSlug);
    const b = raw?.bot;
    if (!b || typeof b !== "object") return;
    const legacy = b.supertrendSignalHistory;
    if (!Array.isArray(legacy) || !legacy.length) return;
    const sym = typeof b.symbol === "string" ? b.symbol.trim().toUpperCase() : "BTCUSDT";
    const tf = typeof b.timeframe === "string" ? b.timeframe : "1m";
    const cleaned = legacy
      .map((e) =>
        cleanRow({
          ...e,
          symbol: sym,
          timeframe: tf,
        }),
      )
      .filter(Boolean);
    if (!cleaned.length) return;
    ensureDirForFile(p);
    const body = cleaned
      .map((row) => `${JSON.stringify({ ...row, _loggedAt: new Date().toISOString() })}\n`)
      .join("");
    const tmp = `${p}.migrate.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, p);
  } catch {
    /* ignore */
  }
}

/**
 * @param {{ symbol: string; timeframe: string; limit?: number; allSymbols?: boolean; persistenceSlug?: string }} opts
 * When `allSymbols` is true, every symbol in the jsonl for `timeframe` is included (multi-coin AUTO Supertrend).
 * @returns {Array<{ ts: number; side: 'BUY'|'SELL'; symbol: string; timeframe: string; aiGate: number|null; strength: number|null; stAction: string|null; surfPulse?: number|null }>}
 */
export function readSupertrendSignalHistory({ symbol, timeframe, limit = 2000, allSymbols = false, persistenceSlug }) {
  const p = resolveSupertrendSignalHistoryPath(persistenceSlug);
  if (!fs.existsSync(p)) return [];
  const sym = String(symbol || "").toUpperCase();
  const tf = String(timeframe || "");
  const take = Math.max(10, Math.min(50_000, Number(limit) || 2000));
  let txt;
  try {
    txt = fs.readFileSync(p, "utf8");
  } catch {
    return [];
  }
  const lines = txt.split("\n").filter((line) => line.trim().length);
  const out = [];
  for (const line of lines) {
    try {
      const o = JSON.parse(line);
      delete o._loggedAt;
      const rowSym = String(o.symbol || "").toUpperCase();
      if (!rowSym) continue;
      if (!allSymbols && rowSym !== sym) continue;
      if (String(o.timeframe || "") !== tf) continue;
      if (o.side !== "BUY" && o.side !== "SELL") continue;
      if (!Number.isFinite(Number(o.ts))) continue;
      const sbcR =
        o.signalBarClose != null && Number.isFinite(Number(o.signalBarClose)) && Number(o.signalBarClose) > 0
          ? Number(o.signalBarClose)
          : null;
      const sbctR =
        o.signalBarCloseTs != null && Number.isFinite(Number(o.signalBarCloseTs)) && Number(o.signalBarCloseTs) > 0
          ? Number(o.signalBarCloseTs)
          : null;
      const mqSR = o.mqScore != null && Number.isFinite(Number(o.mqScore)) ? Number(o.mqScore) : null;
      const mqVR = o.mqVerdict != null && String(o.mqVerdict).trim() ? String(o.mqVerdict).trim() : null;
      const mdsR = sanitizeMarketDecisionSnapshotForDisk(o.marketDecisionSnapshot);
      out.push({
        ts: Number(o.ts),
        side: o.side,
        symbol: rowSym,
        timeframe: String(o.timeframe || tf),
        aiGate: o.aiGate != null && Number.isFinite(Number(o.aiGate)) ? Number(o.aiGate) : null,
        strength: o.strength != null && Number.isFinite(Number(o.strength)) ? Number(o.strength) : null,
        stAction: o.stAction != null ? String(o.stAction) : null,
        surfPulse:
          o.surfPulse != null && Number.isFinite(Number(o.surfPulse)) ? Number(o.surfPulse) : null,
        ...(sbcR != null ? { signalBarClose: sbcR } : {}),
        ...(sbctR != null ? { signalBarCloseTs: sbctR } : {}),
        ...(mqSR != null ? { mqScore: mqSR } : {}),
        ...(mqVR != null ? { mqVerdict: mqVR } : {}),
        ...(mdsR ? { marketDecisionSnapshot: mdsR } : {}),
      });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  /** Same flip can be appended twice (legacy races / sweep+WS); keep one row per (ts, side, symbol, tf). */
  const dedup = new Map();
  for (const row of out) {
    const k = `${row.ts}|${row.side}|${row.symbol}|${row.timeframe}`;
    dedup.set(k, row);
  }
  const merged = [...dedup.values()].sort((a, b) => a.ts - b.ts);
  return merged.slice(-take);
}
