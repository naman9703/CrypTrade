# Why gated ST re-sim matched baseline (identical N / -100%)

**Date:** 2026-08-04

## Root cause

Backtest worker runs inside Docker `trading-app`. The XGB gate resolved AI as:

`AI_SERVICE_URL || cfg.aiBaseUrl || http://localhost:8001`

Compose sets `AI_BASE_URL=http://ai:8001` but **not** `AI_SERVICE_URL`. Every `/predict/supertrend` call got `ECONNREFUSED` on localhost → **fail-open** → every Supertrend flip passed → identical 1935 trades / -100% equity vs ungated run.

## Fixes

1. Resolve AI via `AI_BASE_URL` (same as `aiClient`).
2. Apply re-sim sets `supertrendXgbFailClosed: true` so dead AI cannot silently clone baseline.
3. `supertrendXgbIgnoreTrainingCutoff: true` now actually scores the **full** window (previously cutoff still bypassed train bars).
4. Batch `/predict/supertrend/batch` + pre-score ST flips once per run.
5. Persist `metrics.stXgbReplay` `{pass, veto, failOpen, cutoffBypass}`.

## What XGB is for (honest)

Layer-3 confirmation on ST flips — not a new signal and not a guarantee of green equity. Prior BNB train (thr~0.09) improved trade-level mean R vs baseline on OOS holdout but stayed **red**. After this wiring fix, re-Apply and compare N + stXgbReplay + equity; if still deep red at ≥50% keep, next step is **one** named rule from top importance (e.g. vol_vs_avg20 / body_pct), not stacking filters.

## Action

Re-train (optional) → **Apply gate & re-backtest** again on the SUPERTREND baseline. Expect different trade count if gate is live (`stXgbReplay.veto > 0`, `failOpen ≈ 0`).
