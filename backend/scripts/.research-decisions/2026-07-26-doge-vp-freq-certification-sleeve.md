# 2026-07-26 — DOGE VP FREQ certification

## Verdict

**`RESEARCH_SLEEVE_LOW_FREQ`** — core gates **PASS**; deploy frequency **FAIL**.

Not a live certify candidate. Do not promote.

## Window / stack

- Symbol: DOGEUSDT 15m futures
- Window: 2021-01-01 → 2026-05-31
- Preset: `VOLUME_PROFILE_FREQ_DOGE_15M` (rej + paying POC; bleed POC denied; minATR 0.8%; BUY body 0.25; score 6; gap 1)

## Full-window

| Metric | Value |
|--------|-------|
| Trades | 58 (0.21/wk) |
| Return | +328.8% |
| CAGR | 29.8% |
| Calmar | 1.49 |
| Max DD | 20.0% |
| PF | 2.46 |
| Years | all ≥0 (no catastrophic year) |

## Gates

| Gate | Result |
|------|--------|
| OOS return > 0 | **PASS** (WF OOS sum +111.5%) |
| MC p5 > 0 | **PASS** (+26.2%) |
| Calmar > 1 | **PASS** (1.49) |
| WF degradation < 35% | **PASS** (31.0%) |
| OOS trades ≥ 30 | **PASS** (45) |
| No year ≤ −25% | **PASS** |
| Frequency ≥ 2/wk | **FAIL** (0.21) |

## Cost stress

| Variant | Ret |
|---------|-----|
| slip×2 | +260% |
| slip×4 | +103% |
| liq_crunch | **−47%** (fragile under extreme costs) |

## Prior POC cleanup (required for Calmar)

Open `poc_bounce` was net −31. Blocking 6 bleed POC cells lifted Calmar ~1.0 → ~1.5 and unlocked gate pass. Decision: `2026-07-26-doge-vp-freq-poc-cell-cleanup.md`.

## Artifact

- `backtest-validate-vp-freq-doge.mjs`
- `.vp-freq-doge-certification.json`

## Next

Frequency restore without breaking year-clean / Calmar / WF — or archive DOGE as low-freq sleeve and move to **NEAR F3**. Do not loosen ATR/VAL blindly (already rejected).

## Post-cert freq A/B (same day)

Script: `research-vp-freq-doge-postcert-freq.mjs`.

| Probe | Result |
|-------|--------|
| Deny REJ bleeds ± ATR 0.007 | Better Calmar, **lower** tw (0.14–0.17) |
| ATR 0.0065 / stacked HTF+ATR | Re-reds 2024–25 |
| naked / lvn / maxDay3 | No-op or tiny |
| HTF 0.10% | tw 0.22 only; still << 2/wk |

**Conclusion:** No gate-safe path toward deployable frequency on 15m F3+POC.
Archive further DOGE N-chase unless a new setup family with coin-native evidence appears.
Next stream: **NEAR F3**.
