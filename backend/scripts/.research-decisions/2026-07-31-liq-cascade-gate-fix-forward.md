# LIQ_CASCADE — gate fix-forward + data quality (2026-07-31)

**Status:** `IN_PROGRESS` — root-cause gates fixed; edge signal on partial data; full live validation pending tick coverage.
**Change:** One concept — OI window gate + either confirm (not a filter stack).

## Root causes fixed

| Issue | Fix | Evidence |
|-------|-----|----------|
| Same-bar OI rose on peak liq → blocked spikes | `liqCascadeOiGateMode: window` (3 bars) | BTC OI pass 0→3; ETH 5→9 on near-miss funnel |
| Stall/reclaim-only confirm missed ETH cascades | `liqCascadeConfirmMode: either` + `confirmLiqBars: 2` | ETH raw signals 0→1 (Jul 30 13:43 SELL fade) |
| 30d replays on 1.5d ticks mislabeled | `computeLiqCascadeDataQuality()` in replay | `verdict: partial`, ~1.7d effective coverage |
| Replay import path wrong | Fixed `forceOrderPersist.js` path | 30d replay completes |

## Code touched

- `backend/src/strategy/techniques/liqCascade.js` — `resolveOiGate`, `oiWindowDropPct`, `confirmCascadeBar`, `liqExhaustionConfirm`
- `backend/src/strategy/liqCascadeDataQuality.js` — coverage metrics
- Presets BE/FE — window OI, either confirm, `force_orders` default
- `research-liq-cascade-last10h-signals.mjs` — data quality + funnel
- `research-liq-cascade-phase0.mjs` — uses `resolveOiGate`
- `.cursor/rules/liq-cascade-profitable-reliable.mdc` — fix-forward mandate

## 30d replay (partial data — label honestly)

| Coin | Tick days | Signals | Cascade-eligible |
|------|-----------|---------|------------------|
| BTC | 1.73 | 0 | 0 |
| ETH | 1.67 | **1** | **6** |
| BNB | 1.57 | 0 | 0 |

ETH signal: 2026-07-30 13:43 UTC, SELL fade, z=99, $395k short liq, OI window drop 0.20%.

## Phase0 (Jul 29–31, force_orders 5min, window OI)

| Symbol | events/wk | fade15 | fade60 |
|--------|-----------|--------|--------|
| BTC | 38.5 | 0.017% | **0.317%** |
| ETH | 56 | 0.021% | **0.529%** |
| BNB | 10.5 | -0.105% | -0.084% |

ETH/BTC **fade60 > 0.13% cost floor** on available sample — directionally supports premise. BNB thin (30 ticks).

## Full sim (ETH, same window)

n=1 OOS — **insufficient N for profitability verdict**. Not a strategy failure; data + sample size block.

## Next steps (ordered)

1. **Keep force_orders WS live** until ≥8 weeks/coin (`research-liq-cascade-force-orders-coverage.mjs`)
2. Re-run `backtest-validate-liq-cascade.mjs` when OOS n≥30 on force_orders window
3. If Jul 29 ETH 6 cascade-eligible still don't fire — autopsy confirm path per bar (one change if needed)
4. BNB: accumulate ticks; coin-native thresholds already in preset ($30k, z1.8)

## Do not

- Revert to same-bar OI without A/B
- Claim live-ready on 1.7d tick coverage
- Stack further gate changes before re-measuring this fix
