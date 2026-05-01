# AI context pack (this repo)

**Goal:** High-signal, low-token slices. Paste or `@`-reference only what the task needs.

## Layers (how to use)

| Layer | File | When to attach |
|-------|------|----------------|
| **L0** | `snapshot.md` | Almost every task |
| **L1** | `architecture.md` | New areas, refactors, onboarding |
| **L2** | `data-feed-ws.md` | Klines, multiplex, staleness, depth, Binance URLs |
| **L2** | `bot-strategy-execution.md` | Supertrend, orders, risk, trailing, multi-coin |
| **L2** | `frontend-ui.md` | Chart, WS store, panels, trading UI |
| **—** | `rules-invariants.md` | Safety, trading invariants, review gates |
| **—** | `known-issues.md` | Regressions, env pitfalls, caps |

**Prompt pattern:** `snapshot` + one L2 module + your task + constraints.

**Context IDs (for humans):** `SNAPSHOT`, `ARCH`, `MOD:FEED`, `MOD:BOT`, `MOD:UI`, `RULES`, `ISSUES`.

Refresh L0/L1 when stack or primary flows change; keep module files task-sized, not encyclopedic.
