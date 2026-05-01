# L0 — Project snapshot

**Name:** Full-stack crypto trading app (indicator-driven bot + UI).  
**Purpose:** Live/demo/paper trading with Supertrend (and related gates), Binance connectivity, charts, portfolio, risk/trailing.

**Stack:** Backend **Node (ESM)** + Express + `ws` + Zod; Frontend **React 19** + Vite + Tailwind + Zustand + lightweight-charts.

**Modes:** `PAPER` | `BINANCE_DEMO_API` | `BINANCE_TESTNET` | `BINANCE_LIVE` (live needs explicit enable + keys).

**Core flows:** Binance **routed** USD-M WS (`/market` kline+aggTrade, `/public` depth) → per-symbol buffers → **bar-close** Supertrend evaluation → futures/spot execution adapters → UI via HTTP + app WebSocket (`hello`, `state`, `market`, `depth`, …).

**Multi-coin:** Multiplex klines + capped watch list (`BINANCE_COMBINED_MAX_STREAMS`, default ~12); signals on **closed** bars per subscribed symbol.

**Constraints:** Fee-aware trailing/SL; slippage/mark guards on futures entry; feed staleness can pause execution; session vs global trading mode can filter WS payloads.

**Non-goals here:** Full file map — use `architecture.md` or grep when implementing.
