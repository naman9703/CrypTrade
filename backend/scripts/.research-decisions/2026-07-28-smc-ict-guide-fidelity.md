# SMC/ICT guide vs code fidelity (2026-07-28)

## Premise

Prior BTC Phase 0 tested **`INTRADAY_PRO_ICT_15M` sweep** (CHoCH/MSS/retrace
**OFF**, killzone ALL). That is reclaim-liquidity, not the guide ICT sequence.
This note freezes a **GUIDE_ALIGNED** research cfg and records concept fidelity.

## Fidelity matrix

| Guide step | Implementation | Verdict |
|------------|----------------|---------|
| HTF structure (HH/HL) | 4H EMA + optional structure/parallel (`htfBias.js`) | PARTIAL — no daily dealing-range-first narrative |
| Liquidity pools | PDH/PDL + session clusters | PASS (crypto-adapted); session soft-pass allows micro-sweeps |
| Sweep then reject | `scanSessionLiquidityCycles` + reclaim | PASS |
| CHoCH after sweep | `detectChochInRange` after reclaim | PASS when required; OFF on sweep preset |
| BOS / MSS | BOS = swing break; MSS = BOS + displacement | PASS when required; OFF on sweep |
| OB = last opposing before impulse | `orderBlock.js` / `findObFromDisplacement` | PASS when MSS path; else loose active OB |
| FVG 3-candle | `fairValueGap.js` | PASS |
| Entry on return to OB/FVG | `RequireRetrace` + zone/CE | PASS when required; OFF on sweep |
| SL beyond OB far edge | `smcBrackets.js`: default sweep/structure; **`pd_array`/`ob_edge` opt-in** uses OB then FVG far edge | FIXED (opt-in) — was FAIL on defaults |
| TP next liquidity ≥1:2 | Opposing PDH/PDL + `intradaySmcMinRr` | PARTIAL |
| Killzones London/NY | Modes exist | PASS when set; sweep default ALL |
| Premium / OTE | Dealing-range + optional OTE | PASS when set; sweep OFF |

## GUIDE_ALIGNED cfg (research only — does not change BNB sweep defaults)

Frozen in `research-smc-btc-guide-month-autopsy.mjs`:

- `RequireChoch` + `RequireMss` + `RequireRetrace` = true (displacement-anchored FVG/OB)
- `EntryZoneMode` = EITHER, FVG entry = zone (retrace into array, not chase)
- `KillzoneMode` = LONDON_NY
- `RequirePremiumDiscount` = true (dealing-range; OTE off unless autopsy demands)
- `HtfBiasMode` = parallel, strictness either
- `PickMode` = per_signal (month tape needs all setups)
- `SlMode` = structure initially; autopsy may promote `ob_edge` if #1 failure

## Next

Month tape BTC 2026-04 → loss taxonomy → at most one concept fix.
