# 2026-07-18 — ETH live reliability: H2 lock + residual abstain doctrine

**Mandate:** For live / OOS, either make returns on **prepared** conditions, or
**abstain** on unfavourable / unoptimized conditions — never bleed capital by
guessing. Unknown live regimes default to ignore until optimized.

**Process:** `docs/VP_FREQ_REGIME_OPTIMIZATION_PROCESS.md`  
**H3 data:** `research-vp-freq-eth-2122-h3-residual.mjs`  
**H2 A/B:** `backtest-vp-freq-eth-2122-h2-ab.mjs`

---

## Optimum reliability model (three layers)

| Layer | Meaning | Action |
|-------|---------|--------|
| **Prepared** | Measurable condition with multi-year positive edge | **Trade** (maximise returns) |
| **Known unprepared** | Measurable condition with multi-year bleed / no edge | **Abstain** (stop capital bleed) |
| **Unknown / ambiguous** | Never seen, thin N, or same coarse cell pays in one regime and bleeds in another with **no discriminator** | **Abstain or size-down** until a discriminator is found — do **not** blanket-kill a prepared subtype just to green one year |

This is how the setup stays reliable when live invents new tape: it only risks capital
where physics are trained.

---

## What we locked for 2021–22 physics

| Rule | Condition | Why |
|------|-----------|-----|
| **H1** | SELL VAL + prior60d>+5% + prior20d≤−5% | Dump-into-residual-bull — universal bleed; 2025–26 untouched |
| **H2** | SELL VAL + prior60d>+5% + non-vacuum path | Structured/tight shorts into residual bull — multi-year soft bleed; **keeps vacuum bull60** |

### H2 full-sim (on top of H1)

| Window | H1 only | H1+H2 |
|--------|--------:|------:|
| **Lock 2022–26** | 160t / +604.6% / DD22% | **154t / +637.9% / DD19.6%** |
| OOS 2021–22 | −22.8% | **−20.5%** |
| 2022–23 | +28.5% | **+32.5%** |
| 2023–24 | +56.5% | +56.4% |
| 2024–25 | +42.9% | +39.0% |
| 2025–26 | +151.1% | **+169.6%** |
| Full 2020–26 | +310% / DD48% | **+383% / DD42%** |

**LOCK H2** — improves lock path and 2025–26; mild 2024–25 dip acceptable vs full/lock lift.

---

## Why 2021–22 is still negative (~−20%) — identified residual

Under H1+H2, remaining hole is **not** one clean universal filter:

| Residual slice | 2021–22 | 2025–26 | Verdict |
|----------------|--------:|--------:|---------|
| VAL **vacuum + bull60** (non-dump) | 8t / −$6 | 5t / **+$37** | **Ambiguous** — same coarse cell; no stable discriminator (prior60/120, bullFrac, dist-to-high all fail; 25–26 winners even have *higher* prior60d) |
| BUY `va_rejection` | 5t / −$8 | −$3.5 | **Do not blanket** — pays +$9–11 in 2022–24 |
| Other VAL (bear/flat mix) | residual | edge elsewhere | needs further named autopsy, not a vibe cut |

**Rejected for live reliability:**

- Blanket all bull60 VAL / all vacuum bull60 → destroys prepared 2025–26 edge (+$37)
- Blanket all BUY va_rejection → destroys 2022–24 edge
- BTC prepared allowlist copy → already crushed ~483% path once

**Honest live stance on vacuum+bull60:** this cell is **partially prepared** (bear-year
squeeze continuation shorts work). Blow-off-year instances look the same on current
features. Until H3 finds a real discriminator, blanketing would violate “maximise
prepared returns.” Leaving it on accepts a known residual risk in blow-off years —
documented, not ignored.

---

## Next optimum steps (in order — one at a time)

1. **H3 continued (row physics):** find a discriminator for bad vs good vacuum+bull60
   (follow-through / structure / longer-horizon regime — not prior60 alone). If none
   after honest search → consider **size-down** on that cell (not full abstain) as the
   reliability compromise.
2. **BUY va_rejection quality (selective):** autopsy 2021–22 BUY rej losers vs
   2022–24 winners — gate geometry/context, never delete the setup.
3. **Unknown live cells:** enable ETH novelty monitor / deny-unknown only after an
   ETH-native prepared matrix proves it does **not** crush the 150t/+600% lock class
   (BTC allowlist path already failed on ETH).
4. **WF + MC + gates** only after residual policy is explicit (trade / abstain /
   size-down) for the ambiguous cell.

---

## Status

- H1 + H2 locked in `VOLUME_PROFILE_FREQ_ETH_15M`.
- 2021–22 improved (−32% → −20%) but **not green** — residual is identified and
  deliberately not “solved” by killing prepared edge.
- **Not certified deployable** until residual policy + gates pass.
