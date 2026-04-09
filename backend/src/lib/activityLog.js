import { appendActivityLogEntry } from "./activityPersistence.js";

/** @type {((payload: { msg: string, level?: string, ts?: string, [k: string]: unknown }) => void) | null} */
let telegramActivityHook = null;

/** Optional: push Activity (non-blocking) to Telegram sidecar — never await network here. */
export function setTelegramActivityHook(fn) {
  telegramActivityHook = typeof fn === "function" ? fn : null;
}

/**
 * WebSocket Activity feed (Logs panel): one consistent payload shape.
 * Extra keys (detail, category, reason, …) are passed through for the UI.
 *
 * @param {{ broadcast?: (type: string, payload: unknown) => void }} wsHub
 * @param {{ level?: "info"|"warn"|"error", msg: string, [k: string]: unknown }} payload
 */
export function broadcastActivity(wsHub, payload) {
  if (!wsHub?.broadcast || payload?.msg == null) return;
  const { msg, level = "info", ...rest } = payload;
  const serverTs = new Date().toISOString();
  try {
    appendActivityLogEntry({ serverTs, level, msg: String(msg), ...rest });
  } catch {
    /* disk full / permissions — WS still works */
  }
  wsHub.broadcast("log", { level, msg: String(msg), ts: serverTs, ...rest });
  if (telegramActivityHook) {
    try {
      telegramActivityHook({ level, msg: String(msg), ts: serverTs, ...rest });
    } catch {
      /* sidecar must never break Activity */
    }
  }
}
