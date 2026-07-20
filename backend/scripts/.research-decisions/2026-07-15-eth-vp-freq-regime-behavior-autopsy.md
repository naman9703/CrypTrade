# 2026-07-15 — ETH VP FREQ deep regime autopsy (2022–23 vs 2025–26)

**User mandate:** Do **not** “solve” a bad year by cutting trades to +0.8%. Find why the
same setup fails, and change **behaviour** so it stays robust across regimes.

**Data:** `research-vp-freq-eth-regime-autopsy.mjs` → `.vp-freq-eth-regime-autopsy.json`  
**Runs:** same FREQ ETH preset, chase OFF, vacuum mode breakout.

## What “+124% vs −9%” actually is

| Component | 2022–23 | 2025–26 | Read |
|-----------|--------:|--------:|------|
| SELL `val_breakdown` | **+$22** (28t, 36% WR) | **+$101** (34t, 50% WR) | Same setup; **follow-through** differs |
| BUY `vah_breakout` | **−$19** | +$12 | Vacuum path subtype |
| `va_rejection` | **−$26** (SELL 0/5) | +$14 | Thin detector / bounce shorts |
| **Year** | **−$5 / −9%** | **+$119 / +124%** | Gap ≈ VAL continuation + rej, not “too many trades” |

VAL winners pay ~similar $ per TP in both years. 2025 simply gets **more TPs** and
**fewer WHIPSAWs**. Avg hold 25 bars (2022) vs 10 (2025). Prior60d at entry: −1.6% vs −10%.

## Universal feature (both years, same direction)

**VAH path to next HVN:**

| Path band | 2022–23 | 2025–26 |
|-----------|--------:|--------:|
| 1–2% (structured expansion) | +$7 / 57% WR | **+$52 / 83% WR** |
| ≥2% (vacuum break) | **−$26 / 24%** | **−$36 / 17%** |

This is **not** a 2022-only filter. The playbook was conflating two auctions:
nearby HVN expansion vs break into empty space.

`prior5d` chase is **year-specific** (hurts 2022, washout hurts 2025) — wrong lever.

**79% of VAH losers** retested VAH within 8 bars (false break → return to value).

## Behaviour experiments (tested, not vibes)

| Change | Idea | Result | Verdict |
|--------|------|--------|---------|
| Chase cut prior5d>8% | Drop relief longs | 22–23 +0.8%; cuts N | **REJECT as endpoint** (user) |
| Vacuum → retest entry | Same idea, better entry | Full 22–26 **−51%** | **REJECT** |
| Flat BE at MFE≥1% | Lock whipsaw giveback | Destroys runners (25% WR, −25%) | **REJECT** |
| Flat BE at 1.5–2.5% | Softer lock | 2022 worse; 2025 mixed | **REJECT** |
| Skip vacuum VAH only | Setup definition | 22–23 ~+$1.5; 25–26 **+$144** | Checkpoint — frees slots to `va_rejection` bleed |

Whipsaw fact (still important): 2022 VAL WHIPSAW prints **+1.1% to +2.8% MFE then full SL**.
Flat BE is the wrong tool (scratches winners). Need **regime-aware trail / giveback**,
not a global BE.

## How the setup *should* act by scenario

1. **Structured VAH** (path to HVN ~1–2%): keep **immediate breakout** entry — this is the edge in both years.
2. **Vacuum VAH** (path ≥2%): do **not** treat as the same trade. Needs a separate playbook (failed-break fade, or sized/trailed differently). Retest-as-drop-in **failed** full sim.
3. **VAL breakdown in clean bear** (prior60d deep, fast TP): let runners work — no early BE.
4. **VAL breakdown in chop/squeeze** (flat prior60d, long holds, WHIPSAW): after meaningful MFE, **trail/giveback** (not flat BE) so 2022 doesn’t donate full R.
5. **VA rejection**: detector is thin (vol + wick spike only). SELL losers often close **near VAH** (weak rejection) into oversold bounce — need wick depth + close into VA / POC gravity, or tight fade-to-POC TP — **quality of setup**, not year delete.

## Next ONE change (do not stack)

**Primary:** Regime-conditional **soft trail / MFE giveback** on open VP trades when
macro chop (e.g. |prior60d| small or RV elevated) — protect VAL giveback without
scratching 2025 runners.

**Secondary (isolated):** Tighten `va_rejection` geometry (min upper wick + close depth into VA).

**Tertiary:** Formalize structured vs vacuum VAH as two playbooks (not a silent N-crush).

## Status

Chase-cut and vacuum-retest are **not** locked. Macro-adapt SELL HTF remains.
Research-only; not WF+MC. Handoff updated.
