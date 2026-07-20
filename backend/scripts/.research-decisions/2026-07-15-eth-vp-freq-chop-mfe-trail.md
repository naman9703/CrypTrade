# 2026-07-15 — ETH VP FREQ chop-only SELL MFE giveback trail

**Hypothesis (one change):** 2022–23 under-earns on the **same** `val_breakdown` shorts
because chop/squeeze prints +1–2.8% MFE then full SL (WHIPSAW). Flat BE@MFE rejected
(scratches clean-trend runners). Fix **exit behaviour** only when entry is chop
(`|prior60d| < 5%`): after MFE ≥ 1%, ratchet SL to lock 65% of peak MFE (35% giveback).
Strong trends (deep prior60d) unchanged so 2025 runners still reach TP.

**Not** a trade-count cut — N stays 263.

## Implementation

- `backend/src/backtest/engine/regimeMfeTrail.js`
- Runner: set `pos.regimeChop` at entry; ratchet while open
- Locked on `VOLUME_PROFILE_FREQ_ETH_15M`:
  - `backtestChopMfeTrail: true`
  - `backtestChopMfeTrailSides: "SELL"` (BUY trail helped 2025 but **hurt 2023–24**)
  - activate 1%, giveback 35%, prior abs max 5%

## Full sim 2022-06 → 2026-05

| | N | Ret | DD | 22–23 | 23–24 | 24–25 | 25–26 |
|--|--:|--:|--:|--:|--:|--:|--:|
| OFF | 263 | +135% | 52.4% | −5.4% | 0.0% | +13% | +119% |
| SELL chop trail | **263** | **+145%** | **50.4%** | **−1.5%** | **0.0%** | +13% | **+119%** |
| BOTH sides (not locked) | 263 | +160% | 50.1% | −1.5% | **−3.4%** | +20% | +128% |

SELL-only chosen for **no year regression**. BOTH rejected for 2023–24 dip.

## Still open

- 2022–23 still slightly negative (vacuum VAH + va_rejection geometry remain)
- Research-only; not WF+MC certified

Script: `backtest-vp-freq-eth-chop-mfe-trail.mjs`
