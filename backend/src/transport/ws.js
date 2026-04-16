import {
  appendTradeWsEvent,
  mergePersistedTradesWithExchange,
  readActivityLogRecent,
  TRADE_HISTORY_SNAPSHOT_MAX,
} from "../lib/activityPersistence.js";
import {
  getTradingModePersistenceSlug,
  isStrictBinanceAccountMode,
  tradingModeToPersistenceSlug,
} from "../lib/tradingModePersistence.js";
import { uiAuthEnabled } from "../auth/uiGate.js";
import { normalizeTradingMode } from "../state/appState.js";

/** @type {((payload: unknown) => void) | null} */
let telegramTradeHook = null;

/** Optional: trade OPEN/CLOSE → Telegram queue (non-blocking for execution paths). */
export function setTelegramTradeHook(fn) {
  telegramTradeHook = typeof fn === "function" ? fn : null;
}

/**
 * Build hello + merged trades for one engine (per browser session trading mode when UI auth is on).
 * @param {Record<string, unknown>} extraHelloFields e.g. uiUserTag, perSessionTradingMode
 */
async function snapshotHelloForView(appState, viewMode, extraHelloFields = {}) {
  const m = normalizeTradingMode(viewMode);
  appState.ensureEngine(m);
  const row = appState.getEngine(m);
  if (!row?.bot) throw new Error(`engine_missing:${m}`);
  const { bot, exchange: ex } = row;
  const account = await ex.getAccount().catch(() => null);
  const strictAcc = isStrictBinanceAccountMode(m);
  const positions = account == null ? [] : await ex.getPositions().catch(() => []);
  let trades = [];
  if (!strictAcc || account != null) {
    trades = await ex.getTrades().catch(() => []);
  }
  let chart = null;
  try {
    chart = bot.getChartSnapshot({ hours: 24 });
  } catch {
    chart = null;
  }
  const activityLog = readActivityLogRecent(500, tradingModeToPersistenceSlug(m));
  /** Even when strict mode cannot fetch account/exchange trades, merge persisted audit file so history is visible. */
  const mergedTrades = mergePersistedTradesWithExchange(m, trades || []);
  const hello = {
    serverTs: new Date().toISOString(),
    state: bot.getPublicState(),
    mode: m,
    runningByMode: appState.getRunningByMode?.() ?? {},
    account,
    positions: Array.isArray(positions) ? positions : [],
    chart,
    activityLog,
    ...extraHelloFields,
  };
  return { hello, trades: mergedTrades };
}

function clientViewMode(ws, globalActive) {
  return String(ws._clientTradingMode ?? globalActive).toUpperCase();
}

