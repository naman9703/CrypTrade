/**
 * Config-driven macro / listing event windows for MICRO_EVENT.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = path.resolve(__dirname, "../../../data/micro-event-calendar.json");

/** @type {{ ts: string, symbol?: string, eventType: string, directionHint?: string, blackoutMinutes?: number }[]} */
let cached = [];
let loadedAt = 0;

function loadCalendar(filePath = DEFAULT_PATH) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    cached = Array.isArray(parsed?.events) ? parsed.events : Array.isArray(parsed) ? parsed : [];
    loadedAt = Date.now();
  } catch {
    cached = [];
    loadedAt = Date.now();
  }
  return cached;
}

export function getMicroEventCalendarEntries() {
  if (!loadedAt) loadCalendar();
  return cached;
}

/**
 * @param {number} [nowMs]
 * @param {string} [symbol]
 */
export function getActiveMicroEventCalendarWindows(nowMs = Date.now(), symbol = "") {
  const sym = String(symbol || "").trim().toUpperCase();
  const entries = getMicroEventCalendarEntries();
  const active = [];
  for (const e of entries) {
    const ts = Date.parse(String(e.ts ?? ""));
    if (!Number.isFinite(ts)) continue;
    const blackoutMin = Math.max(0, Number(e.blackoutMinutes ?? 30));
    const windowMs = blackoutMin * 60_000;
    if (nowMs < ts - windowMs || nowMs > ts + windowMs) continue;
    const evSym = String(e.symbol ?? "").trim().toUpperCase();
    if (evSym && sym && evSym !== sym) continue;
    active.push({
      ...e,
      tsMs: ts,
      windowStartMs: ts - windowMs,
      windowEndMs: ts + windowMs,
    });
  }
  return active;
}

export function reloadMicroEventCalendar(filePath) {
  return loadCalendar(filePath ?? DEFAULT_PATH);
}
