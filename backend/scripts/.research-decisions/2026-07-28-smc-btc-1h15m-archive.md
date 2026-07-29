# BTC SMC 1H→15m — archive (2026-07-28)

## Mandate

BTC-only. Target **≥1 trade/day + profitable**. Do **not** green via N-crush
(rule: `.cursor/rules/smc-robustness-not-ncrush.mdc`).

## What shipped (infrastructure — keep)

- Completed-1H narrative + dealing-range POI: `techniques/htf1hNarrative.js`
- Wired opt-in: `intradaySmcRequireHtfNarrative`, `intradaySmcHtfPoiMode`
- Frozen ruleset updated; gap guide HTF step = yes
- Scripts: phase0 harvest, trade autopsy, narrative A/B, freq-path A/B

## Phase 0 harvest (practical, invalidation OFF)

| Window | n | /day | FULL | OOS | PF |
|--------|---|------|------|-----|-----|
| 2025-01→2026-06 | 90 | **0.17** | −81% | −20% | 0.14 |

Already far below ≥1/day before any HTF gate.

## Phase 1 autopsy (n=90, 82 losers)

| #1 mode | n | pnl |
|---------|---|-----|
| **wrong_htf_narrative** | 57 | −6.2k |
| wrong_htf_poi | 13 | −2.0k |
| mfe_giveback | 7 | −29 |

Named hypothesis: soft completed-1H alignment (block hard opposite bias only),
then 1H dealing-range POI — **concept fixes**, not random filters.

Winner patterns were mixed (some counter-1H winners) — hard narrative is not free.

## Phase 2–3 A/B (practical + H1)

| Variant | n | /day | FULL | OOS | PF |
|---------|---|------|------|-----|-----|
| baseline | 90 | 0.17 | −81% | −20% | 0.14 |
| h1_narrative | 27 | 0.05 | −37% | −8% | 0.09 |
| h1_narrative_dr | 13 | 0.03 | −12% | **+0.5%** | 0.24 |

Verdicts: `NARRATIVE_NCRUSH_STILL_RED`, `NARRATIVE_DR_NCRUSH_STILL_RED`.
Damage down; **PF not fixed**; N crushed; freq worse. Reject as edge.

## Frequency path (sweep + H1 context)

| Variant | n | /day | FULL | OOS | PF |
|---------|---|------|------|-----|-----|
| sweep_base | 52 | **0.10** | −26% | −14% | 0.52 |
| sweep_h1_narr | 10 | 0.02 | −13% | −4% | 0.17 |
| sweep_h1_dr | 9 | 0.02 | −10% | −5% | 0.20 |

Verdict: `FREQ_SHORT_STILL_RED` — even sweep reclaim on this window is **≪1/day**,
and still negative expectancy. H1 gates only starve further.

## Decision

**`ARCHIVE_BTC_SMC_1H15M_STREAM`**

- Root cause of mass losses: **15m fade fighting completed-1H structure** (autopsy).
- Fixing via hard narrative/POI reduces damage but **does not create PF≥1** and
  violates frequency mandate (0.17→0.03/day).
- Expanding to sweep does not reach ≥1/day on 2025–2026 BTC 15m and remains red.
- Do **not** paper-size. Do **not** starve further to green OOS.
- Keep 1H narrative module as research infrastructure (defaults OFF).

## Reopen only if

1. A **new trigger family** that naturally produces ≥1/day on BTC (not more gates
   on this practical/sweep stack), or
2. Explicit user accept of lower frequency **with** a validated PF≥1 sleeve, or
3. Multi-TF entry redesign with proven LTF multiplicity (e.g. many 15m fills inside
   a durable HTF POI) that first shows **freq≥1/day on harvest** before gates.

Artifacts: `.smc-btc-1h15m-phase0-harvest.json`, `.smc-btc-1h15m-phase0-tape.jsonl`,
`.smc-btc-1h15m-trade-autopsy.json`, `.smc-btc-1h15m-narrative-ab.json`,
`.smc-btc-1h15m-freq-path.json`.
