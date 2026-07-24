# 2026-07-23 — BNB VP FREQ H9 Calmar lift → RESEARCH_SLEEVE_LOW_FREQ

## Context

Classical LIQ_CORE fade on BNB remained EDGE FAIL after exits, ACCEPT, hybrid,
year-regime, and progress-confirm (soft false-positives; hard reject). Nearest
honest profitable BNB path was VP FREQ (prior cert: +261% / Calmar **0.96** —
failed Calmar>1 only).

## Hypothesis (one change)

**H9:** Flat/transition `prior60` VAL shorts still bleed beyond the ±5% H7 band.
Widen `vpValSellBlockFlatPrior60` abstain to **±8%** (measurable regime rule —
not year-hardcode).

Rejected alternatives same pass: chase tighten to 2% (Calmar↓), HTF 0.35 (N=0 bug),
risk 1% (Calmar still <1 on % returns). Chase 3% also Calmar>1 but weaker than H9.

## Hard result (cert harness, risk 2.5% / 12x, 2020-01→2026-05)

| Metric | Pre-H9 | **H9 ±8% flat** |
|--------|--------|-----------------|
| N / tw | 108 / 0.32 | **104 / 0.31** |
| Return | +260.7% | **+303.9%** |
| CAGR | 22.6% | **24.8%** |
| Calmar | 0.96 | **1.31** |
| Max DD | 23.4% | **18.9%** |
| PF | 1.72 | **1.82** |
| MC p5 | +15.8% | **+22.5%** |
| WF OOS sum | +210.5% | **+223.7%** (84 OOS t) |
| WF deg | — | **13.8%** |
| Worst year | −8.2% | **−6.7%** (2023-24) |

**Core gates:** ALL PASS (oosPositive, mcP5Positive, **calmarOver1**, wfDegradationOk).  
**Extra:** OOS N≥30 PASS · no catastrophic year PASS · **frequency FAIL** (0.31/wk < 2).

Cost stress: slip×2 +156% · slip×4 +79% · liq_crunch still fragile (−75%).

## Verdict

**`RESEARCH_SLEEVE_LOW_FREQ`** (same class as ETH VP FREQ sleeve).

- Not a ≥2/wk deployable standalone stream.
- Honest positive expectancy + Calmar>1 + MC + WF after H9.
- Wired on `VOLUME_PROFILE_FREQ_BNB_15M` + frontend preset.

## Config delta

```text
vpValSellFlatPrior60LoPct: -0.05 → -0.08
vpValSellFlatPrior60HiPct: +0.05 → +0.08
```

Artifact: `.vp-freq-bnb-certification.json`, `.vp-freq-bnb-calmar-h9.log`, `.vp-bnb-calmar-lift.json`.

## LIQ note

Do **not** resume classical fade knob stacks on BNB for “profitability.” Reopen LIQ
only as a **new** stop-run prepared playbook with coin-native matrix.
