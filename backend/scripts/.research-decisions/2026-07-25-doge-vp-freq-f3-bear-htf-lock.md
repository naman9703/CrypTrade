# 2026-07-25 — DOGE VP FREQ F3: bear-trend SELL rej HTF floor

## Verdict

**LOCK (research sleeve, not certified):** `vpRejectionSellBearMinHtfSepPct: 0.0035`

on DOGE `va_rejection`-only FREQ baseline.

- 2024–25: **−37.5% → −19.6%**
- FULL: **+41.9% → +63.5%**, Calmar 0.15→0.34, DD 46%→29%
- 2021–22 **unchanged** (+13.6%) — global sell HTF floors destroy this year; scoped rule does not
- tw 0.36→0.33 (freq still far below ≥2/wk — restore is a later phase)

Not WF+MC certified. Residual 2024–25 still red → next autopsy cycle.

## Baseline (Phase 0)

DOGEUSDT 15m, F3 `va_rejection` only, 2021-01→2026-05:

| Year | n | ret |
|------|---|-----|
| 2021-22 | 22 | +13.6% |
| 2022-23 | 22 | +23.7% |
| 2023-24 | 17 | +28.2% |
| **2024-25** | 19 | **−37.5%** |
| 2025-26 | 9 | +37.9% |
| FULL | 103 | +41.9% / tw 0.36 |

## Named failure (Phase 1–2)

2024–25 WR 10.5%, net −$62. Dominant bleed:

- macro **bear_trend** (10t / −$58, 0% WR)
- cell `SELL|va_rejection|bear_trend|vacuum` (−$38 / 6t) + structured (−$14 / 3t)

Same `bear_trend` SELL rej **pays in good years** (+$31 / 19t) — blanket cell deny / global sell HTF rejected.

### Discriminator (universal)

Within SELL bear_trend rej only:

| | bad 2024–25 | good years |
|--|-------------|------------|
| mean htfSep | **0.31%** | **1.25%** |

Soft drop `htfSep < 0.35%` inside that cell: bad −53→−15, good +31→+17 (keeps most edge).

## Behaviour table (Phase 3)

| Condition | Current | Desired |
|-----------|---------|---------|
| SELL `va_rejection` + `bear_trend` + htfSep < 0.35% | take | **abstain** |
| SELL `va_rejection` + `bear_trend` + htfSep ≥ 0.35% | take | take |
| SELL `va_rejection` + other macros | take | unchanged |

## Hard A/B (Phase 4)

| Variant | FULL | 2024–25 | 2021–22 | 2025–26 | tw | verdict |
|---------|------|---------|---------|---------|-----|---------|
| H0 | +41.9 | −37.5 | +13.6 | +37.9 | 0.36 | baseline |
| global sell HTF 0.35% | +94.4 | −6.8 | **−8.5** | +27.3 | 0.26 | **REJECT** (kills 21–22) |
| **bear-scoped 0.35%** | **+63.5** | **−19.6** | **+13.6** | +22.9 | 0.33 | **LOCK** |
| bear-scoped 0.50% | +91.0 | −10.9 | +13.6 | +16.0 | 0.31 | defer (25–26 softens more) |
| bear-scoped 0.25% | +50.6 | −29.7 | +13.6 | +37.9 | 0.35 | weaker |
| cell deny vacuum / ext-down / wick | — | — | — | — | — | REJECT earlier round |

## Implementation

- New filter: `passesVpSellRejectionBearHtfFilter`
- Knob: `vpRejectionSellBearMinHtfSepPct`
- Wired in `evaluateVolumeProfileBar` + `volumeProfileConfigKeys.js`

## Rejected this stream (do not retest without new evidence)

- Blanket deny `SELL|va_rejection|bear_trend|vacuum`
- Global `vpSellMinHtfSepPct` / `vpSellMacroAdapt` as DOGE F3 endpoint
- `vpRejectionSellBlockExtendedDown` @ 5% / 10%
- Wick floor 0.40
- BUY rej bull_trend / unprepared macro blankets

## Next

1. Residual 2024–25 autopsy under locked 0.35% floor (still −19.6%).
2. Frequency restore: selectively add setups/cells with coin-native evidence (not AVAX copy).
3. NEAR F3 queued after DOGE residual or in parallel if capacity.

## Artifacts

- `research-vp-freq-doge-f3-2024-autopsy.mjs` / `.json`
- `research-vp-freq-doge-f3-bear-rej-discrim.mjs` / `.json`
- `research-vp-freq-doge-f3-bear-htf-ab.mjs` / `.json`
