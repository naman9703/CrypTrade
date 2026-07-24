# LIQ_CORE — W/L patterns, TF sweep, enhance layers (2026-07-23)

## Mandate

Prefer layers that **lift PF / OOS return**; reject gates that only cut frequency.
Map liquidity technical layers; pick optimum entry TF; autopsy win vs loss.

## Window / coin

BNBUSDT futures · 2025-01-01 → 2026-06-01 · OOS cut 2025-10-01 · CORE chronological harvest.

Artifacts: `.liq-core-wl-tf-enhance.json`, `.liq-core-risk-layer-ab.json`.

## Winner vs loser (15m CORE, n=539, W=139 / L=400)

| Feature | Winners | Losers | Implication |
|---------|---------|--------|-------------|
| MFE mean | **1.91%** | 0.55% | Edge = follow-through, not entry label |
| MAE mean | −0.46% | −0.94% | Losers go deep fast |
| Bars held | mean **38** (p50=48) | mean **17** (p25=4) | Instant-death cohort; runners pay |
| SL distance | mean **0.49%** | 0.76% | Wide invalidation correlates with losers |
| ADX / day loc | ~same | ~same | **Not** a separator |
| HTF align | avg pnl ≈ against | — | Hard HTF gate does **not** help |
| Prem/disc loc | BUY_discount / SELL_premium **worse** avg | — | Classical ICT loc not a free edge here |
| Narrative | all sessions negative | NY worst avg | Killzone as hard filter = N cut only |

Soft keep rules (informational) cut loss $ but **never flip** aggregate PnL positive.

## Entry TF sweep (CORE-like)

| TF | n | /wk | Ret% | PF | Hold PF |
|----|---|-----|------|----|---------|
| 5m | 773 | 10.5 | −132 | **0.24** | 0.28 |
| **15m** | 539 | **7.3** | −146 | **0.31** | 0.30 |
| 1h | 408 | 5.5 | −154 | 0.33 | 0.32 |

**Optimum research entry TF: 15m** — best freq×PF among negatives; 1h slightly higher PF but lower N and worse hold bleed; 5m noise. None profitable.

## Enhancement A/B (exit + soft concept)

Promotion rule: better PF **and** ret vs H0, keep ≥60% CORE freq (~≥4.4/wk). Still require honesty: PF≥1 not achieved.

| Variant | n | /wk | Ret% | PF | Verdict |
|---------|---|-----|------|----|---------|
| H0_core | 539 | 7.31 | −145.5 | 0.31 | baseline |
| E1 trailAfterTp1 | 702 | 9.5 | −100 | **0.14** | REJECT (PF crash) |
| E2 chopMfeTrail | 579 | 7.9 | −138 | 0.32 | weak / reject |
| E3 BE@0.8% | 561 | 7.6 | −142 | 0.29 | REJECT |
| E4 hold96 | 502 | 6.8 | −156 | 0.31 | REJECT |
| E5 tp1 0.5R / 60% | 576 | 7.8 | −141 | 0.17 | REJECT |
| C1 HTF not against | 242 | **3.3** | −122 | 0.30 | REJECT (freq crush) |
| C2 no toxic trend | 394 | 5.3 | −143 | 0.31 | REJECT (N-only) |
| R1–R3 maxSl | ↓N | — | worse/same PF | — | REJECT |
| R4–R6 minExt | ≈H0 | — | no lift | — | no-op / reject |
| R7 no same-bar | 432 | 5.9 | −131 | 0.24 | REJECT |
| R8 reclaim hold1 | 466 | 6.3 | −155 | 0.33 | REJECT (ret worse) |
| R9 displacement | =H0 | — | — | no-op |
| R10 first cycle | 403 | 5.5 | −142 | 0.30 | REJECT |
| X3 tp1 1.5R / 40% | 525 | 7.1 | −145 | **0.37** | mild lift |
| **X4 no TP1 partial** | **544** | **7.4** | **−99** | **0.50** | **PROMOTE exit** (still EDGE FAIL) |
| X5 trail after partial | 565 | 7.7 | −142 | 0.25 | REJECT |

## Liquidity technical layer map (evidence)

| Layer | Role | CORE stance |
|-------|------|-------------|
| Named pool (PDH/PDL / session) | Trigger context | **ON** (concept) |
| Sweep pierce + reclaim | Trigger + confirm | **ON** |
| Chronological pick | Live ≡ BT | **ON** |
| Full-size to structural TP2 / SL | Risk / exit | **ON** (X4 wired) |
| HTF align / killzone / prem-disc / toxic-day | Context filters | **OFF** — cut N, no PF≥1 |
| Body / score / CHoCH / V2 stacks | Confirm piles | **OFF** — prior rejects |
| MaxSl / minExt / first-cycle | Risk quality | **OFF** — no material lift |
| MFE giveback / late BE / longer hold alone | Exit | not yet proven at PF≥1 |

## Action

1. Wire `intradayLiqPartialTp: false`, `intradayLiqTp1Enabled: false` into `INTRADAY_PRO_LIQ_CORE_15M` (backend + frontend).
2. Keep **15m** as entry TF.
3. Do **not** claim live-ready — PF ~0.50 still EDGE FAIL.
4. Next: structural invalidation / no-follow exit (cut 0–4 bar death without entry veto), or new playbook — not more fade filters.

## Verdict

**ENHANCE PARTIAL** — exit layer X4 improves harvest honesty; entry filters remain banned unless they beat X4+H0 on PF **and** freq.
