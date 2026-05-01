# Rules & invariants

- **Live real funds:** `BINANCE_LIVE_TRADING_ENABLED=1` and keys only after explicit operator choice; never assume paper.
- **Bar-close signals:** Do not fire Supertrend autotrade on partial klines (`k.x === false`) unless intentionally building a new strategy path.
- **Symbol discipline:** Normalize symbols (`normalizeSym` / uppercase USDT pairs); avoid mixing `BTC/USDT` wire vs `BTCUSDT` without sanitizers.
- **WS payloads:** Respect `originTradingMode` / client view mode; don’t broadcast secrets on public channels.
- **Execution pause:** Honor `feedExecutionPause` / staleness gates; don’t bypass with “fire order anyway” without product decision.
- **Trailing / SL:** Fee-aware breakeven and tier semantics are intentional; don’t silently widen SL “to fix” exchange errors without understanding -2021 / would-trigger paths.
- **Changes:** Match existing style; minimal diffs; no drive-by refactors or unsolicited `.md` unless asked.

## Anti-patterns

- USD-M klines on unrouted `fstream…/ws` only.
- Single-slot overwrite for multiple `market` WS symbols on the client.
- Parsing futures depth with only `bids`/`asks` (omit `b`/`a`).
- Using `BINANCE_FUTURES_WS_BASE` `/market` URL for **depth** without switching to `/public`.
