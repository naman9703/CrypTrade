# BTC SMC H1-aligned raid — attempt to make setup work (2026-07-28)

## Ask

Implement the necessary contract and get the setup robust + profitable
(≥1 trade/day where possible; no N-crush as “solution”).

## What was implemented

**Contract** (`intradaySmcIctProfile: "h1_aligned"` / `INTRADAY_PRO_ICT_H1_ALIGNED_15M`):

1. Completed-1H narrative alignment (soft/strict)
2. Liquidity raid on 15m (existing sweep cycles)
3. **Displacement leg** after raid (no mandatory 15m CHoCH — 1H is narrative)
4. Displacement-anchored FVG/OB + **retrace** entry
5. Multi entries/day while narrative valid

Modules: `displacementLeg.js`, updates to `evaluateSmcIctSetup.js`,
`htf1hNarrative.js` (strictness), preset `INTRADAY_PRO_ICT_H1_ALIGNED_15M`.

## A/B — 2025-01-01→2026-06-01 (OOS 2025-10-01)

| Variant | n | /day | WR | FULL | OOS | PF |
|---------|---|------|-----|------|-----|-----|
| baseline practical | 90 | 0.17 | 8.9% | **−81%** | −20% | 0.14 |
| h1_aligned_soft | 42 | 0.08 | 16.7% | −47% | −21% | 0.17 |
| h1_aligned_strict | 37 | 0.07 | 16.2% | −44% | −24% | 0.15 |
| h1_aligned_strict_dr | 16 | 0.03 | 12.5% | −18% | −4% | 0.18 |

All `HELPS_STILL_RED`. Contract reduces damage; **does not create edge**.

## Residual one-change fixes (on h1_soft)

| Fix | n | FULL | OOS | PF | note |
|-----|---|------|-----|-----|------|
| +MSS | 49 | −49% | −22% | 0.20 | no help |
| **maxHold 16** | 42 | **−40%** | **−19%** | **0.22** | best; giveback 13→7 |
| BE after partial | 42 | −47% | −21% | 0.17 | no-op vs soft |

## Decision

**`REJECT_EDGE_H1_ALIGNED_STILL_RED`**

- Root cause address (fight 1H) was correct directionally.
- Best research checkpoint: **h1_aligned_soft + maxHold16** (−40% / PF 0.22) —
  **not** profitable, **not** ≥1/day (0.08/day).
- Do **not** paper-size. Do **not** starve further to force green OOS.
- Preset kept as research scaffold with maxHold16; defaults do not promote.

## Why “get it working” failed honestly

BTC 15m SMC fades, even when H1-aligned and displacement-anchored, still have
**PF ≪ 1**. Frequency floor (≥1/day) is structurally unmet by this liquidity-raid
family on 2025–2026. Next reopen needs a **different trigger family** that can
harvest ≥1/day with positive expectancy — not more gates on this stack.

Artifacts: `.smc-btc-h1-aligned-ab.json`, `.smc-btc-h1-aligned-residual.json`.
Scripts: `research-smc-btc-h1-aligned-ab.mjs`, `research-smc-btc-h1-aligned-residual.mjs`.
