# BNB LIQ prepared-cell lock → RESEARCH_SLEEVE (2026-07-25)

Coin: **BNBUSDT** 15m. Base: CORE + guide-gap close.  
Artifacts: `.liq-bnb-prepared-cell-lock.json`, `.liq-bnb-freq-restore-prepared.json`, `.liq-bnb-freq-restore-r2.json`, `.liq-bnb-freq-restore-r3.json`.

## What changed vs CORE

| Gap (ICT) | Fix locked in sleeve |
|-----------|----------------------|
| No displacement | `RequireDisplacementV2` min **1.2 ATR** |
| Tight SL death paths | `MinSlPct` **1.0%** |
| Market at reclaim (wrong entry) | **Mitigation retest** frac 0.5 / wait 6 |
| Fake breakout fades | `DaySituationBias` (toxic abstain) |

## Hard results (fees + slip)

### Primary sleeve `INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_15M` (= mit_minSl01_toxic)

| Window | n | tw | ret | PF |
|--------|---|----|-----|----|
| Y1 (2025-07→2026-07) | — | **1.32** | **+14.1%** | **1.15** |
| HOLD (2024-07→2025-07) | — | **1.76** | **+3.8%** | **1.03** |
| FULL (2023-07→2026-07) | — | **1.56** | **+12.9%** | **1.04** |

Expectancy **green on Y1 + HOLD + FULL**. Deploy freq gate tw≥2: **not met** (best ~1.76 HOLD).

### Return-max cousin `INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_H020_15M` (mitFrac 0.35 + hours 0–20)

| Window | tw | ret | PF |
|--------|----|-----|----|
| Y1 | 1.34 | +11.5% | 1.13 |
| HOLD | 1.55 | +26.3% | 1.25 |
| FULL | 1.49 | **+59.9%** | **1.16** |

### Freq restore attempts (honest)

Widening hours / loosening MinSl to 0.8% / dropping toxic → either loses HOLD or loses Y1.  
ETH/BTC do **not** inherit BNB prepared edge (coin-native).  
No variant cleared **tw≥2** with Y1+HOLD both green.

## Verdict

**RESEARCH_SLEEVE** — first LIQ BNB path with **positive multi-year FULL** and green Y1+HOLD since CORE rebuild.  
**Not live / not promote** until: WF+MC+4-gates **and** freq restore to ≥2/wk (or explicit user accept of ~1.5/wk).

Beats prior AST_VOL15 on freq (~1.5 vs ~0.2/wk) with honest positive FULL.

## Next

1. ~~Residual autopsy / freq restore~~ → **cleared** via one-sided toxic (`2026-07-25-liq-bnb-onesided-freq-restore.md`). Prefer `INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M` for deploy research.  
2. Coin-native ETH/BTC prepared matrices (do not copy BNB).  
3. WF + MC + 4-gates on BUYBD / SELLBO.
