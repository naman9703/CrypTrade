# BTC SMC — prerequisite invalidation + PD-after-CHoCH (2026-07-28)

## Hypothesis

Prerequisites require: (1) clear **invalidation** (reclaimed CHoCH, blown OB,
mitigated FVG, continuation sweep), (2) **sequence patience** (PD array after
CHoCH — no front-run), (3) written frozen ruleset, (4) abstain taxonomy.
These are concept-correctness fixes, not a return knob.

## What shipped

- `techniques/smcInvalidation.js` + unit tests
- Orchestrator wire: `checkSmcInvalidation`, `resolveRequirePdAfterChoch`,
  `pre._smcLastAbstain`, `smcMeta.trendState` / `invalidationEnforced`
- `docs/SMC_ICT_FROZEN_RULESET.md`
- Defaults: enforce ON when `RequireChoch` or full/balanced; OFF on bare sweep
  (BNB reclaim baseline unchanged)
- A/B script: `research-smc-btc-prerequisite-ab.mjs`

## A/B (BTC 15m, 2025-01-01→2026-06-01, OOS from 2025-10-01)

| Variant | n | tw/wk | WR | FULL | OOS | PF |
|---------|---|-------|-----|------|-----|-----|
| legacy (flags OFF) | 90 | 1.22 | 8.9% | **−81%** | **−20%** | 0.14 |
| prerequisite concept | **9** | 0.12 | 22% | **−5.9%** | **−1.1%** | 0.57 |

Δret **+76pp**, Δoos **+19pp**, Δn **−81**. Still FULL/OOS ≤ 0 and PF &lt; 1.

## Decision

**`CONCEPT_HELPS_STILL_RED`**

- Keep invalidation + PD-after-CHoCH as **default correctness** on CHoCH paths.
- Do **not** treat as edge, sleeve, or paper-size candidate.
- N=9 on 17mo is **insufficient** (rulebook ≥30 OOS) — expected for selective
  confluence; further tests need multi-coin/TF pooling, not loosening mid-stream.
- Correct rules ≠ profitable rules (prerequisite psychological point confirmed).

## Next

Park BTC 15m SMC return-chasing. Reopen only with a **named** new failure mode
(e.g. 1H→15m structure, BNB honesty re-val, or pooled multi-symbol n≥30) — not
another filter stack on this practical path.
