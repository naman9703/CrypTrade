export function attachWs({ wss, appState }) {
  const clients = new Set();

  const hub = {
    broadcast(type, payload) {
      const msg = JSON.stringify({ type, payload });
      for (const ws of clients) {
        if (ws.readyState === ws.OPEN) ws.send(msg);
      }
    },
  };
  appState.wsHub = hub;

  wss.on("connection", (ws) => {
    clients.add(ws);

    // Send hello + initial trade history so UI isn't empty on connect
    (async () => {
      try {
        const [account, positions, trades] = await Promise.all([
          appState.exchange.getAccount().catch(() => null),
          appState.exchange.getPositions().catch(() => []),
          appState.exchange.getTrades().catch(() => []),
        ]);
        ws.send(
          JSON.stringify({
            type: "hello",
            payload: {
              serverTs: new Date().toISOString(),
              state: appState.bot.getPublicState(),
              mode: appState.mode,
              account,
              positions,
            },
          })
        );
        // Replay recent trades so trade history table isn't empty
        const recent = (trades || []).slice(-100);
        if (recent.length > 0) {
          ws.send(JSON.stringify({ type: "trades_snapshot", payload: recent }));
        }
      } catch {
        ws.send(
          JSON.stringify({
            type: "hello",
            payload: { serverTs: new Date().toISOString(), state: appState.bot.getPublicState(), mode: appState.mode },
          })
        );
      }
    })();

    // periodic heartbeat/state so UI can show feed health even if market messages are sparse
    const id = setInterval(() => {
      try {
        Promise.all([appState.exchange.getAccount(), appState.exchange.getPositions()])
          .then(([account, positions]) => {
            ws.send(
              JSON.stringify({
                type: "state",
                payload: { mode: appState.mode, ...appState.bot.getPublicState(), account, positions },
              })
            );
          })
          .catch(() => {
            ws.send(
              JSON.stringify({
                type: "state",
                payload: { mode: appState.mode, ...appState.bot.getPublicState(), account: null, positions: [] },
              })
            );
          });
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

