# 2026-07-15 — ETH VP FREQ macro-adaptive SELL HTF

**Stream:** VOLUME_PROFILE FREQ · ETHUSDT 15m  
**Window:** 2023-06-01 → 2026-05-31 · RISK_AT_SL · UI fees (0.05% slip) · pad + signalStart  
**Script:** `backend/scripts/backtest-vp-freq-eth-macro-adapt.mjs`

## Failure mode (named)

Jun 2023–May 2024: **pullback shorts in a bullish macro**. Local 1h EMA21&lt;EMA50 flips
(`htfDown`) still cleared soft HTF (≥0.15%) while ETH ground higher. VAL breakdown
shorts: avg HTF sep **~0.63%** in the bad year vs **~1.14%** in 2025–26. Not “val_breakdown
is dead” — same setup +$100 in the bearish year.

## Hypothesis (one change)

**Macro-adaptive SELL HTF sep:** when macro is bullish (price above 20d EMA **or** 5d EMA
slope &gt; 0 **or** +20d return &gt; 2%), require stronger 1h HTF separation for shorts; in
genuine downtrends keep a moderate soft floor. BUY HTF stays soft (0.15%).

## Locked knobs (ETH FREQ)

| Knob | Value |
|------|-------|
| `vpSellMacroAdapt` | `true` |
| `vpSellMinHtfSepPct` (soft / bear macro) | `0.0025` (0.25%) |
| `vpSellMacroBullMinHtfSepPct` | `0.005` (0.50%) |
| `vpSellMacroPrior20dBullPct` | `0.02` |
| BUY `vpMinHtfSepPct` | `0.0015` (unchanged) |

## Results (full sim)

| Variant | N | Ret % | DD % | 2023–24 | 2024–25 | 2025–26 |
|---------|--:|------:|-----:|--------:|--------:|--------:|
| Baseline symmetric HTF 0.15% | 239 | +94.4 | 39.5 | **−30.9%** | +29.1% | +118.0% |
| Macro-adapt soft 0.25 / bull 0.50 | 199 | **+148.5** | 37.1 | **+0.04%** | +13.2% | +119.4% |

- Frequency: 239 → 199 (−17%) — still ~1.3 trades/week; not a Tier-A crush.
- Sells in Y1: 40 → 20 (cut shallow pullback shorts).
- All three Jun–May years ≥ 0 after adapt.
- Full return **improved** while DD slightly better — not return-only via N kill.

## Implementation

- `precomputeVolumeProfile`: macroAboveEma20d, macroEma5dSlope, macroPrior20d
- `resolveVpSellMinHtfSep` + `htfAllows` (SELL path)
- Regime-immunity `val_breakdown` branch mirrors adapt when enabled
- Presets: `VOLUME_PROFILE_FREQ_ETH_15M` (backend + frontend)

## Status

**Research promote for ETH FREQ entry** (not certified deploy — still need WF+MC+4-gate
harness). Do not delete `val_breakdown`. Next: BNB/BTC whether same adapt helps; portfolio
replay with ETH adapt on.

## Rejected shortcuts

- Deleting val_breakdown forever (destroys 2025–26)
- Uniform HTF raise to 0.35% for all sides (would crush BUY frequency without addressing
  the macro condition)
