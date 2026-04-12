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

/** @type {((payload: unknown) => void) | null} */
let telegramTradeHook = null;

/** Optional: trade OPEN/CLOSE → Telegram queue (non-blocking for execution paths). */
export function setTelegramTradeHook(fn) {
  telegramTradeHook = typeof fn === "function" ? fn : null;
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
        if (origin !== active) return;
      }

      if (
        (type === "state" || type === "market" || type === "depth" || type === "external") &&
        origin !== active
      ) {
        return;
      }

      if (type === "log" && payload && payload.tradingMode && String(payload.tradingMode).toUpperCase() !== active) {
        return;
      }

      const msg = JSON.stringify({ type, payload });
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(msg);
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

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws._tradingPongOk = true;
    ws.on("pong", () => {
      ws._tradingPongOk = true;
    });

    // Send hello + initial trade history so UI isn't empty on connect
    (async () => {
      try {
        const account = await appState.exchange.getAccount().catch(() => null);
        const strictAcc = isStrictBinanceAccountMode(appState.mode);
        const positions =
          account == null ? [] : await appState.exchange.getPositions().catch(() => []);
        let trades = [];
        if (!strictAcc || account != null) {
          trades = await appState.exchange.getTrades().catch(() => []);
        }
        let chart = null;
        try {
          chart = appState.bot.getChartSnapshot({ hours: 24 });
        } catch {
          chart = null;
        }
        const activityLog = readActivityLogRecent(500, getTradingModePersistenceSlug());
        ws.send(
          JSON.stringify({
            type: "hello",
            payload: {
              serverTs: new Date().toISOString(),
              state: appState.bot.getPublicState(),
              mode: appState.mode,
              runningByMode: appState.getRunningByMode?.() ?? {},
              account,
              positions: Array.isArray(positions) ? positions : [],
              chart,
              activityLog,
            },
          })
        );
        const recent =
          strictAcc && account == null
            ? []
            : mergePersistedTradesWithExchange(appState.mode, trades || []);
        ws.send(
          JSON.stringify({
            type: "trades_snapshot",
            payload: { replace: true, trades: recent },
          }),
        );
      } catch {
        let chart = null;
        try {
          chart = appState.bot.getChartSnapshot({ hours: 24 });
        } catch {
          chart = null;
        }
        const activityLogFallback = readActivityLogRecent(500, getTradingModePersistenceSlug());
        const strictFallback = isStrictBinanceAccountMode(appState.mode);
        ws.send(
          JSON.stringify({
            type: "hello",
            payload: {
              serverTs: new Date().toISOString(),
              state: appState.bot.getPublicState(),
              mode: appState.mode,
              runningByMode: appState.getRunningByMode?.() ?? {},
              ...(strictFallback ? { account: null, positions: [] } : {}),
              chart,
              activityLog: activityLogFallback,
            },
          })
        );
        try {
          const snap =
            strictFallback ? [] : mergePersistedTradesWithExchange(appState.mode, []);
          ws.send(JSON.stringify({ type: "trades_snapshot", payload: { replace: true, trades: snap } }));
        } catch {
          /* ignore */
        }
      }
    })();

    // periodic heartbeat/state so UI can show feed health even if market messages are sparse
    const id = setInterval(() => {
      try {
        // Do not poll account/positions here — bot `tick` already broadcasts enriched snapshots.
        // Pushing raw `getAccount()` every 2s overwrites UI equity / daily PnL and causes visible flicker.
        try {
          ws.send(
            JSON.stringify({
              type: "state",
              payload: {
                mode: appState.mode,
                runningByMode: appState.getRunningByMode?.() ?? {},
                ...appState.bot.getPublicState(),
              },
            })
          );
        } catch {
          /* ignore */
        }
      } catch {
        // ignore
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

