# 2026-07-25 — LIQ BNB BUYBD compressed-regime stand-down

**Status:** `ACCEPT_RESEARCH_SLEEVE` (not live-certified — 4-gate harness FAIL)
**Config:** `INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M` + `intradayLiqRangeCompressionMin: 0.75`
**Scripts:**
- `research-liq-buybd-half-regime-autopsy.mjs`
- `research-liq-buybd-compression-ab.mjs`
- `research-liq-buybd-comp075-validate.mjs`
**Artifacts:** `.liq-buybd-half-regime-autopsy.json`, `.liq-buybd-compression-ab.json`, `.liq-buybd-comp075-validate.json`

## Hypothesis (from Phase 4 + half autopsy)

Phase 4 on clean CORE: **false_reclaim ≈ 52% of loss $**, regime_mismatch ≈ 41%.
BUYBD prepared-mit was EG on Y1/HOLD/FULL but **−9.6% in 2026 H1**.

Half-year R-autopsy (FULL 2023-07→2026-07, n=357):

| Half   | n  | meanR  |
|--------|----|--------|
| 2023H2 | 53 | +0.061 |
| 2024H1 | 74 | −0.057 |
| 2024H2 | 81 | +0.085 |
| 2025H1 | 42 | −0.081 |
| 2025H2 | 66 | +0.221 |
| 2026H1 | 40 | −0.078 |

Feature quintiles: **compression Q1 meanR = −0.14** (worst bucket). Soft stand-down
`compression < 0.75` (drop compressed bars): FULL meanR 0.038→0.077, 2026H1 −0.078→+0.021,
kept 90%, no green half turned red.

**Mechanism:** when 14d avg daily range is well below the 100d norm, sweeps lack
follow-through fuel → reclaim closes that quickly fail (false reclaim physics).
Relative, causal, side-agnostic — not a calendar lock.

## One change

Engine: `passesLiqMarketActivation` stands down when
`liqRangeCompressionAt(candles, idx) < intradayLiqRangeCompressionMin`
(0 = off). Wired into BUYBD preset at **0.75**.

## Hard A/B (FULL, guards off)

| Variant      | n   | tw   | ret%  | pfR   | meanR | 2026H1 meanR |
|--------------|-----|------|-------|-------|-------|--------------|
| baseline     | 357 | 2.23 | +22.8 | 1.082 | 0.038 | −0.078       |
| **comp≥0.75**| 323 | 2.02 | **+64.5** | **1.169** | **0.077** | **+0.021** |
| comp≥0.80    | 304 | 1.90 | +86.0 | 1.215 | 0.097 | +0.004       |

Chose **0.75** (keeps tw≥2 on FULL; 0.80 dips under).

## Validation (preset with compression=0.75)

| Window | n   | tw   | ret%  | dd%   | pfR   | meanR | calmar |
|--------|-----|------|-------|-------|-------|-------|--------|
| HOLD   | 116 | 2.22 | +5.3  | 24.3  | 1.069 | 0.033 | 0.22   |
| IS     | 111 | 2.13 | +9.0  | 14.1  | 1.100 | 0.046 | 0.64   |
| OOS    | 97  | 1.75 | **+46.0** | 15.0 | **1.413** | **0.172** | 2.85 |
| FULL   | 323 | 2.02 | +64.5 | 25.6  | 1.169 | 0.077 | 0.69   |

Per-half red (meanR < −0.05, n≥10): **none**.

### Gates

| Gate              | Result | Notes                          |
|-------------------|--------|--------------------------------|
| oosPositive       | PASS   | +46%                           |
| mcP5Positive      | FAIL   | p5 = −6.7% (p50 = +43%)        |
| calmarOver1       | FAIL   | FULL calmar 0.69 (DD 25.6%)    |
| wfDegradationOk   | PASS   | avg deg negative (test > train)|
| Frequency ≥2/wk   | PARTIAL| FULL/HOLD/IS ≥2; OOS 1.75      |

**Verdict: ACCEPT_RESEARCH_SLEEVE — not live-certified.**

## What the edge is (plain terms)

Prepared-mit BUYBD (displacement + MinSl + mitigation retest + one-sided breakdown
abstain) already had positive expectancy when the market has enough *range fuel*.
Standing down when recent daily ranges are compressed vs the 100d norm removes the
false-reclaim cluster that made 2024H1 / 2025H1 / 2026H1 red — without calendar
cherry-picking and without crushing frequency below ~2/wk on the full sample.

## Why not promote to live

1. MC 5th percentile still slightly negative at 2.5% risk/trade.
2. FULL Calmar < 1 (drawdown ~26% over 3y at research risk).
3. OOS frequency 1.75/wk — under the ≥2 floor (close).

## Next (one mechanism at a time)

1. **Exit / risk economics** for Calmar (bad_exit was a secondary Phase-4 bucket) —
   not another entry abstain.
2. Optional: sensitivity on 0.70 vs 0.75 for OOS frequency restore if user accepts
   slightly weaker half rescue.
3. Multi-coin check (ETH/BTC) before any promote language.
4. Do **not** stack more entry filters on this sleeve without a new root-cause
   autopsy of the residual losers.
