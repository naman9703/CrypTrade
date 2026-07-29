# MLCTS — Phase 0 screen (2026-07-29)

**Status:** `CHECKPOINT` — implementation complete; full WF+MC validation pending (run when DB up).
**Window:** 2025-01-01 → 2026-07-01 · TF 15m
**Script:** `backend/scripts/research-mlcts-phase0.mjs`

## Implemented

- Layer engine L1–L7 + composite score (cold-start manual weights per spec)
- Bar-close strategy `MLCTS` registered end-to-end (backtest + live paper)
- Live layer panel between Portfolio and Charts (`MlctsLayersPanel`)
- Per-trade feature vector logged via `mlctsContext` / `mlctsLayers` on signal

## Correctness audit (2026-07-29, post-implementation)

Layer-by-layer review found and fixed 3 bugs + 3 minor issues (correctness infra, pre-Phase0 rerun):

1. **L5 CVD divergence never fired** — `detectCvdDivergence` was called with bare
   `{ allowProxy: true }`; `divergenceLookback` undefined → `NaN` loop bounds → always false.
   Fixed: use `buildOrderFlowOpts({ intradayOfAllowProxy: true, timeframe: "15m" })`.
2. **L5 absorption gates were no-ops** — `absorptionVolMult` / `absorptionRangeAtrMult`
   undefined → `x < NaN` comparisons silently skipped vol/range requirements. Same fix.
3. **Live L6 starved of OI/funding** — synthetic series rows stamped `ts: Date.now()`,
   but `lookupSeriesAt` requires `ts <= bar open time` → lookup always null → L6 always
   "optional/missing". Fixed in `bot.js` + `buildMlctsLiveSnapshotFromBot` (`ts: 0`).
4. Composite `wBook` double-counted the whole L5 score; now uses dedicated `bookScore`.
5. L6 OI class compared 1-bar (15m) price change vs 4h OI change; now uses matched 4h
   price horizon via bar timestamps. Backtest `normalizeOiSeries` also fixed to a true
   4h delta (rows are 1h; was per-row change mislabeled `change4hPct`).
6. L2 equal-high/low pair matches now cluster within ATR tolerance (were pushed once per
   matching pair, inflating levelCount/liquidityScore).

Verified sound: L1 confirmed-pivot swings + EMA/ADX (causal), L3 single-bar sweep+reclaim
vs side-aware target level, L4 BOS vs last confirmed swing (idx-1) + displacement, L7 gate
math. Phase0 numbers must be re-run after these fixes — prior harvest is invalid.

## Validation next

1. `cd backend && node scripts/research-mlcts-phase0.mjs` (requires Timescale klines)
2. Full backtest with realistic costs via existing harness
3. Reject/promote only after IS/OOS + frequency floor (≥2 trades/wk target)

**Note:** Research-only — no deploy language until gates pass.
