# Decision — Funding arb Phase 2

Date: 2026-07-14
Window: 2025-01-01 → 2026-06-01
Symbols: BTCUSDT, ETHUSDT
Fee stress: 1× | Notional: $10k/symbol | Perp lev: 5× | Min enter ann: 8%

## Result

| | BTC | ETH | Aggregate |
|---|---:|---:|---:|
| Trades | 45 | 50 | 95 |
| Gross funding | +287.52 | +291.10 | +578.62 |
| Fees | 1347.49 | 1498.95 | 2846.44 |
| Slip | 898.32 | 999.30 | 1897.62 |
| Basis | ~0 (spot=perp proxy) | ~0 | ~0 |
| **Net PnL** | **-1958.29** | **-2207.16** | **-4165.45** |
| Net ann. on capital | -11.56% | -13.03% | -24.59% |
| Honesty gate | FAIL | FAIL | **FAIL** |

## Root cause of FAIL

Gross funding is real (~$580) but **entry churn** (45–50 round-trips) pays dual-leg
taker fees + slip that dwarf funding income. Spot≈perp proxy (ohlcv PK cannot store
spot+futures side-by-side) so basis risk is not yet modeled — even *without* adverse
basis the strategy fails the honesty gate.

## Verdict

Net non-positive after costs — **NO-GO** for Phase 3 live/testnet. Do not promote.
No certified deployable substitute — SUPERTREND_ELITE deploy claims later revoked
(`2026-07-14-supertrend-elite-deployability-revoked.md`).

## If revisit later

1. Only under Phase 2b reopen criteria (extreme episodes / more symbols / real basis) — not threshold tweaks.
2. Store spot series without overwriting futures (separate table or source in PK).
3. Maker/limit dual-leg execution + unified margin before claiming Phase 3.

Artifacts: `.funding-arb-backtest.json`, `.funding-arb-backtest.md`
