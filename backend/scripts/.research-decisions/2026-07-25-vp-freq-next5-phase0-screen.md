# 2026-07-25 — VP FREQ next-5 Phase 0 screen

## Verdict

**Coin priority for deep work:**

1. **DOGEUSDT `F3_rej_only`** — best *usable* green baseline (OOS +28%, FULL +42%,
   multi-year mostly green). Still **tw≈0.36** (freq floor fail) → next = year/setup
   autopsy → one regime rule → then **freq restore**, not more N-crush.
2. **NEARUSDT `F3_rej_only`** — strongest raw OOS (+54% / FULL +79%) but more red
   mid-years; same freq problem. Queue after DOGE.
3. **ZECUSDT** — already soft-rejected (`2026-07-25-zec-vp-freq-phase0-soft-reject.md`).
4. **XLM / ADA** — no clean green FULL+OOS path at usable N; defer.

Do **not** promote any of these yet. None meet ≥2 tw or validation gates.

## Window

2021-01-01 → 2026-05-31, OOS ≤ 2023-06-01, 15m futures, FREQ CORE, funding loaded.

## Rank (OOS ret)

| Symbol | Funnel | OOS | FULL | tw | note |
|--------|--------|-----|------|----|------|
| NEAR | F3_rej_only | **+54.1%** | **+78.8%** | 0.37 | best raw; mid-years mixed |
| DOGE | F3_rej_only | **+28.4%** | **+41.9%** | 0.36 | **primary next** |
| NEAR | F1_val_rej | +24.7% | −74.6% | 1.98 | OOS green / IS destroyed — reject |
| XLM | F3_rej_only | +5.3% | −35.9% | 0.28 | OOS-only mirage |
| NEAR | F0_open | +2.5% | −88.5% | 3.56 | OOS-only mirage |
| ZEC | F3 | −27% | −37% | 0.35 | soft-reject |
| ADA | F3 | −59% | −1.9% | 0.39 | IS green / OOS red — reject |
| *all F0 / most F1* | | deep red | deep red | ~2–3 | open bleed |

## DOGE F3 year split (why primary)

| Year | n | ret |
|------|---|-----|
| 2020-21 | 14 | −8.6% |
| 2021-22 | 22 | +13.6% |
| 2022-23 | 22 | +23.7% |
| 2023-24 | 17 | +28.2% |
| **2024-25** | 19 | **−37.5%** | ← first named failure to autopsy |
| 2025-26 | 9 | +37.9% |

## Next experiment (one change)

1. DOGE `F3_rej_only` cell + feature autopsy on **2024-25 losers vs winners**
   (and vs same cells in 2023-24 / 2025-26).
2. Write behaviour table → ONE causal rule → hard A/B (must not crush good years).
3. Only after that: frequency restore by selectively adding setups/cells with
   coin-native evidence — never copy ETH/BTC allowlists.

## Artifacts

- `backend/scripts/.vp-freq-next5-phase0-screen.json`
- `backend/scripts/.vp-freq-next5-phase0-screen.log`
- `backend/scripts/research-vp-freq-next5-phase0-screen.mjs`
