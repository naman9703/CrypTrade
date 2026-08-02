# MICRO_EVENT phase0 screen

- **Status:** scaffold complete — not certified for live deploy
- **Strategy:** tick-first microstructure event scalper (continuation default)
- **Sibling:** LIQ_CASCADE unchanged (fade / bar-close research stream)

## Delivered (v1)

- `microstructureSnapshot.js` — unified liq/OI/book/CVD/funding/coalesce bus
- `aggTradeRolling.js` — sub-minute CVD from aggTrade multiplex
- `orderBookMultiBinance.js` — depth20@100ms for up to 6 watch symbols
- `microEvent.js` — 6 detectors + confluence scorer + brackets
- `microEventLiveEngine.js` — tick executor (forceOrder + aggTrade hooks)
- Bot wiring, feed status, frontend panel/presets
- Research: `research-micro-event-tick-replay.mjs`, `backtest-validate-micro-event.mjs`

## Validation

Run from `backend/`:

```bash
SKIP_ENSURE=1 node scripts/backtest-validate-micro-event.mjs
DAYS=7 node scripts/research-micro-event-tick-replay.mjs
```

**Honest limitation:** historical replay uses 1m liq bar proxy; sub-minute CVD/book/OI deltas require vision tick ingest extension before promote language.

## Next (if reopen)

1. Ablation: one gate at a time (book only, OI only, etc.)
2. Extend vision ingest for aggTrade/book timeline merge
3. ≥30 OOS trades + gates pass before paper→live beyond smoke
