# L2 — Bot: strategy, execution, risk

## Supertrend & signals

- **Primary symbol:** `processSupertrendCandleClose` — only if `candle.symbol === state.symbol` and not deferred to parallel path; uses `feed.getCandles()`, bar `ts` match, `computeSupertrendSeries`, optional strict chart align.
- **Parallel multi-watch:** `parallelSupertrendWatchGate` (MULTIPLE + AUTO, or auto-multi unpinned, or ST_SIGNAL_FIRST sweep). **`maybeAutoMultiBarClose`** for primary **or** `computeFeedWatchSymbols()` members; **`evaluateSupertrendLastClosedBar`**; may REST-fetch klines if buffer too short.
- **Signal timing:** **Bar close** (`k.x`), not intrabar for standard autotrade.
- **Race guard:** `barCloseCandlesSnapshot` + `anchorBarTs` passed into `trySupertrendFuturesOrder` / spot so `await` work doesn’t shift “last” to next bar.

## Futures entry (`trySupertrendFuturesOrder`)

- Slippage / LIMIT_IOC caps vs **REST** book + mark; optional **REST kline close** for signal bar (`fetchUsdMKlineCloseAtOpenTime`) when WS tail could diverge.
- Gates: AI prob, signal strength, `marketDecisionBlocksOpen`, `moveQualityBlocksOpen`, capital caps, min notional, signal lag env, `feedExecutionPause`.

## Trailing / SL

- **`trailingStopLossAuto`**, modes (e.g. Supertrend vs fee ladder) in `lib/trailingStopLoss.js`, `lib/binanceUsdMTrailSlReplace.js`; exchange adapters place/replace SL; mark from cache or REST.
- Multi-leg: `feed.getCandlesForSymbol` for non-primary symbols when buffer exists.

## Exchange adapters

- **Live futures:** `binanceLiveFuturesUsdM.js` — REST `fapi.binance.com`, mark WS `/market`.
- **Demo:** `binanceDemoFuturesUsdM.js` — demo-fapi + `fstream.binancefuture.com`.
- **Paper:** `paperFutures.js` — simulated fills; may still use live **public** data depending on `MARKET_FEED`.

## Key env knobs (non-exhaustive)

- `MARKET_FEED`, `PAPER_MARKET_FEED`, `BINANCE_*_WS_BASE`, `BINANCE_COMBINED_MAX_STREAMS`, `BOT_TICK_MS`, `SUPERTREND_*`, `BINANCE_LIVE_TRADING_ENABLED`.

## Quick file index

| Concern | File |
|--------|------|
| Bar-close orchestration | `state/bot.js` (large) |
| ST math / chart align | `lib/supertrendChartAlign.js`, `strategy/supertrend.js` |
| REST book/mark | `lib/binanceUsdMBookTicker.js` |
| HTTP API surface | `transport/http.js` |
