# Decision — Volume Profile accuracy upgrade (session developing VP)

Date: 2026-07-14  
Stream: `VOLUME_PROFILE` / SR_INTRADAY VP gate

## Research (Auction Market Theory)

Correct intraday VP includes session/composite developing value. We implemented
`session_utc` and `composite_utc` engines, but honesty backtests (2025-01→2026-06)
show **rolling Tier-A** is the only mode that is net-positive under production
gates. Production default remains **`rolling` + close-weighted**; session/composite
are research modes.

See also: `2026-07-14-volume-profile-profitability.md`.

## Implementation (accuracy first — not yet gate-certified edge)

In `backend/src/strategy/techniques/volumeProfile.js`:

1. Default `vpProfileMode: "session_utc"` developing profile
2. Integer bin indices (no float price-key merge bugs)
3. Configurable `vpValueAreaPct` (default 0.70)
4. `vpVolumeDistribute: close_weighted | uniform`
5. Prior session attach + `nakedPoc` / `naked_poc` setup
6. Legacy `mode: "rolling"` retained for research compare

Wired through: standalone strategy, `intradayPro`, order-flow key levels, entry
context, `VOLUME_PROFILE_*` + `INTRADAY_PRO_VP_15M` presets.

## Tests

`volumeProfile.test.mjs` + `volumeProfileStrategy.test.mjs` pass (session + naked POC coverage).

## Next (do not skip)

1. Smoke backtest `npm run backtest:volume-profile` under session mode vs rolling compare
2. Only then run WF/MC — accuracy fix ≠ validated edge
3. Continue intraday series: liquidity sweep / SMC next, same research→implement loop

## Explicit non-claims

Not certified for live capital. Tick footprint still missing. Asian/EU/US sub-session
templates optional later (`vpSessionTemplate`) — UTC day is the locked default for now.
