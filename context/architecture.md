# L1 — System architecture (compressed)

```
[Browser]  ←HTTP/WS→  [Express backend]
                           │
         ┌─────────────────┼─────────────────┐
         ▼                 ▼                 ▼
   transport/http.js  transport/ws.js   auth/uiGate.js
         │                 │                 │
         ▼                 ▼                 ▼
   appState (engines     ws hub.broadcast   session / UI user
   per trading mode)     filtered by         tagging
                         originTradingMode
                         vs client view mode
```

**Backend layout (mental map)**

- **`state/appState.js`** — One “engine” row per trading mode; bot + exchange instance.
- **`state/bot.js`** — Monolithic bot: feed wiring, Supertrend bar-close, futures/spot order paths, trailing hooks, universe scan, config patches.
- **`state/marketFeed.js`** — Factory: `SYNTH` | Binance spot | Binance USD-M combined feed.
- **`state/marketFeedBinanceCombined.js`** — Kline multiplex + optional aggTrade; REST kline backfill; `onCandleClose` / `onPrimaryCandleLive`.
- **`state/orderBookBinance.js`** — USD-M/spot depth WS; futures payloads use `b`/`a` not only `bids`/`asks`.
- **`lib/binanceUsdmWsRoute.js`** — USD-M URL routing (`/market`, `/public`).
- **`svc/exchange/*`** — `paperFutures`, `binanceDemoFuturesUsdM`, `binanceLiveFuturesUsdM`, spot variants; REST + signed requests + mark-price WS on live/demo.
- **`strategy/*`, `lib/supertrend*.js`, `lib/trailingStopLoss.js`, `lib/binanceUsdM*.js`** — Indicators, trailing, Binance-specific order/SL helpers.

**Frontend**

- **`frontend/src/ws/store.ts`** — Zustand + WebSocket client; merges `state`/`market`/`depth`; **per-symbol coalescing** for `market` frames.
- **`frontend/src/ui/*`** — ChartPanel, TradingPanel, PortfolioPanel, OrderBookPanel, etc.
- **`frontend/src/api/client.ts`** — REST to backend.

**Data flow (trading)**

1. Combined Binance WS → candle buffers (`getCandles` / `getCandlesForSymbol`).
2. Closed kline (`k.x`) → `onCandleClose` → `processSupertrendCandleClose` (primary) and/or `maybeAutoMultiBarClose` (parallel watch).
3. Orders → exchange adapter `placeOrder` / `closePosition`; income/trades sync on strict Binance modes.

**Do not assume:** One global candle buffer per coin without checking watch caps and primary vs `getCandlesForSymbol`.
