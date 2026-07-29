# 2026-07-27 — ADA VP FREQ year-clean + certification

## Verdict

**Year-clean: YES.**  
**Certification: `REJECT_CERTIFICATION`** — core 4 gates PASS, but **OOS trades 22 < 30**
and frequency 0.10/wk FAIL. Not a DOGE/NEAR-style research sleeve (those had OOS ≥30).

Preset `VOLUME_PROFILE_FREQ_ADA_15M` locked as **year-clean research checkpoint**.
Do not paper-size for deploy.

## Locked stack

- F3 `va_rejection` only
- `vpMinHtfSepPct: 0.004`
- `vpMinAtrPct: 0.008`
- `vpBuyRejectionMinBody: 0.25`
- Deny cells:
  - `BUY|va_rejection|bull_trend|tight` (2020-21 main bleeder)
  - `SELL|va_rejection|weak_bear|vacuum`

## Path to year-clean

1. Phase 0 default HTF 0.15% → OOS mirage (−59% OOS / +57% IS)
2. HTF 0.40% + minAtr 0.8% → OOS +92%, sticky 2020-21 −7.9%
3. 2020-21 autopsy: `BUY|bull_trend|tight` −6.11 of −7.89
4. Surgical: buyBody25 + deny y21-core cells → **year-clean**

| Year | Ret | n |
|------|-----|---|
| 2020-21 | +2.2% | 6 |
| 2021-22 | +1.5% | 5 |
| 2022-23 | +9.0% | 1 |
| 2023-24 | +51.1% | 8 |
| 2024-25 | +10.2% | 4 |
| 2025-26 | +17.2% | 4 |

## Certification (frozen lock)

| Metric | Value | Gate |
|--------|-------|------|
| FULL return | +120.6% | — |
| CAGR | 15.2% | — |
| Calmar | 1.15 | PASS (>1) |
| Max DD | 13.3% | — |
| MC p5 | +6.9% | PASS |
| WF degradation | **−66.6%** (OOS better) | PASS |
| WF OOS sum | +89.7% | PASS |
| OOS trades | **22** | **FAIL** (≥30) |
| Frequency | **0.10/wk** | **FAIL** (≥2) |
| Catastrophic year | none | PASS |

Cost stress: slip×2 +64%, slip×4 +16%, liq_crunch −28.6% (fragile under crunch).

## Why not RESEARCH_SLEEVE

Harness requires OOS ≥30 for sleeve label. DOGE had 45, NEAR 38. ADA has 22.
Core stability is fine (WF/MC/Calmar/year-clean); sample size is the blocker.

## Freq restore note

Adding `poc_bounce` under lock reopened red years (2025-26 / early). Do not stack
poc for N without a new causal hypothesis.

## Artifacts

- Preset: `VOLUME_PROFILE_FREQ_ADA_15M`
- Harness: `backtest-validate-vp-freq-ada.mjs`
- `.vp-freq-ada-certification.json`
- `.vp-freq-ada-f3-year-clean.json`, `.vp-freq-ada-f3-y21-surgical.json`
- Scripts: `research-vp-freq-ada-f3-year-clean.mjs`, `research-vp-freq-ada-f3-y21-surgical.mjs`

## Next

1. Portfolio sleeve pooling DOGE+NEAR+ADA for combined frequency / OOS N
2. Or new ADA freq-restore hypothesis that does not reopen year reds
3. Do not loosen HTF/ATR/body/cells just to inflate N
