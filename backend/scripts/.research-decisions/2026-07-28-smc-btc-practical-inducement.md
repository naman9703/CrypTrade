# BTC SMC — practical sample + PD inducement A/B (2026-07-28)

## Agreement with critique

- `pd_array` SL: marginal (−2.71→−2.55, PF 0.56→0.63) on **n=6** — **not validated**, not shippable.
- n=6 is anecdote; need **n≥30** across regimes.
- April=0 under full GUIDE stack is a **strictness** signal, not missing data.

## Frequency ladder (BTC 15m, 2026 H1)

| Variant | n | tw/wk | ret | note |
|---------|---|-------|-----|------|
| Guide full (CHoCH+MSS+KZ+PD) | 6 | 0.28 | −2.6% | STARVED |
| −premium | 7 | 0.32 | −2.7% | STARVED |
| +KZ ALL | 17 | 0.79 | −11% | THIN |
| **−MSS (practical)** | **36** | **1.67** | −39% | n≥30, freq usable, deep red |
| Sweep (broken ref) | 54 | 2.5 | −49% | freq OK, worse edge |

Practical research baseline for concept tests: **CHoCH + retrace + `pd_array` SL, MSS off, KZ ALL, no premium**.

## Inducement fix (one change)

Opt-in `intradaySmcRequirePdInducement`: require pierce beyond OB/FVG far edge
**before** retrace entry (`smcInducement.js`). Default **off**.

### A/B — 2025-01-01 → 2026-06-01 (~74 weeks)

| | n | tw | WR | ret | PF | neverGreen |
|--|---|----|----|-----|-----|------------|
| baseline_practical | **114** | 1.55 | 9.6% | −95% | 0.15 | 26 (22.8%) |
| inducement_on | **55** | 0.75 | 14.5% | −59% | 0.19 | 15 (27.3%) |

- Sample size OK (both n≥30).
- Absolute never-green count down (−11); **rate up** — not a clean inducement cure.
- Less red but **PF≪1** — **REJECT / inconclusive**. Do not stack BE fix yet; do not ship.

## Decision

**`REJECT_INDUCEMENT_AS_EDGE`** on this practical ICT stack. Concept flag stays
available for further research. Next separate hypothesis only after a new named
failure mode on the n≥30 tape (e.g. BE buffer) — still no promote language.

Scripts: `research-smc-btc-practical-freq-ladder.mjs`,
`research-smc-btc-inducement-ab.mjs`.
Artifacts: `.smc-btc-practical-freq-ladder.json`, `.smc-btc-inducement-ab.json`.