export function attachWs({ wss, appState }) {
  const clients = new Set();

  /** Long-lived WS through nginx/CDN/NAT: RFC ping/pong so the TCP session stays “active” (tiny frames, no app JSON). */
  const rawPingMs = String(process.env.WS_PING_INTERVAL_MS ?? "").trim();
  const pingMs = Number(rawPingMs || 30_000);
  const pingIntervalMs =
    Number.isFinite(pingMs) && pingMs > 0 ? Math.min(120_000, Math.max(10_000, pingMs)) : 0;
  let pingTimer = null;
  if (pingIntervalMs > 0) {
    pingTimer = setInterval(() => {
      for (const ws of clients) {
        if (ws.readyState !== ws.OPEN) continue;
        if (ws._tradingPongOk === false) {
          try {
            ws.terminate();
          } catch {
            /* ignore */
          }
          continue;
        }
        ws._tradingPongOk = false;
        try {
          ws.ping();
        } catch {
          /* ignore */
        }
      }
    }, pingIntervalMs);
    pingTimer.unref?.();
  }

  const hub = {
    broadcast(type, payload) {
      const active = String(appState.mode || "PAPER").toUpperCase();
      const originRaw =
        payload && typeof payload === "object"
          ? payload.mode ?? payload.tradingMode ?? payload.originTradingMode
          : null;
      const origin =
        originRaw != null && String(originRaw).trim() ? String(originRaw).toUpperCase() : active;

      if (type === "trade" && payload && typeof payload === "object") {
        try {
          const slug =
            payload.originTradingMode != null && String(payload.originTradingMode).trim()
              ? tradingModeToPersistenceSlug(String(payload.originTradingMode))
              : getTradingModePersistenceSlug();
          appendTradeWsEvent(payload, slug);
        } catch {
          /* ignore */
        }
        if (telegramTradeHook) {
          try {
            telegramTradeHook(payload);
          } catch {
            /* must not break WS */
          }
        }
        const msg = JSON.stringify({ type, payload });
        for (const ws of clients) {
          if (ws.readyState !== ws.OPEN) continue;
          if (origin !== clientViewMode(ws, active)) continue;
          ws.send(msg);
        }
        return;
      }

      if (type === "state" || type === "market" || type === "depth" || type === "external") {
        const msg = JSON.stringify({ type, payload });
        for (const ws of clients) {
          if (ws.readyState !== ws.OPEN) continue;
          if (origin !== clientViewMode(ws, active)) continue;
          ws.send(msg);
        }
        return;
      }

      if (type === "trades_snapshot") {
        const msg = JSON.stringify({ type, payload });
        for (const ws of clients) {
          if (ws.readyState !== ws.OPEN) continue;
          if (origin !== clientViewMode(ws, active)) continue;
          ws.send(msg);
        }
        return;
      }

      if (type === "log" && payload && payload.tradingMode) {
        const tm = String(payload.tradingMode).toUpperCase();
        const msg = JSON.stringify({ type, payload });
        for (const ws of clients) {
          if (ws.readyState !== ws.OPEN) continue;
          if (tm !== clientViewMode(ws, active)) continue;
          ws.send(msg);
        }
        return;
      }

      const msg = JSON.stringify({ type, payload });
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(msg);
      }
    },

    /**
     * After POST /api/mode/set (session scope), refresh this login’s WebSockets to the new engine snapshot.
     * @param {string} sessionId express-session id
     * @param {string} mode trading mode slug
     */
    notifySessionTradingMode(sessionId, mode) {
      if (!sessionId) return;
      const m = normalizeTradingMode(mode);
      for (const ws of clients) {
        if (ws._sessionId !== sessionId) continue;
        ws._clientTradingMode = m;
        void (async () => {
          try {
            const extra = {};
            if (ws._uiUserTag) extra.uiUserTag = ws._uiUserTag;
            if (uiAuthEnabled()) extra.perSessionTradingMode = true;
            const { hello, trades } = await snapshotHelloForView(appState, m, extra);
            ws.send(JSON.stringify({ type: "hello", payload: hello }));
            ws.send(
              JSON.stringify({
                type: "trades_snapshot",
                payload: {
                  replace: true,
                  trades: trades.slice(-TRADE_HISTORY_SNAPSHOT_MAX),
                  mode: m,
                },
              }),
            );
          } catch {
            /* ignore */
          }
        })();
      }
    },
  };
  appState.wsHub = hub;
  try {
    appState.wireAllEnginesToWsHub?.(hub);
  } catch {
    try {
      appState.bot.setWsHub?.(hub);
    } catch {
      // ignore
    }
  }

  wss.on("connection", (ws, request) => {
    clients.add(ws);
    ws._tradingPongOk = true;

    const globalM = String(appState.mode || "PAPER").toUpperCase();
    let viewMode = globalM;
    if (uiAuthEnabled() && request?.session?.uiAuthOk && request.session?.uiTradingMode) {
      viewMode = normalizeTradingMode(request.session.uiTradingMode);
    }
    ws._clientTradingMode = normalizeTradingMode(viewMode);
    ws._sessionId = request?.sessionID || null;
    ws._uiUserTag = request?.session?.uiUserTag || null;

    ws.on("pong", () => {
      ws._tradingPongOk = true;
    });

    void (async () => {
      try {
        const extra = {};
        if (ws._uiUserTag) extra.uiUserTag = ws._uiUserTag;
        if (uiAuthEnabled() && request?.session?.uiAuthOk) extra.perSessionTradingMode = true;
        const { hello, trades } = await snapshotHelloForView(appState, ws._clientTradingMode, extra);
        ws.send(JSON.stringify({ type: "hello", payload: hello }));
        ws.send(
          JSON.stringify({
            type: "trades_snapshot",
            payload: {
              replace: true,
              trades: trades.slice(-TRADE_HISTORY_SNAPSHOT_MAX),
              mode: ws._clientTradingMode,
            },
          }),
        );
      } catch {
        try {
          const m = normalizeTradingMode(ws._clientTradingMode);
          const activityLogFallback = readActivityLogRecent(500, tradingModeToPersistenceSlug(m));
          const strictFallback = isStrictBinanceAccountMode(m);
          const row = appState.getEngine(m);
          const bot = row?.bot;
          const extra = {};
          if (ws._uiUserTag) extra.uiUserTag = ws._uiUserTag;
          if (uiAuthEnabled() && request?.session?.uiAuthOk) extra.perSessionTradingMode = true;
          let chart = null;
          try {
            chart = bot?.getChartSnapshot?.({ hours: 24 }) ?? null;
          } catch {
            chart = null;
          }
          ws.send(
            JSON.stringify({
              type: "hello",
              payload: {
                serverTs: new Date().toISOString(),
                state: bot?.getPublicState?.() ?? {},
                mode: m,
                runningByMode: appState.getRunningByMode?.() ?? {},
                ...(strictFallback ? { account: null, positions: [] } : {}),
                chart,
                activityLog: activityLogFallback,
                ...extra,
              },
            }),
          );
          try {
            const snap = mergePersistedTradesWithExchange(m, []);
            ws.send(
              JSON.stringify({
                type: "trades_snapshot",
                payload: { replace: true, trades: snap, mode: m },
              }),
            );
          } catch {
            /* ignore */
          }
        } catch {
          /* ignore */
        }
      }
    })();

    const id = setInterval(() => {
      try {
        const m = String(ws._clientTradingMode || appState.mode).toUpperCase();
        const row = appState.getEngine(m);
        if (!row?.bot) return;
        ws.send(
          JSON.stringify({
            type: "state",
            payload: {
              mode: m,
              runningByMode: appState.getRunningByMode?.() ?? {},
              ...row.bot.getPublicState(),
            },
          }),
        );
      } catch {
        /* ignore */
      }
    }, 2000);

    const cleanup = () => {
      clients.delete(ws);
      clearInterval(id);
    };
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  });
}
