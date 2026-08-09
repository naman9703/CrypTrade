# MICRO_EVENT BTC — concrete profitability path (2026-08-02)

## Problem → solution (no verdict theater)

| Failure | Fix shipped |
|---------|-------------|
| Small liq never clears ~0.13% RT cost | Trade only **≥ $2M** cascades |
| Mid-cascade re-entry bleeds | **Fresh-onset** gate (no prior 1m bucket ≥ liqMin in quiet window) |
| Hold ignored → almost all time_stops | Wire `microEventMaxHoldSec` → runner max-hold (**600s**) |
| Bar-open snapshot missed the minute’s liq | Evaluate at **bar close** |
| Dead trades (MFE≈0) held to −0.5R time_stop | **Displacement** on signal bar (≥0.05% with trade) + **dead-trade** compress SL to 0.3R if MFE < 0.2R after 2 bars |

## Locked sleeve: `MICRO_EVENT_BTC_1M_LIQ_ONLY`

- liqMin **$2M**, fresh onset, cooldown 900s, hold 600s
- `microEventRequireDisplacement: true` (0.05%)
- `intradayLiqDeadTradeExitBars: 2`, minMfeR 0.2, maxLossR 0.3
- Runner: `MICRO_EVENT` in dead-trade strategy set

## Evidence before this exit/displacement layer

FULL (2M+fresh+hold, costs): **n=6, +0.46%, pfR 1.29**. Losers were MFE≈0 dead entries — displacement + dead-trade target those.

## Next execution (when DB up)

```bash
cd backend && SKIP_ENSURE=1 node scripts/research-micro-event-btc-ablation.mjs
```

Expect: fewer/zero dead time_stops; keep TP winners; improve FULL pfR. Then keep collecting force_orders and re-measure OOS as coverage grows — **iterate exits/entry quality, do not N-crush**.
