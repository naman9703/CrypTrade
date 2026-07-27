# 2026-07-26 — NEAR VP FREQ certification

## Verdict

**`RESEARCH_SLEEVE_LOW_FREQ`** — core gates **PASS**; deploy frequency **FAIL**.

Not a live certify candidate. Do not promote.

## Window / stack

- Symbol: NEARUSDT 15m futures
- Window: 2021-01-01 → 2026-05-31
- Preset: `VOLUME_PROFILE_FREQ_NEAR_15M`
  (`va_rejection` + `poc_bounce`, HTF align, `vpMinHtfSepPct: 0.0045`)

## Full-window

| Metric | Value |
|--------|-------|
| Trades | 46 (0.16/wk) |
| Return | +231.6% |
| CAGR | 24.0% |
| Calmar | 1.64 |
| Max DD | 14.7% |
| PF | 2.37 |
| Years | all ≥0 (negYears=none) |

## Gates

| Gate | Result |
|------|--------|
| OOS return > 0 | **PASS** (WF OOS sum +127.9%) |
| MC p5 > 0 | **PASS** (+13.8%) |
| Calmar > 1 | **PASS** (1.64) |
| WF degradation < 35% | **PASS** (−72.5% = OOS *better* than train) |
| OOS trades ≥ 30 | **PASS** (38) |
| No year ≤ −25% | **PASS** |
| Frequency ≥ 2/wk | **FAIL** (0.16) |

## Cost stress

| Variant | Ret |
|---------|-----|
| slip×2 | +120% |
| slip×4 | +45% |
| liq_crunch | **−70%** (fragile under extreme costs — same class as DOGE) |

## Path to this sleeve

1. Open F3 = −99.99% — HTF align required for NEAR to exist.
2. HTF-sep ladder: **0.0045** is the max-N year-clean frontier (sep 0.0040 still has tiny reds).
3. Freq restore: **`add_poc`** ACCEPT (+232% / Cal 1.81 / tw 0.16); VAL/VAH crush year-clean.
4. Decision: `2026-07-26-near-vp-freq-year-clean-htf.md`.

## Artifact

- `backtest-validate-vp-freq-near.mjs`
- `.vp-freq-near-certification.json`
- Preset: `VOLUME_PROFILE_FREQ_NEAR_15M` (backend + frontend)

## Next

Archive NEAR as low-freq research sleeve (same class as DOGE). Do **not** loosen
HTF sep / open VAL to chase ≥2/wk without a new coin-native hypothesis that
preserves year-clean. Move to **ADA / XLM** Phase 0.
