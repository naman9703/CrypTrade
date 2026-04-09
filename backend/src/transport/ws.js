import {
  appendTradeWsEvent,
  mergeTradesById,
  readActivityLogRecent,
  readTradeWsEvents,
  TRADE_HISTORY_SNAPSHOT_MAX,
} from "../lib/activityPersistence.js";
import { isStrictBinanceAccountMode } from "../lib/tradingModePersistence.js";
import { filterStrictPortfolioTradesAfterMerge } from "../lib/tradeLedgerClassification.js";

/** @type {((payload: unknown) => void) | null} */
let telegramTradeHook = null;

/** Optional: trade OPEN/CLOSE → Telegram queue (non-blocking for execution paths). */
export function setTelegramTradeHook(fn) {
  telegramTradeHook = typeof fn === "function" ? fn : null;
}

export function attachWs({ wss, appState }) {
  const clients = new Set();

  const hub = {
    broadcast(type, payload) {
      if (type === "trade" && payload && typeof payload === "object") {
        try {
          appendTradeWsEvent(payload);
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
      }
      const msg = JSON.stringify({ type, payload });
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(msg);
      }
    },
  };
  appState.wsHub = hub;
  try {
    appState.bot.setWsHub?.(hub);
  } catch {
    // ignore
  }

  wss.on("connection", (ws) => {
    clients.add(ws);

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
        const activityLog = readActivityLogRecent(500);
        ws.send(
          JSON.stringify({
            type: "hello",
            payload: {
              serverTs: new Date().toISOString(),
              state: appState.bot.getPublicState(),
              mode: appState.mode,
              account,
              positions: Array.isArray(positions) ? positions : [],
              chart,
              activityLog,
            },
          })
        );
        const fromAudit = strictAcc && account == null ? [] : readTradeWsEvents(TRADE_HISTORY_SNAPSHOT_MAX);
        const merged = filterStrictPortfolioTradesAfterMerge(
          appState.mode,
          mergeTradesById(fromAudit, trades || [])
        );
        const recent = merged.slice(-TRADE_HISTORY_SNAPSHOT_MAX);
        if (strictAcc && account == null) {
          ws.send(JSON.stringify({ type: "trades_snapshot", payload: { replace: true, trades: [] } }));
        } else if (recent.length > 0) {
          ws.send(JSON.stringify({ type: "trades_snapshot", payload: { replace: true, trades: recent } }));
        }
      } catch {
        let chart = null;
        try {
          chart = appState.bot.getChartSnapshot({ hours: 24 });
        } catch {
          chart = null;
        }
        const activityLogFallback = readActivityLogRecent(500);
        const strictFallback = isStrictBinanceAccountMode(appState.mode);
        ws.send(
          JSON.stringify({
            type: "hello",
            payload: {
              serverTs: new Date().toISOString(),
              state: appState.bot.getPublicState(),
              mode: appState.mode,
              ...(strictFallback ? { account: null, positions: [] } : {}),
              chart,
              activityLog: activityLogFallback,
            },
          })
        );
        try {
          if (strictFallback) {
            ws.send(JSON.stringify({ type: "trades_snapshot", payload: { replace: true, trades: [] } }));
          } else {
            const fromAudit = readTradeWsEvents(TRADE_HISTORY_SNAPSHOT_MAX);
            if (fromAudit.length) {
              ws.send(
                JSON.stringify({
                  type: "trades_snapshot",
                  payload: { replace: true, trades: fromAudit.slice(-TRADE_HISTORY_SNAPSHOT_MAX) },
                })
              );
            }
          }
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
              payload: { mode: appState.mode, ...appState.bot.getPublicState() },
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

