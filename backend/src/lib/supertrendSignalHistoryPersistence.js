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
  resolveModeScopedDir,
} from "./tradingModePersistence.js";

const MAX_LINES = Number(process.env.SUPERTREND_SIGNAL_HISTORY_MAX_LINES || 8000);
const TRIM_BYTE_HINT = Number(process.env.SUPERTREND_SIGNAL_HISTORY_TRIM_BYTES || 2_000_000);

export function resolveSupertrendSignalHistoryPath() {
  const r = process.env.SUPERTREND_SIGNAL_HISTORY_PATH;
  if (r && String(r).trim()) {
    const s = String(r).trim();
    return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
  }
  const slug = getTradingModePersistenceSlug();
  maybeMigrateLegacyModeFiles(slug);
  return path.join(resolveModeScopedDir(), "supertrend-signal-history.jsonl");
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

function cleanRow(e) {
  if (!e || typeof e !== "object") return null;
  if (e.side !== "BUY" && e.side !== "SELL") return null;
  if (!Number.isFinite(Number(e.ts))) return null;
  return {
    ts: Number(e.ts),
    side: e.side,
    symbol: String(e.symbol || "").toUpperCase(),
    timeframe: String(e.timeframe || ""),
    aiGate: e.aiGate != null && Number.isFinite(Number(e.aiGate)) ? Number(e.aiGate) : null,
    strength: e.strength != null && Number.isFinite(Number(e.strength)) ? Number(e.strength) : null,
    stAction: e.stAction != null ? String(e.stAction) : null,
  };
}

/** @param {ReturnType<cleanRow>} entry */
export function appendSupertrendSignalHistoryEntry(entry) {
  const cleaned = cleanRow(entry);
  if (!cleaned?.symbol || !cleaned.timeframe) return;
  const p = resolveSupertrendSignalHistoryPath();
  ensureDirForFile(p);
  const row = { ...cleaned, _loggedAt: new Date().toISOString() };
  const line = `${JSON.stringify(row)}\n`;
  fs.appendFileSync(p, line, "utf8");
  trimJsonlTail(p, MAX_LINES);
}

/**
 * One-time: copy last-10 buffer from legacy bot-trading-config into jsonl when the jsonl is empty.
 */
export function maybeMigrateLegacySupertrendSignalHistory() {
  const p = resolveSupertrendSignalHistoryPath();
  try {
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return;
    const raw = readBotTradingConfig();
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
 * @param {{ symbol: string; timeframe: string; limit?: number }} opts
 * @returns {Array<{ ts: number; side: 'BUY'|'SELL'; aiGate: number|null; strength: number|null; stAction: string|null }>}
 */
export function readSupertrendSignalHistory({ symbol, timeframe, limit = 2000 }) {
  const p = resolveSupertrendSignalHistoryPath();
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
      if (String(o.symbol || "").toUpperCase() !== sym) continue;
      if (String(o.timeframe || "") !== tf) continue;
      if (o.side !== "BUY" && o.side !== "SELL") continue;
      if (!Number.isFinite(Number(o.ts))) continue;
      out.push({
        ts: Number(o.ts),
        side: o.side,
        aiGate: o.aiGate != null && Number.isFinite(Number(o.aiGate)) ? Number(o.aiGate) : null,
        strength: o.strength != null && Number.isFinite(Number(o.strength)) ? Number(o.strength) : null,
        stAction: o.stAction != null ? String(o.stAction) : null,
      });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out.slice(-take);
}
