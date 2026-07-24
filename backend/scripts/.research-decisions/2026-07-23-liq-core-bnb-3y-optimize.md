# BNB-only LIQ_CORE — 3-year results + liquidity-feature optimize (2026-07-23)

Coin: **BNBUSDT** only (one-coin-at-a-time).  
Window: **2023-07-01 → 2026-07-01** (36 months). Holdout: **2025-07-01 → 2026-07-01**.  
Preset: `INTRADAY_PRO_LIQ_CORE_15M` (X4 no-partial + T1 maxTpRr=2 + P1 reclaimHoldBars=2).  
Artifacts: `.liq-core-bnb-3y-optimize.json`, `.liq-core-bnb-3y-features.json`  
Script: `research-liq-core-bnb-3y-optimize.mjs`

---

## 1. Three-year baseline (honest)

| Slice | n | /wk | Ret% | CAGR% | PF | WR% | MaxDD% |
|-------|---|-----|------|-------|----|-----|--------|
| **FULL 3y** | 1056 | **6.74** | **−99.9** | −88.8 | **0.53** | 31.5 | 99.9 |
| Train (first 24m) | 719 | 6.89 | −98.9 | −89.4 | 0.53 | 31.2 | 98.9 |
| Hold (last 12m) | 337 | 6.46 | −1.0 | −1.0 | 0.60 | 32.3 | 1.0 |
| Y2023 (H2) | 169 | 6.43 | −71.7 | — | 0.48 | 32.0 | 71.7 |
| Y2024 | 385 | 7.36 | −25.4 | −25.4 | 0.64 | 30.1 | 29.8 |
| Y2025 | 352 | 6.75 | −2.4 | −2.4 | 0.61 | 35.2 | 2.5 |
| Y2026 (H1) | 150 | 5.80 | −0.4 | — | 0.43 | 26.0 | 0.4 |

**Verdict:** FREQ OK (~6.7/wk ≥2). **EDGE FAIL** — equity destroyed early (2023–24); later years are near-flat at PF≪1, not a recovery.

Dollar failure class (full): `never_green` −$74 + `sl_no_follow` −$102 ≈ **−$176** vs winners **+$114**.

---

## 2. Liquidity-concept features (per trade, n=1056 attached)

### What actually separates W vs L

| Feature | W mean | L mean | Read |
|---------|--------|--------|------|
| MFE | **1.84%** | 0.55% | Follow-through = edge |
| Bars held | **30** | 20 | Runners pay |
| SL distance | **0.58%** | 0.95% | Wide invalidation ↔ losers |
| Same-bar reclaim | avg pnl **−0.174** (n=337) | multi-bar **−0.057** (n=719) | Best *categorical* liquidity signal |
| scoreV2 | 66.7 | 66.8 | **No discrimination** |
| contOppR | 3.20 | **3.76** | Winners have *less* opposing R on avg — naive “more room” gate is wrong direction for mean |
| dispImpulse | 2.08 | 1.93 | Weak |
| exhaustion | 0.34 | 0.36 | High exhaustion **worse** avg (−0.16) — not a fade quality lift |
| Level | PDL least bad (−0.04) | session_low / PDH worse | Session extremes drag |

### Soft keep (informational PF on subset)

| Rule | Keep% | Soft PF | Note |
|------|-------|---------|------|
| all | 100% | 0.53 | baseline |
| multiBar reclaim | 68% | **0.65** | strongest single concept |
| oppR≥1.5 | 82% | 0.61 | mild |
| multi + oppR≥1.5 | 56% | **0.72** | best soft combo |
| disp≥1 / score / high exh | — | ≤0.53 | useless or harmful |

---

## 3. Full-sim A/B (promote only if FULL **and** HOLD improve; freq ≥60% of 6.74)

| Variant | FULL PF / ret / tw | HOLD PF / ret | Promote? |
|---------|-------------------|---------------|----------|
| H0 CORE | 0.53 / −99.9 / 6.74 | 0.60 / **−0.99** | baseline |
| L8 no same-bar | **0.66** / −98.6 / 5.11 | 0.61 / **−4.94** | **NO** — IS lift, holdout ret worse |
| L1 contRoom minR 1.5 | 0.64 / −99.5 / 5.52 | 0.54 / −3.30 | **NO** — holdout worse |
| C1 L8+cont15 | **0.71** / −96.3 / 3.92 | 0.54 / **−11.8** | **NO** — holdout collapses |
| L9 pdh/pdl only | 0.62 / −98.5 / 5.10 | 0.62 / −4.88 | **NO** |
| L10 no toxic day | 0.61 / −98.2 / 4.68 | 0.62 / −5.47 | **NO** |
| L6 max sweep vel | 0.53 / −97 / 3.03 | worse | **NO** (freq fail) |
| Disp / score gates | ~flat | — | **NO** |

**Thinking:** Soft autopsy correctly flags multi-bar + room as “cleaner,” but hard-gating them **overfits the 2023–24 bleed** and **hurts the last-year holdout**. That is the opposite of “optimum.” Liquidity filters that only raise IS PF while degrading HOLD are **frequency taxes dressed as quality**.

---

## 4. Optimum for BNB (this pass)

**Keep wired:** CORE + X4 + T1 + P1.  
**Do not wire:** same-bar reject, continuation-room floor, toxic-day, pdh-only, sweep-velocity, scoreV2, displacement floors.

**Why:** On a true 3y + 1y holdout, no tested liquidity-concept hard gate raises **both** full and holdout expectancy without being an N-cut. The binding constraint remains **post-entry no-follow path**, not missing entry labels.

**Next (BNB-native, still one coin):**
1. **LIQ_ACCEPT** playbook (hold-beyond sweep continuation) — different edge thesis, not more fade gates.
2. Or path-exit that approximates oracle skip of never_green **without** clipping slow runners (dead-trade already REJECTED).

---

## Verdict

**BNB 3y CORE: FREQ OK / EDGE FAIL (PF 0.53).**  
Liquidity feature autopsy sharpens the *why* (same-bar toxic; scoreV2 useless; room/exhaustion not free edges).  
**No new promote** after holdout honesty. Do not claim optimized profitable BNB fade.
