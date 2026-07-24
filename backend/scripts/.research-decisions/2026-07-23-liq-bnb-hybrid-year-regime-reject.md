# BNB LIQ — hybrid router + year-regime pass (2026-07-23)

Coin: **BNBUSDT**. Baseline: CORE X4+T1+P1+X5. Window: 2023-07 → 2026-07.  
Process: VP-style year flip start at **Y2025** (`docs/VP_FREQ_REGIME_OPTIMIZATION_PROCESS.md`).  
Artifacts: `.liq-bnb-year-regime.json`; hybrid A/B terminal log.

---

## Y2025 baseline (closest-to-flat year)

| Window | N | tw | ret% | PF |
|--------|---|----|------|---|
| Y2025 | 343 | 6.6 | **−3.0** | **0.75** |
| Y2024 | 377 | 7.2 | −36.7 | 0.65 |
| H12m | 329 | 6.3 | −1.9 | 0.66 |
| FULL | 1034 | 6.6 | −99.7 | 0.65 |

No year is PF≥1 / ret>0. Soft FULL “PF>1” cells (`!toxic+multi+macro`) were **2023-driven**; multiBar is **year-specific** (helps 2023, hurts 2025).

---

## Hard A/B — hybrid ACCEPT on trend / fade on range

| Variant | Y25 PF / ret | Y24 ret | H12 ret | FULL PF | Verdict |
|---------|--------------|---------|---------|---------|---------|
| H0 | 0.75 / −3.0 | −36.7 | −1.9 | 0.65 | baseline |
| HY1 router | **0.48** / −2.3 | −26.2 | −0.2 | 0.63 | **REJECT** (ACCEPT spam; WR↓) |
| HY2 + tox | 0.47 / −2.0 | −23.8 | −0.2 | 0.62 | **REJECT** |
| HY3 + macro | 0.45 / −3.7 | −24.4 | −0.4 | 0.62 | **REJECT** |
| HY4 tox+macro | 0.44 / −3.4 | −24.3 | −0.4 | 0.62 | **REJECT** |
| HY5 + mit | 0.44 / −4.5 | −38.4 | −0.4 | 0.71 | **REJECT** |
| RANGE_only_tox | 0.82 / **−8.2** | −46.6 | −10.4 | 0.73 | **REJECT** (PF↑, ret worse) |

Follow-up: weekly/asian levels, ACCEPT-only+ext/disp, killzone — **none** flipped Y25 to PF≥1 / ret>0.

---

## Implementation note (liquidity concepts)

Sweep/reclaim/PDH-PDL/session pools + chronological picks are **wired correctly**. Most “proper” liquidity layers (HTF pools, killzone, toxic/macro, mitigation, ACCEPT, hybrid) exist as **opt-in** and were A/B’d; they do **not** produce holdout-valid edge on BNB classical fade. Failure mode remains **instant no-follow** (not missing session labels).

---

## Verdict

**REJECT** hybrid router and year-regime abstain stack as BNB promote path.  
Plumbing stays **off** on CORE (research-only). Still **EDGE FAIL**.

---

## Next approach (ordered — do not re-run rejected stacks)

1. **Freeze** classical CORE as harvest baseline only (not deploy).
2. **VP Phase 2 physics on Y2025 winners vs instant-death losers only** — hunt a **universal at-entry discriminator** for the oracle skip cohort (~78% of loss $). If none exists after coin-native feature sweep → classical fade is not a BNB primary stream.
3. **If (2) fails:** rebuild **LIQ_BNB_STOPRUN** as a **new** playbook (with-trend failed-reclaim / displacement continuation on weekly+PDH pools) designed on Y2025→H12 first, then walk Y2024 with relative rules — not more fade vetoes.
4. Parallel: if capital research time is scarce, prefer **VP FREQ BNB** prepared sleeve (already has positive-expectancy research path) over more CORE fade knobs.

Do **not** year-hardcode. Do **not** claim profitable without hard Y25 + H12 + FULL PF≥1 and ret>0.
