# BNB architecture fork (Liquidity Map + SMC) — REJECT (2026-07-24)

Coin: **BNBUSDT** 15m. Window: 2023-07-01 → 2026-07-01.  
Artifact: `.liq-bnb-arch-fork-year-grid.json`.  
Script: `research-liq-bnb-arch-fork-year-grid.mjs`.  
Context: CORE adaptive soft exhaust (`2026-07-24-liq-bnb-core-adaptive-soft-reject.md`).

## Hypothesis

CORE pierce+reclaim fade cannot be rescued by relative FT / continuous abstains. Different identification + entry (rolling Liquidity Map; SMC CHoCH→MSS→FVG retrace) may clear Y25/H12/FULL at tw≥2.

## Hard year-grid (fees + slip)

| Variant | FULL n / tw / ret / PF | Y25 ret | H12 ret | Gates |
|---------|------------------------|---------|---------|-------|
| CORE | 1034 / 6.6 / −99.7 / 0.65 | −3.0 | −1.9 | fail |
| LIQ_MAP_15M (BTC preset→BNB) | **16 / 0.1** / −9.7 / 0.66 | −4.5 | −4.6 | fail (freq crush) |
| SMC_SWEEP_15M | 438 / 2.8 / **−167** / 0.34 | −41.5 | −18.9 | fail (worse than CORE) |
| SMC_FULL_15M | **16 / 0.1** / −12.0 / 0.40 | +1.3 | −0.7 | fail (N tiny; H12 red) |

## Verdict

**FORK_REJECT** under same promote gates (FULL PF≥1 + Y25/H12 ret>0 + tw≥2).

- Liquidity Map stock 15m preset is **not** a freq+return path on BNB (N=16).
- SMC sweep profile has deployable freq but **worse** edge than CORE.
- SMC full (FVG-retrace sniper) greens Y25 on 3 trades — insufficient N / H12 fail.

## Infra delivered this cycle

- Relative FT modes in `passesGuideFollowThrough` (`fixed|atrPct|volSpike|regime`) — opt-in, CORE off.
- Autopsy + soft scripts; hard A/B correctly skipped on soft exhaust.

## Next (honest)

BNB 15m classical LIQ / Map / SMC stock presets are exhausted for returns+freq. Remaining forks need a **new** named failure mode (e.g. Map 5m two-bar runner coin-native tune, different TF, or multi-coin portfolio breadth) — not more CORE fade vetoes.
