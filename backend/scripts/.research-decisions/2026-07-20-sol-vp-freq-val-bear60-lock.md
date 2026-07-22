# 2026-07-20 — SOL VP FREQ Phase 0–2 lock (VAL bear60 research sleeve)

## Experiment

- **Symbol / TF:** SOLUSDT futures **15m**
- **Window:** **2021-01-01 → 2026-05-31** (Binance perp history backfilled from ~2020-09)
- **Scripts:** `backtest-vp-freq-sol-baseline.mjs`, `research-vp-freq-sol-autopsy.mjs`, `backtest-vp-freq-sol-ab.mjs`, `backtest-vp-freq-sol-ab2.mjs`
- **Artifacts:** `.vp-freq-sol-baseline.json`, `.vp-freq-sol-autopsy.json`, `.vp-freq-sol-ab.json`, `.vp-freq-sol-ab2.json`

## Phase 0 — FREQ core baseline (no coin overlays)

| Window | Trades | t/wk | Ret% | PF | DD% |
|--------|-------:|-----:|-----:|---:|----:|
| full | 919 | 3.26 | **−94** | 0.89 | 97 |
| 2021–22 | 190 | 3.65 | −46 | 0.85 | 53 |
| 2022–23 | 171 | 3.29 | **+110** | 1.27 | 42 |
| 2023–24 | 178 | 3.41 | −72 | 0.71 | 81 |
| 2024–25 | 152 | 2.92 | −49 | 0.82 | 59 |
| 2025–26 | 117 | 2.25 | −46 | 0.71 | 67 |

Setup PnL (full): VAH −$79 · VAL −$16 · rej +$8 · poc −$7. Vacuum setups not separately tagged (folded into VAH/VAL path).

## Phase 1 — Autopsy (named failure modes)

| Failure | Evidence | Desired behaviour |
|---------|----------|-------------------|
| **VAH vacuum** (path≥2%) | −$89 across years; bull_trend vacuum −$52 | Abstain vacuum VAH |
| Residual **structured VAH** | After vacuum block, remaining VAH still ~−$37–57 in A/B | Drop VAH allow-list |
| **VAL bull60 / flat60** | bear60 +$19 vs bull60 −$16 / flat −$11 | Require prior60d ≤ −5% |
| **va_rejection / poc** | Net negative once VAL is prepared | Drop from allow-list |
| Chase / weak-bear overlays | Raise full return but flip **2021–22** red | Reject for lock |

## Phase 2 — One-change path (accepted)

| Step | Change | Full | Years | Verdict |
|------|--------|-----:|-------|---------|
| H1 | Block vacuum VAH | −64% | 21–22 flips **+14%** | LOCK physics (later moot) |
| H2 surgical bull60 | ETH/BNB-style dump/nonvac/ext | −60% | **regresses** 21–22 | REJECT |
| **H2b** | VAL require bear60 (−5%) | **+52%** | mixed with VAH still on | LOCK |
| H7 | Drop VAH | +106% | all ≥0 except tiny 23–24 | progress |
| **H8** | VAL + rej | +136% | all ≥0 | rej still −$45 |
| **H9** | **VAL-only + bear60** | **+131% / DD26 / Cal~5** | **all years ≥0** | **LOCK** |
| H11/H12 | +chase / wbvac | higher ret | **H12 21–22 −2%** | REJECT |

### Locked H9 year table

| Year | N | Ret% |
|------|--:|-----:|
| 2021–22 | 27 | +3.2 |
| 2022–23 | 43 | +10.4 |
| 2023–24 | 6 | +15.8 |
| 2024–25 | 23 | +20.7 |
| 2025–26 | 31 | +54.0 |
| **full** | **154** | **+131** |

Frequency ≈ **0.55 / week** — below standalone ≥2/wk doctrine.

## Locked config (`VOLUME_PROFILE_FREQ_SOL_15M`)

```text
vpAllowedSetups: ["val_breakdown"]
vpRequireHtfAlign: true
vpMinHtfSepPct: 0.0015
vpValSellRequirePrior60dBear: true
vpValSellPrior60dBearPct: -0.05
vpNoveltyEnabled: false
```

Resolve: `resolveVolumeProfileFreqPreset("SOLUSDT")` + UI ★ SOL FREQ (VAL bear60).

## Honest live-trust statement

- **Research sleeve** with coin-native relative abstain (bear60), **not** calendar cherry-pick.
- Survives every Jun→May year in the lock window with controlled DD.
- **Not** a standalone live main stream until frequency is restored without breaking year table (or user accepts low-freq sleeve portfolio).
- Do **not** reopen VAH / copy ETH vol-target / add chase without new SOL autopsy.

## Next

1. ~~Run `backtest-validate-vp-freq-sol.mjs` (WF + MC + gates) → certify sleeve or reject.~~ **Done** — see certification below.
2. Optional frequency restore: prepared rejection subtype only (bear vacuum rej paid in autopsy) — one change, protect 2021–22.
3. **Reopen if:** MC p5 / Calmar fail on next harness run — do not claim live-ready until core gates pass.

## Certification (2026-07-20)

**Script:** `backtest-validate-vp-freq-sol.mjs`  
**Artifact:** `.vp-freq-sol-certification.log` (JSON write may need DB up to complete)

| Metric | Result |
|--------|--------|
| Window | SOLUSDT 15m, 2021-01-01 → 2026-05-31 |
| Full sim | **154t / +111% / CAGR 14.6% / Calmar 0.55 / DD 26.7% / PF 1.33** |
| Frequency | **~0.55 / week** |
| Jun→May years | 21–22 **−9.0%** / 22–23 +19.2% / 23–24 +17.9% / 24–25 +12.7% / 25–26 +46.4% |
| MC (1% risk) | p5 **−6.0%** (FAIL) |
| WF OOS | sum **+96.9%** on 147 OOS trades |
| Core gates | **FAIL** Calmar + MC p5; PASS OOS>0, WF deg |
| Extra | PASS N≥30, no catastrophic year; **FAIL** frequency |
| Cost stress | slip×2 +52.7%; slip×4 **−47.5%** |

**Verdict: `REJECT_CERTIFICATION`**

Why not live-trusted yet:

1. Core acceptance gates fail (Calmar 0.55 &lt; 1, MC p5 negative).
2. Frequency far below ≥2/wk standalone doctrine.
3. First Jun→May year still negative (−9%) on harness year table (A/B Jun-window was +3% — treat as residual risk).
4. Fragile under slip×4.

**Honest use:** coin-native **research baseline** locked in presets — portfolio sleeve only after gates pass on re-run; not standalone deploy.
