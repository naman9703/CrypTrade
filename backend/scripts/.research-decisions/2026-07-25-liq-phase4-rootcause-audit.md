# Phase 4 root-cause audit — BNB LIQ_CORE clean baseline (2026-07-25)

**Window:** 2025-07-01 → 2026-07-01 · BNBUSDT 15m  
**Baseline:** `INTRADAY_PRO_LIQ_CORE_15M` with all research sleeves pinned OFF  
(see `docs/LIQ_SWEEP_RECLAIM_PHASE0.md`).

Artifacts: `.liq-phase4-rootcause-audit.json`, `.liq-phase4-trade-log.jsonl`  
Script: `research-liq-phase4-rootcause-audit.mjs`

## Baseline metrics

| n | tw | ret% | PF | WR% | DD% | meanR |
|---|----|------|----|-----|-----|-------|
| 329 | 6.31 | -85.75 | 0.656 | 39.5 | 86.5 | -0.22 |

## Loss taxonomy (sorted by % of loss dollars)

| Cause | n | % losers | % loss $ | pnl |
|-------|---|----------|----------|-----|
| false_reclaim | 93 | 46.7% | 51.7% | -129.08 |
| regime_mismatch | 92 | 46.2% | 40.6% | -101.41 |
| low_quality_sweep | 5 | 2.5% | 2.7% | -6.68 |
| bad_exit | 3 | 1.5% | 1.9% | -4.81 |
| other_unclassified | 2 | 1% | 1.8% | -4.39 |
| session_timing | 3 | 1.5% | 0.9% | -2.31 |
| missing_displacement | 1 | 0.5% | 0.4% | -0.96 |

## Performance by regime

| Regime | n | WR% | pnl | avg |
|--------|---|-----|-----|-----|
| TREND_UP | 143 | 39.2 | -49.21 | -0.344 |
| TREND_DOWN | 125 | 43.2 | -18.38 | -0.147 |
| RANGE | 40 | 35 | -11.04 | -0.276 |
| SQUEEZE | 14 | 21.4 | -8.41 | -0.601 |
| VOLATILE_AVOID | 7 | 42.9 | 1.29 | 0.184 |

## Feature contrast (win vs loss means)

| Feature | winners | losers |
|---------|---------|--------|
| impulseAtr | 1.9969 | 1.9148 |
| momentum | 0.5876 | 0.5997 |
| volSpike | 3.1676 | 2.9031 |
| exhaustion | 0.3265 | 0.3358 |
| wickBody | 0.2581 | 0.2691 |
| distSlPct | 0.0130 | 0.0107 |
| mfePct | 0.0182 | 0.0045 |

## Diagnosis

**Top loss cause:** `false_reclaim` (51.7% of loss $).  
**Second:** `regime_mismatch` (40.6% of loss $).

Sweep-quality features at entry (**impulseAtr, momentum, volSpike, exhaustion, wickBody**)
are nearly identical for winners vs losers. The only post-hoc separators are **MFE**
(path) and slightly wider **distSl** on winners — i.e. the failure is mostly
**not observable as a stable entry label** on the current level set.

### Soft probes (IS 70% / OOS 30%, no engine change)

Artifact: `.liq-phase5-soft-probes.json`

Every causal abstain from the user’s quality list was soft-tested
(displacement floors, vol spike, wick body, exhaustion, MinSl, toxic-day,
against-trend, off-session):

| Result | Detail |
|--------|--------|
| **★PASS (OOS PF≥1, ret>0, tw≥2, meanR↑)** | **NONE** |
| Best OOS PF | `minSl1%+buy_bd` PF 1.13 / +0.65% but **tw 1.47** (EG_lowN — same family as rejected BUYBD sleeve) |
| IS green / OOS red | `distSl≥1.2%` (+6% IS → −1.7% OOS) — classic overfit |

**Conclusion:** stacking more entry filters on the current CORE trigger set will
repeat the failure mode you called out (frequency down, edge not up). Phase 5
must change the **trigger definition** (which levels count as liquidity) or
**entry timing**, not another abstain threshold.

## Explicitly NOT done in this step

- No BUYBD / toxic / mitigation / MinSl / displacement gate engine changes.
- No parameter sweeps promoted.
- Prior sleeve `INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M` remains **not deployable**.

## Phase 5 hypothesis (next — one change only)

**Root cause addressed:** false_reclaim on insignificant / noisy pools
(PDH/PDL + session clusters without swing confirmation).

**Mechanism:** Require swing-pivot significance (N bars L/R) for the liquidity
level — fewer noise pierces → fewer false reclaims — measured by hard A/B of
`intradayLiqLevels` including `swing_pivot` vs clean CORE, IS/OOS split, regime
breakdown. Accept only if OOS expectancy/PF improve without collapsing tw below
floor and without tanking any single regime.

