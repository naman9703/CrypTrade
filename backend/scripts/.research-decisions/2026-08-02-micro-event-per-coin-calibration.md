# MICRO_EVENT per-coin calibration — smoke run (checkpoint)

- Generated: 2026-08-02
- Hypothesis: isolated threshold ladder per coin on bar-close proxy replay (one change per combo)
- Script: `backend/scripts/research-micro-event-per-coin-optimize.mjs`
- Window: `FROM=2025-01-01 TO=2025-08-01` (smoke — full 2024–2026 run deferred; ~10min/sim)

## BTCUSDT (partial — 2/8 combos before timeout)

| Combo | OOS n | tw/wk | ret% | pfR |
|-------|-------|-------|------|-----|
| baseline | 0 | 0 | 0 | 0 |
| microEventMinConfluenceScore=45 | 0 | 0 | 0 | 0 |

## ETHUSDT / BNBUSDT

- Not reached in smoke run (each full sim ~10+ min on 7mo 1m window).

## Verdict

- **No preset updates applied** — no combo produced OOS trades in the smoke window; winner would remain baseline (identical across coins today).
- **Not certified** — 0 OOS trades fails frequency (≥2/wk) and n≥30 gates.
- **Next:** extend force_orders + 1m coverage; re-run optimizer with `MAX_COMBOS=24` on full `2024-06-01→2026-06-01` window; apply `APPLY_PRESETS=1` only when OOS n≥30, ret>0, pf≥1, gates pass.

## Infra delivered this session

- OI `.usdt` fix → live OI confirm layer unblocked
- `triggerEventTimeMs` / `tickToOrderLagMs` latency instrumentation
- Paper uPnL immediate + mark fallback + foreign-symbol stomp fix
- Trade History OPEN→CLOSE single row + live `grossPnl`
- Positions Slip% column (backend meta + frontend)
