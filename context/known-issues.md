# Known issues & env pitfalls (registry)

Keep short; add dated rows when regressions appear.

| Topic | Note |
|-------|------|
| Stream cap | `BINANCE_COMBINED_MAX_STREAMS` — not every “selected” universe coin has a live WS slot simultaneously. |
| Session mode | UI session trading mode must match server routing or `market`/`state` may not arrive. |
| Demo vs live hosts | Demo: `demo-fapi` + `fstream.binancefuture.com`; Live: `fapi` + `fstream.binance.com` — don’t swap. |
| Depth empty (futures) | Was often `b`/`a` vs `bids`/`asks` parse; confirm `/public` base if migrating URLs. |
| Slippage false positives | Was often stale kline tail vs fresh REST; mitigated by `/market` klines + REST bar anchor for slip ref. |

**Resolved / reference:** Client market coalescing Map-by-symbol; USD-M WS routing module; order book futures field names.
