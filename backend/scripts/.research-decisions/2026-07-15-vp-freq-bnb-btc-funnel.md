# Experiment — VP FREQ BNB/BTC funnel reopen

Date: 2026-07-15  
Window: **2025-06-01 → 2026-05-31** (21d pad, signalStart=from, UI 0.05% taker)  
Artifacts: `.vp-freq-bnb-btc-funnel-v2.json`, `.vp-freq-btc-refine.json`

## Hypothesis

BNB/BTC frequency (~0.8/wk) is below ETH (~1.5/wk) because winning setup lists are too narrow **or** remaining gates are N-only. Reopen like ETH: drop filters that do not raise expectancy; keep/add setups that pass full sim.

## Results (honest)

| Coin | Variant | Trades | t/wk | Ret% | PF | Verdict |
|------|---------|-------:|-----:|-----:|---:|---------|
| ETH | open funnel (control) | 79 | 1.52 | +118 | 1.64 | Keep |
| BNB | prior longs-only | 41 | 0.79 | +21 | 1.32 | Baseline |
| BNB | **vah+val + HTF 0.25%** | **70** | **1.35** | **+52** | **1.34** | **PROMOTE preset** |
| BNB | +va_rejection soft | 241 | 4.63 | −94 | 0.52 | REJECT |
| BNB | +poc_bounce soft | 50 | 0.96 | +0.6 | 1.01 | REJECT |
| BNB | open ETH-shaped | 76 | 1.46 | −19 | 0.86 | REJECT |
| BNB | soften score/gap only | 41–59 | ≤1.13 | ≤+21 | ≤1.32 | N↑ hurts ret |
| BTC | prior shorts | 44 | 0.85 | +12 | 1.15 | Baseline |
| BTC | **HTF sep 0.15%** | **41** | **0.79** | **+17** | **1.21** | **PROMOTE (quality)** |
| BTC | no HTF / soft score | 57–179 | ↑ | −13…−87 | <1 | REJECT |
| BTC | +vah / open ETH | 67–69 | ↑ | −13…−33 | <1 | REJECT |

### BNB holdout (mid-split)

- Opt: H1 +34 / H2 +18 (both >0)  
- Old: H1 ≈0 / H2 +21  

### BTC holdout

- Both old and HTF-0.15% lose in H1; H2 carries. Do not claim OOS-certified. Prefer HTF 0.15% for full-window expectancy; **frequency cannot be forced** without destroying edge.

## Locked presets

- **BNB** `VOLUME_PROFILE_FREQ_15M`: setups `vah_breakout`,`val_breakdown`,`lvn`,`naked`; HTF on @ 0.25%; gap 2; max 2/day  
- **BTC** `VOLUME_PROFILE_FREQ_BTC_15M`: shorts unchanged; HTF sep **0.15%** (was 0.12%)  
- **ETH** unchanged  

## Next

- BTC frequency path = new playbook/TF (not looser 15m gates)  
- Portfolio honesty re-run with updated resolve  
- WF+MC before any promote language  
