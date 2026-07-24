# LIQ_CORE — next after dead-trade: multi-coin + path-confirm (2026-07-23)

## Status of prior “blocked” work

Dead-trade A/B **already completed** (DB was reachable). Verdict unchanged:

- **D\* REJECT** — clips slow runners (winner $ 97→76).
- **T1** (`maxTpRr=2`) already wired.
- Engine `intradayLiqDeadTrade*` stays **off** on CORE.

Artifacts: `.liq-core-rootcause-deadtrade.json`, `.liq-core-deadtrade-r2.json`,  
`2026-07-23-liq-core-deadtrade-reject.md`.

## This pass (what was actually next)

Hypothesis from the WHY: failure is **post-reclaim path**, not missing HTF/session labels.  
Dead-trade compresses after entry and clips runners. Alternative that matches liquidity concept:

**Path-confirm entry** — wait N bars after reclaim before entry (`reclaimHoldBars`), so same-bar / instant-fail reclaims get a chance to invalidate *before* capital is deployed. Not an HTF/killzone veto; not dead-trade.

Also: multi-coin honesty on CORE+X4+T1; oracle upper bound on instant-death skip.

Script artifact: `.liq-core-next-playbook-probe.json`.

## Multi-coin CORE+X4+T1 (2025-01→2026-06)

| Coin | n | /wk | Ret% | PF | Instant $ |
|------|---|-----|------|----|-----------|
| BNB | 554 | 7.52 | −99.3 | 0.53 | −168 |
| ETH | 247 | 3.35 | −75.8 | 0.71 | −181 |
| BTC | 613 | 8.32 | −99.9 | 0.45 | −141 |

All **EDGE FAIL**. Classical fade is not coin-local noise.

## Oracle upper bound (BNB H0)

Skip `never_green` + `sl_no_follow` after the fact → **n=298, PF 2.54, ret +69%**.

**Interpretation:** latent edge exists in the follow-through cohort. Dead-trade could not separate it *live*. Need path/playbook changes that approximate this without look-ahead.

## BNB path / mode A/B vs H0 (X4+T1)

| Variant | n | /wk | Ret% | PF | freqOk | Verdict |
|---------|---|-----|------|----|--------|---------|
| H0_x4_t1 | 554 | 7.52 | −99.3 | 0.534 | yes | baseline |
| **P1 hold2** | **475** | **6.44** | **−93.0** | **0.595** | yes | **PROMOTE mild** |
| P2 hold3 | 451 | 6.12 | −94.0 | 0.557 | yes | weaker than P1 |
| P3 trend_pullback | 201 | 2.73 | −88.3 | 0.382 | **no** | REJECT (N crush + worse PF) |
| P4 pdh/pdl only | 447 | 6.06 | −97.1 | 0.507 | yes | REJECT |
| P5 hold2+trendPB | 176 | 2.39 | −65.2 | 0.592 | **no** | REJECT freq |

## Actions

1. Wire **P1:** `intradayLiqReclaimHoldBars: 2` on CORE (backend + frontend).
2. Keep X4 + T1; keep dead-trade **off**.
3. Do **not** enable `trend_pullback` entry mode on CORE.
4. Still **EDGE FAIL** (PF ~0.60). Classical fade + path tweaks insufficient for PF≥1.

## Next playbook (named)

**LIQ_ACCEPT (sweep acceptance / failed-fade continuation)** — separate stream from CORE fade:

- Named failure: many “reclaims” are **false** — auction accepts the pool pierce and continues.
- Setup: sweep named pool → **close holds beyond** for N bars (no successful reclaim) → enter **with** the sweep; SL back inside pool; target next opposing liquidity.
- Explicitly **not** the banned naive day-router EMA-fade spam (`evaluateTrendContinuationSetup`).
- Promote only if PF/ret beat CORE+P1 **and** freq ≥~60% of CORE (~4.5/wk) or honest multi-coin ≥2/wk pooled.

## Verdict

**DEAD-TRADE already REJECTED.**  
**P1 path-confirm PROMOTE (mild).**  
**Classical fade stream remains EDGE FAIL** — next = implement/test LIQ_ACCEPT, not more context filters.
