# Decision — LIQ_CORE autopsy + optimize (EDGE FAIL at high frequency)

Date: 2026-07-23  
Window: **2025-01-01 → 2026-06-01**  
Coins: BNB / ETH / BTC 15m  
Artifacts: `.liq-core-autopsy.json`, `.liq-core-optimize-ab.json`, `.liq-core-optimize-r2.json`, `.liq-core-optimize-r3.json`  
Doctrine: `docs/LIQ_CORE_PLAYBOOK.md`

## Autopsy (BNB CORE, n=539, tw=7.3, PF 0.31)

| Failure mode | Evidence |
|--------------|----------|
| **Payoff asymmetry** | SL exits 272 / **−$201**; winners 139 / **+$66**; time_stop + tp2 are only profitable buckets |
| **Instant death** | `never_green` + `sl_no_follow` ≈ **−$165**; barsHeld 0–4 = **−$76** |
| **Trend-day toxic fades** | BUY@breakdown + SELL@breakout = −$49 — **secondary** on BNB (unlike BTC 2025) |
| **Range fades** | Also lose (−$86) — not “just trend days” |

## Optimize A/B (preserve ≥50% CORE frequency where possible)

Tested: reclaim hold, displacement, early BE, partial size, TP1 R, extension, post-disp, shorter hold, PDH/PDL-only, HTF-real, hybrid legacy quality, **wired London/NY killzone**, HTF-on-PDH/PDL flag.

| Result | Verdict |
|--------|---------|
| Early BE | Worse PF (~0.05) — scratches winners |
| Killzone (after bugfix) | Cuts N (7.3→3.8/wk) **and** worsens BNB PF (0.17) |
| Hybrid legacy quality | Best PF among high-ish N still **0.45** at ~1.1/wk — still negative |
| All high-freq variants | **PF ≤ ~0.35**, large negative return |

## Implementation fixes shipped (not edge)

1. `intradayLiqRequireKillzone` now works **without** requiring `MarketStateGate` ([`marketState.js`](../src/strategy/techniques/liq/marketState.js)).
2. `intradayLiqHtfAlignPdhPdl` applies HTF align to PDH/PDL when set ([`liquidity.js`](../src/strategy/techniques/liquidity.js)).

## Verdict

**REJECT promotion of any “LIQ_CORE optimized” live preset.**  
Frequency is solved; **classical fade expectancy after costs is not.** Do not re-stack entry filters hoping for PF≥1 at ≥2/wk — data rejects that path on this window.

## Next (structural — not filter piles)

1. Redesign **exit** as primary research: runners that capture the 33+ bar positive cohort without full-R SL on noise.
2. Or rewrite **playbook** (with-trend continuation / different TF) under a new hypothesis — day-router remains banned until a non-naive design.
3. Keep `LIQ_CORE` as the **live-faithful harvest baseline** for that work.
