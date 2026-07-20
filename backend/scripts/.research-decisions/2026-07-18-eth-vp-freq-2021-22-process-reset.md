# 2026-07-18 — ETH 2021–22: return to regime process (no random patches)

## Correction

Recent work drifted into **CF-slice hunting** and **BTC-style cell deny / surgical
stacks** without completing the process that already fixed ETH **2022–23 → 2025–26**.

That process (macro-adapt, vacuum path, weak-bear HTF, vacuum prior5d, chop trail):

1. Name the **year’s market character**
2. Compare setup P&L + features to a **strong reference year**
3. Separate **universal** vs **year-specific** levers
4. Write a **behaviour table** (condition → desired action)
5. **One** adaptive rule → full sim on **all** years
6. LOCK only if bad year improves **and** trained lock edge holds

Copying BTC prepared-regime allowlist crushed the user’s ~164t/+483% path → **rejected**.
Surgical bull60 dump/nonvac improved numbers but was still a **shortcut** relative to
the full year-regime method — residual CF hunting after that was the wrong path.

## Process of record

`docs/VP_FREQ_REGIME_OPTIMIZATION_PROCESS.md`

## This cycle (2021–22)

| Phase | Artifact | Status |
|-------|----------|--------|
| 0 Baseline | ABC adaptive stack (~485% lock class); surgical OFF in autopsy | running |
| 1–2 Autopsy | `research-vp-freq-eth-2021-22-regime.mjs` | running |
| 3 Behaviour table | decision follow-up after autopsy | pending |
| 4 One-change A/B | only after behaviour table | **not started** |
| 5 LOCK | only if multi-year full sim passes | **not started** |

## Rules for this stream going forward

- No new ETH knobs until Phase 3 behaviour table is written from autopsy.
- No BTC cell allowlist/deny on ETH.
- No harvest-only “drop thin cells” locks.
- Coin-native adaptive rules only.

## Status

**Process reset.** Not a new promote. Surgical flags on the preset remain interim
until the regime autopsy names the 2021–22 physics and a proper one-change lock
replaces or confirms them.
