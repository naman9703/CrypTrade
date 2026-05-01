# L2 — Frontend UI

## Stack

- **Vite + React 19 + Tailwind + Zustand.**
- Charts: **lightweight-charts** (see `ChartPanel.tsx`).

## State & realtime

- **`frontend/src/ws/store.ts`** — WebSocket to backend; merges `hello`/`state`/`market`/`depth`; **per-symbol market coalescing** on flush; `chartDisplaySymbol`, `bot`, `candles`, `depth`.
- **`frontend/src/api/client.ts`** — REST (mode, botConfig, candles, …).

## Major UI surfaces

- **`ChartPanel.tsx`** — Chart + integrates order book area; alt chart REST+WS merge helpers as needed.
- **`TradingPanel.tsx`**, **`PortfolioPanel.tsx`**, **`OrderBookPanel.tsx`** — Book uses `depth` + `chartDisplaySymbol ?? bot.symbol` for symbol alignment.
- **Auth:** `AuthShell` / session-aware mode (must match backend session trading mode for WS frames).

## Pitfalls

- **`market`:** Never coalesce multiple symbols into one pending payload (fixed: Map by symbol).
- **Depth vs chart:** Mismatch shows “catching up”; backend should `depth.setSymbol` on focus where implemented.
- **Background tabs:** rAF throttling; backend uses microtask coalesce for market commits.
