# SMC / ICT frozen ruleset (2026-07-28)

Companion: `backend/src/strategy/techniques/smcInvalidation.js`,
`backend/src/strategy/evaluateSmcIctSetup.js`,
`frontend/src/lib/smcIctGapGuide.ts`.

This is a **hypothesis under test**, not a certified edge. Correct execution of
these rules can still produce PF &lt; 1 (see BTC/XAU Phase 0 rejects).

## Sequence (must complete in order; no front-running)

1. **HTF narrative (1H→15m)** — `h1_aligned` / `RequireHtfNarrative`: side must
   respect completed-1H structure (`soft` = block opposite; `strict` = require
   same-direction). Optional dealing-range POI. Multiple 15m entries while valid.
2. **Liquidity raid** — SSL (BUY) / BSL (SELL) sweep + reclaim into that narrative.
3. **Displacement leg** (H1-aligned default) — impulse after raid; 15m CHoCH not
   required when 1H supplies narrative. Full profile still uses CHoCH→MSS.
4. **PD array** — FVG/OB from the displacement leg; retrace entry (not reclaim chase).
5. **Invalidation** — optional; default OFF on H1-aligned research to avoid N-crush.

## Invalidation (cancel setup — not the same as inducement)

| Code | Rule |
|------|------|
| `choch_reclaimed` | After CHoCH, a later **close** prints back through the CHoCH break level. |
| `ob_blown` | After OB prints, a later **close** prints through the protective edge (BUY: `&lt; bottom`, SELL: `&gt; top`). Wick pierce alone is **not** blown — that may be inducement. |
| `fvg_mitigated` | Between FVG form and entry, price wicks through the far edge (full fill). |
| `sweep_continuation` | After reclaim, a later **close** prints beyond the swept wick again — fade failed. |

Master flag: `intradaySmcEnforceInvalidation` — default **ON** for full/balanced
profiles and whenever `intradaySmcRequireChoch=true`. Default **OFF** for pure
sweep/lite (BNB reclaim baseline preserved).

Per-rule overrides: `intradaySmcInvalidateReclaimedChoch`,
`intradaySmcInvalidateBlownOb`, `intradaySmcRequireUnmitigatedFvgAtEntry`,
`intradaySmcRejectContinuationSweeps`.

## Inducement (opt-in, separate)

`intradaySmcRequirePdInducement` — requires a pierce beyond the PD far edge
**then** return into zone. This is a liquidity-grab filter, not invalidation.

## Structure vocabulary

- **BULLISH structure**: HH + HL. **BEARISH**: LH + LL. Else RANGE/UNKNOWN.
- **BOS**: close breaks last swing with the trend.
- **CHoCH**: close breaks key internal level against prior trend (when trend required).
- **Displacement**: directional body ≥ rolling avg body × mult and ATR fraction.
- **OB**: last opposing candle before a displacement candle.
- **FVG**: 3-candle imbalance; CE = midpoint.

## Risk (account — not signal quality)

- Fixed fractional risk per trade (engine sizing); SMC does not size by "quality score".
- Correlation / portfolio heat remain portfolio-layer concerns.

## Sample size / claims

- Do not promote from n &lt; 30 OOS (or pooled equivalent).
- Skip months with no valid setup rather than loosening mid-stream.
- Abstain reasons are stored on `pre._smcLastAbstain` for research taxonomy;
  accepted trades set `smcMeta.invalidationEnforced` / `trendState` / `failReason: null`.
