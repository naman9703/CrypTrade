# 2026-07-25 — ZEC VP FREQ Phase 0 (next-5 stream)

## Verdict

**SOFT_REJECT / CHECKPOINT only — not a research sleeve.**

ZEC `va_rejection`-only (best OOS funnel) can be nudged OOS-green only by
denying bleed cells that **crush frequency far below the ≥2 trades/week floor**.
Do not promote. Pivot optimization effort to other next-5 coins with a
higher-frequency baseline that still has a salvageable edge.

## Window

- Symbol: `ZECUSDT` 15m futures
- Full: 2021-01-01 → 2026-05-31
- OOS cut: ≤ 2023-06-01
- Costs: risk 2.5%, lev 12, slip 5 bps; **funding was 0** on the first
  funnel pass (funding backfill started after)

## Phase 0 funnel screen

| Funnel | n | tw | FULL ret | OOS ret | note |
|--------|---|----|----------|---------|------|
| F0_open | 952 | 3.37 | −99.7% | −85.8% | open bleed |
| F1_val_rej | 552 | 1.96 | −97.9% | −68.8% | |
| F2_val_only | 462 | 1.64 | −96.2% | −61.1% | |
| **F3_rej_only** | **98** | **0.35** | **−36.6%** | **−27.5%** | least-bad OOS |
| F4_vah_val | 861 | 3.05 | −99.5% | −81.9% | |
| F5/F6 stacks | … | … | worse | worse | ETH-style stacks hurt ZEC |

Best OOS funnel = `F3_rej_only` — still red, and already **~6× below** freq floor.

## Cell autopsy (F3) — worst bleeds

1. `SELL|va_rejection|weak_bear|vacuum` (−21.6 / 18t)
2. `SELL|va_rejection|bull_chop|vacuum` (−19.1 / 9t)
3. `BUY|va_rejection|bull_chop|tight` (−15.6 / 5t)

Best positive cell (tiny N): `BUY|va_rejection|bull_trend|vacuum` (+24.4 / 10t)

## One-change / stacked denies vs F3

| Variant | n | tw | FULL | OOS | note |
|---------|---|----|------|-----|------|
| H0 F3 | 98 | 0.35 | −36.6% | −27.5% | |
| deny weak_bear vac | 80 | 0.28 | −22.7% | −2.2% | OOS almost flat |
| deny bull_chop vac | 89 | 0.32 | −15.5% | −22.4% | OOS not fixed |
| deny BUY chop tight | 93 | 0.33 | −22.3% | −24.4% | |
| deny top2 | 71 | 0.25 | **+3.0%** | **+4.6%** | green but tiny N/tw |
| deny top3 | 66 | 0.23 | **+26.3%** | **+9.0%** | 2022−23 still −24% |
| keep positive cells | 49 | 0.17 | **+64.8%** | **+11%** | N=22 OOS; freq dead |

## Why reject as sleeve

1. **Frequency floor failed** — best green path is 0.17–0.25 tw (target ≥2).
2. **N insufficient** — OOS n=22–29; rulebook ≥30 OOS before promote language.
3. **2022–23 residual red** even on keep-positive (−20%).
4. Green returns here are **harvest of denials on an already throttled funnel**,
   not a deployable edge. Rulebook: do not present ultra-low-freq as success.

## Next

1. Multi-coin Phase 0 screen (DOGE / NEAR / ADA / XLM) for any funnel with
   OOS≥0 **and** tw≥1 (prefer ≥2) before deep autopsy.
2. If none clear: try ZEC `F0`/`F1` with **coin-native cell prepared allowlist**
   only if autopsy shows high-N prepared positives — not more F3 N-crush.
3. Do **not** copy AVAX/ETH/BTC cell matrices onto ZEC.

## Artifacts

- `backend/scripts/.vp-freq-zec-phase0.log`
- `backend/scripts/.vp-freq-zec-phase0-resume.json`
- `backend/scripts/research-vp-freq-zec-phase0-resume.mjs`
- `backend/scripts/research-vp-freq-next5-phase0-screen.mjs`
