# Experiment — VP FREQ coin-specific tuning

Date: 2026-07-15  
Window: **2025-06-01 → 2026-05-31** (same as user UI runs)  
Scripts: `backtest-vp-freq-coin-tune.mjs`, focused v2 variants  
Artifacts: `.vp-freq-coin-tune-results.json`

## Problem

Uniform **ETH-shaped** FREQ (all setups + soft HTF 0.15%) applied to all coins:

| Coin | Trades | Ret% | PF | Notes |
|------|-------:|-----:|---:|-------|
| ETH (user) | 73 | **+37.8** | ~1.3 | Keep |
| BTC (user) | 65 | +13.4 | 1.13 | Fragile |
| BNB (user) | 72 | **−19.5** | 0.82 | Fail |

## Setup autopsy (uniform eth-shaped)

| Coin | Winner setups | Loser setups |
|------|---------------|--------------|
| **BNB** | `vah_breakout` (+6) | `val_breakdown` (−8), `poc_bounce` (−9), `va_rejection` (−4) |
| **ETH** | `val_breakdown` (+139), `vah_breakout` (+17) | `poc_bounce` mild (−6) |
| **BTC** | `va_rejection` (+9), `val_breakdown` (+5) | **`vah_breakout` (−23)** |

Opposite side bias: BNB longs vs BTC shorts. One preset cannot serve both.

## Tuned presets (frequency kept via soft pattern knobs, not ultra-tight Tier-A)

| Coin | Change | Trades | t/wk | Ret% | PF | DD% |
|------|--------|-------:|-----:|-----:|---:|----:|
| **ETH** | all setups + soft HTF 0.15% (unchanged) | 79 | **1.52** | **+167** | **1.71** | 21 |
| **BNB** | longs only (`vah`/`lvn`/`naked`), no HTF, soft body/vol, max 2/day | 41 | **0.79** | **+27.7** | **1.36** | 20 |
| **BTC** | shorts (`val_bd`/`va_rej`/`naked`/`lvn`), HTF 0.12%, soft body | 44 | **0.85** | **+14.0** | **1.22** | 28 |

### Frequency honesty

- Removing bleed setups **does** reduce BNB/BTC vs the broken uniform 70+ trade runs — those extra trades were losing money.
- Tuned BNB/BTC still **~40–44 trades/year** vs Tier-A’s 3–4 — not crushed to useless N.
- Attempts that “restored” ETH-like frequency (`hvn_flip`, no-HTF BTC shorts) destroyed expectancy (BNB −65%, BTC −78%).
- Rule: **do not reopen loser setups to hit 1.5/wk**. Next freq path = new playbook (value-touch daily), not ETH config on BNB.

## UI apply (must use coin button)

1. MANUAL → **VOLUME_PROFILE**
2. Preset strip:
   - **★ ETH VP FREQ (research)**
   - **BNB VP FREQ longs (research)**
   - **BTC VP FREQ shorts (research)**
3. Save → backtest

Do **not** copy ETH preset onto BNB/BTC.

## Code

- `resolveVolumeProfileFreqPreset(symbol)`
- `npm run backtest:vp-freq-coin-tune`

## Next

1. Portfolio sim ETH+BNB+BTC with **per-symbol** resolve (not one cfg for all)
2. ETH WF+MC validation
3. Optional BNB value-touch daily stream to raise t/wk without short bleed
