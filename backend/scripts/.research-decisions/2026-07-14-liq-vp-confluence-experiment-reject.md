# Experiment — LIQ + VP confluence (dual-gate composite)

Date: 2026-07-14  
Window: **2025-01-01 → 2026-06-01**  
Script: `backtest-liq-vp-confluence.mjs`  
Artifact: `backend/scripts/.liq-vp-confluence-results.json`  
Parent research: `2026-07-14-volume-profile-fundamentals-confluence-research.md`

## Hypothesis

Liquidity sweep = **trigger** (frequency). VP gate on same bar = **location** (quality).  
Dual-gate `SR_INTRADAY` composite with `minTechniqueCount: 2` requires both LIQ and VP technique tags without collapsing frequency vs LIQ solo.

## Variants tested

| ID | Description |
|----|-------------|
| `liq_solo` | `INTRADAY_PRO_LIQ_*` liquidity gate only (fast path on BNB) |
| `vp_intraday_gate` | `INTRADAY_PRO_VP_15M` VP gate only |
| `liq_vp_confluence` | Dual gate, `requireVpSetup: false` |
| `liq_vp_confluence_strict` | Dual gate, `requireVpSetup: true` |
| `vp_standalone` | `VOLUME_PROFILE_15M` Tier-A solo |

## Results

| Symbol | Variant | Trades | tr/wk | WR% | Return% | PF |
|--------|---------|-------:|------:|----:|--------:|---:|
| BNB | liq_solo | **75** | **1.02** | 61.0 | −3.06 | 0.96 |
| BNB | liq_vp_confluence | 1 | 0.01 | 0 | −4.08 | 0 |
| BNB | liq_vp_confluence_strict | 0 | 0 | — | 0 | — |
| BNB | vp_standalone | 3 | 0.04 | 66.7 | **+12.21** | 4.93 |
| ETH | liq_solo | 16 | 0.22 | 18.8 | −4.00 | 0.16 |
| ETH | liq_vp_confluence | 14 | 0.19 | **7.1** | −4.99 | 0.02 |
| ETH | liq_vp_confluence_strict | 0 | 0 | — | 0 | — |
| ETH | vp_standalone | 13 | 0.18 | 30.8 | **+16.93** | 1.31 |

VP intraday gate alone: **0 trades** on both coins (composite RSI stack incompatible as solo VP path).

## Target check (rulebook)

| Target | Result |
|--------|--------|
| ≥2 trades/week/coin | **FAIL** — best LIQ solo BNB 1.02/wk; confluence BNB 0.01/wk |
| Return > 0, PF ≥ 1 | **FAIL** — no variant meets both at frequency floor |
| Confluence beats LIQ solo | **FAIL** — BNB frequency −98.7%; ETH WR 18.8% → 7.1% |

## Verdict: **REJECT** dual-gate composite confluence

### Why it failed

1. **BNB path switch:** LIQ solo uses **fast path** (`listSessionLiquiditySetups`). Dual-gate disables fast path → slow `evaluateIntradayBar` loop. VP tag requirement collapses 80 picks → **2 picks → 1 trade**.

2. **ETH:** Frequency preserved (~14/16) but **VP filter hurt quality** — WR 7.1%, PF 0.02; exits still 13× `trail` scratch. VP confluence did not fix trail bleed.

3. **VP intraday gate solo:** 0 trades — `INTRADAY_PRO_VP_15M` without liquidity trigger does not fire on BNB/ETH in this window.

4. **VP standalone:** Positive return on tiny N (BNB 3, ETH 13) — **not deployable** per frequency floor, but confirms VP **levels** have edge when entries are extremely selective.

### What we learned (actionable)

- Textbook “club VP with liquidity” is correct **conceptually**  
- **Wrong implementation:** requiring VP technique tag inside composite bar scorer **on BNB** = frequency death  
- **Right next implementation:** keep LIQ **fast path**; add **VP proximity veto/boost** at sweep price (is reclaim within X bp of POC/VAH/VAL/HVN?)

## Next experiment (one change)

**Hypothesis:** LIQ entries at prices **near VP structure** (≤0.15% to POC/VAH/VAL/HVN) have better expectancy than sweeps in VP vacuum.

| Field | Value |
|-------|-------|
| Baseline | `INTRADAY_PRO_LIQ_15M` / `INTRADAY_PRO_LIQ_ETH_15M` fast path |
| Single change | `intradayLiqVpProximityMaxPct: 0.0015` — skip LIQ setup if no VP level within tolerance |
| Compare | baseline vs proximity-filtered (same window, costs) |
| Success | Frequency ≥50% of LIQ solo **and** PF ≥ 1.05 **and** return > 0 |

Alternate if proximity too tight: **VP proximity boost** (score +size) without hard veto.

Do **not** re-run dual-gate composite without fast-path parity.

## Code shipped (kept for research)

- Presets: `INTRADAY_PRO_LIQ_VP_CONFLUENCE_*`
- Script: `npm run backtest:liq-vp-confluence`
- Tests: preset unit test pass
