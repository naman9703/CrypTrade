# Experiment — LIQ + VP proximity (fast path)

Date: 2026-07-14  
Window: **2025-01-01 → 2026-06-01**  
Script: `backtest-liq-vp-proximity.mjs`  
Artifact: `backend/scripts/.liq-vp-proximity-results.json`  
Parent: `2026-07-14-liq-vp-confluence-experiment-reject.md`

## Hypothesis

Keep LIQ **solo fast path** (frequency). Add **one** entry filter: sweep level must be within X bp of VP structure (POC/VAH/VAL/HVN). Sweeps at auction nodes should have better expectancy than sweeps in VP vacuum.

## Variants

| ID | Change |
|----|--------|
| `liq_solo` | Baseline — no proximity filter |
| `proximity_15bp` | `intradayLiqVpProximityMaxPct: 0.0015` |
| `proximity_25bp` | `0.0025` |
| `proximity_35bp` | `0.0035` |

VP map: rolling 384 bars, close-weighted (Tier-A settings).

## Results

| Symbol | Variant | Trades | tr/wk | WR% | Return% | PF | Picks |
|--------|---------|-------:|------:|----:|--------:|---:|------:|
| BNB | liq_solo | **75** | **1.02** | 61.0 | **−3.06** | **0.96** | 80 |
| BNB | proximity_15bp | 12 | 0.16 | 43.8 | −12.32 | 0.44 | 15 |
| BNB | proximity_25bp | 22 | 0.30 | 41.4 | −18.61 | 0.41 | 25 |
| BNB | proximity_35bp | 28 | 0.38 | 44.4 | −20.08 | 0.51 | 32 |
| ETH | liq_solo | **16** | **0.22** | 18.8 | −4.00 | 0.16 | 16 |
| ETH | proximity_15bp | 3 | 0.04 | 33.3 | −2.49 | 0.15 | 3 |
| ETH | proximity_25bp | 3 | 0.04 | 33.3 | −2.49 | 0.15 | 3 |
| ETH | proximity_35bp | 6 | 0.08 | 16.7 | −3.11 | 0.12 | 6 |

## Target check

| Target | Result |
|--------|--------|
| ≥50% of LIQ solo frequency | **FAIL** — BNB 16–37%; ETH 19–38% |
| Return > 0, PF ≥ 1 | **FAIL** — all proximity variants negative; BNB much worse than baseline |
| Better than LIQ solo | **FAIL** — BNB PF 0.96 → 0.41–0.51; ETH unchanged |

## Verdict: **REJECT** hard VP proximity veto

### Why it failed

1. **BNB:** Proximity filter keeps sweeps near VP nodes but **WR collapses** 61% → 41–44% and losses deepen (−3% → −12% to −20%). VP-near sweeps on BNB are **not** higher quality with current partial-TP exit ladder.

2. **ETH:** Filter barely fires (3–6 trades). Trail scratch pattern unchanged (5× trail on 35bp). Slightly smaller loss on 15bp (−2.5% vs −4%) is **not** success — PF still 0.15, N=3.

3. **Looser tolerance hurts BNB more:** 35bp retains more trades but **more negative** return — widening proximity does not recover edge.

### Interpretation

VP location alone does not fix LIQ expectancy. The losing mass on BNB is not primarily "sweeps away from POC" — it's exit/time-stop bleed on otherwise high-WR entries. On ETH the problem remains trail-only scratch exits.

## Next experiment (one change, ordered)

1. **BNB exit-only** — partial TP → runner trail on `INTRADAY_PRO_LIQ_15M` (hypothesis: time_stop mass is the failure mode, not entry location).
2. **VP proximity boost (soft)** — score +size when near VP, no hard veto (only if exit experiment shows entry quality is not the bottleneck).
3. **Flow confirm** — taker delta at sweep bar when VP level touched.

Do **not** stack proximity + flow + exit in one run.

## Code kept (research)

- `intradayLiqVpProximityMaxPct` on LIQ fast path (`intradayPro.js`)
- Presets: `INTRADAY_PRO_LIQ_VP_PROXIMITY_*`
- UI: "BNB+ETH LIQ+VP Proximity (research)" button
- `npm run backtest:liq-vp-proximity`
