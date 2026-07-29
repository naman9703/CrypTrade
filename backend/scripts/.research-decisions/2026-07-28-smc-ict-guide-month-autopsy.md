# SMC/ICT guide month autopsy + pd_array SL fix (2026-07-28)

## Phase A — fidelity

See `2026-07-28-smc-ict-guide-fidelity.md`. Sweep preset ≠ guide sequence.
GUIDE_ALIGNED cfg: CHoCH + MSS + Retrace + LONDON_NY + premium/discount.

## Phase B — tape

April 2026 alone: **0 trades** (stack too selective that month).
Pooled **2026-01-01 → 2026-06-01** BTC 15m GUIDE_ALIGNED (`sl=structure`):

| n | WR | ret | PF | losers |
|---|----|-----|-----|--------|
| 6 | 16.7% | −2.71% | 0.56 | 5 |

All 6 had CHoCH+MSS+retrace (true ICT path). No chase-reclaim entries.

### Loss taxonomy (structure SL)

| Primary mode | n | PnL |
|--------------|---|-----|
| `sl_not_ob_edge_fvg_only` (FVG entry; SL from sweep/structure not array) | 4 | −326 |
| `never_green_inducement` | 1 | −291 |

**#1 = SL geometry vs guide** (PD-array edge), matching fidelity FAIL.

## Phase C — one concept fix

Implemented `intradaySmcSlMode: "pd_array"` | `"ob_edge"` in
[`smcBrackets.js`](../src/strategy/techniques/smcBrackets.js):

- SL = just beyond OB far edge if present, else FVG far edge
- Does **not** widen to sweep wick (guide: stop beyond the array)
- Orchestrator passes `ob`/`fvg` into brackets
- Defaults unchanged (`structure` / `sweep`); opt-in only
- Unit tests in `smcBrackets.test.mjs`

### Same-window retest (`SL_MODE=pd_array`)

| | structure | pd_array |
|--|-----------|----------|
| n | 6 | 6 |
| WR | 16.7% | 16.7% |
| ret | −2.71% | **−2.55%** |
| PF | 0.56 | **0.63** |
| Winner (Feb 19) | +345 | **+427** |

After fix + `initialSlPrice` taxonomy:

| Primary mode | n | PnL |
|--------------|---|-----|
| `concept_ok_still_lost` | 1 | −358 |
| `never_green_inducement` | 1 | −291 |
| `micro_sweep` (BE scratches) | 3 | −33 |

SL no longer misaligned with FVG/OB. Residual losses are inducement / adverse excursion, not geometry bugs.

## Decision

- **Concept bug fixed:** SL can now follow guide PD-array edge (`pd_array`).
- **Edge not proven:** GUIDE_ALIGNED BTC H1’26 remains negative on n=6 — do not promote.
- Next (separate hypothesis): never-green inducement filter, or require OB (not FVG-only),
  or structure-scan perf for multi-year — **one at a time**.

Artifacts: `.smc-btc-guide-month-autopsy.json`, `.smc-btc-guide-month-structure.json`,
`.smc-btc-guide-month-pd-array.json`, script `research-smc-btc-guide-month-autopsy.mjs`.
