# L2 — Data layer: market feed & WebSockets

## Binance USD-M (live / demo / testnet)

- **Kline + aggTrade (multiplex):** Base must be **`…/market/ws`** or **`…/market/stream`**. Legacy unrouted `fstream…/ws` is public-only; klines may not update → stale UI + false slippage vs REST.
- **Depth (order book):** **`…/public/ws`** (partial book). Parser accepts `bids`/`asks` (spot-style) **and** `b`/`a` (futures).
- **Routing helper:** `backend/src/lib/binanceUsdmWsRoute.js` (`routeBinanceUsdmWsBase`, combined URL helper).
- **Coercion:** `marketFeedBinanceCombined.js` + `marketFeed.js` defaults/env rewritten toward `/market` for klines; depth uses `/public` in `bot.js` `binanceDepthWsBase`.

## App WebSocket (browser ↔ backend)

- **`transport/ws.js`:** `broadcast` for `state`, `market`, `depth`, `trade`, … filters by **`originTradingMode`** vs **`effectiveClientViewMode`** (per-session mode when UI auth on).
- **Risk:** Wrong mode pairing → client sees no `market`/`state` updates.

## Backend feed object

- **`createBinanceCombinedMarketFeed`:** Pushes partial + closed bars; **`onCandleClose` only if `k.x`**; throttled **`onPrimaryCandleLive`** for UI.
- **Staleness / reconnect:** `binanceFeedHealth.js`, `feed.requestReconnect`, execution pause when gate says data stale.

## Frontend `market` handling

- **`store.ts`:** Coalesce burst `market` messages **per normalized symbol**, flush applies frame matching **`chartDisplaySymbol ?? bot.symbol`** (avoids dropping alt chart updates when primary tick overwrites).

## Quick file index

| Concern | File |
|--------|------|
| Kline multiplex, subscribe URL | `state/marketFeedBinanceCombined.js` |
| Feed factory + env | `state/marketFeed.js` |
| Bot: depth base, tick broadcast | `state/bot.js` |
| Order book WS parse | `state/orderBookBinance.js` |
| Live mark-price socket | `svc/exchange/binanceLiveFuturesUsdM.js` (demo similar) |
