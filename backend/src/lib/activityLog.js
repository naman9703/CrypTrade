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

/**
 * Activity payload when mark price hits a stop or take-profit (local enforcement, paper sim, …).
 * Caller passes `notifyActivity` from the bot tick into `markToMarket`.
 *
 * @param {{ hit: "SL"|"TP", symbol: string, markPx: number, stopLoss?: number|null, takeProfit?: number|null, mode?: string, venue?: string }} p
 */
export function buildRiskSlTpTriggerActivity(p) {
  const sym = String(p.symbol || "");
  const mk = Number(p.markPx);
  const mks = Number.isFinite(mk) ? mk.toFixed(4) : String(p.markPx ?? "");
  const label = p.hit === "SL" ? "Stop loss" : "Take profit";
  const sl = p.stopLoss != null && Number.isFinite(Number(p.stopLoss)) ? Number(p.stopLoss).toFixed(4) : "—";
  const tp = p.takeProfit != null && Number.isFinite(Number(p.takeProfit)) ? Number(p.takeProfit).toFixed(4) : "—";
  return {
    level: "info",
    msg: `${label} triggered · ${sym} @ mark ${mks} · SL ${sl} · TP ${tp}`,
    category: "risk",
    reason: p.hit === "SL" ? "stop_loss_trigger" : "take_profit_trigger",
    symbol: sym,
    detail: {
      hit: p.hit,
      markPx: p.markPx,
      stopLoss: p.stopLoss,
      takeProfit: p.takeProfit,
      mode: p.mode || "local_bracket",
      venue: p.venue,
    },
  };
}
