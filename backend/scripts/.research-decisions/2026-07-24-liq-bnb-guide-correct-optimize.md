# BNB LIQ — guide research vs implementation + VP-style optimize (2026-07-24)

**Scope:** Liquidity sweep **only**. Sources: ICT killzone PDH/PDL / sweep guides, HuntersAlgo four-step sequence, ITI confirmation/retest entries.

Artifacts: `.liq-bnb-guide-correct-optimize.json`  
Scripts: `research-liq-bnb-guide-correct-optimize.mjs`

## 1. Is our implementation correct?

| Guide step | Published requirement | CORE today | Verdict |
|------------|----------------------|------------|---------|
| 1 Pool | PDH/PDL, EQH/EQL, session, swing | PDH/PDL + session extremes | **OK** |
| 2 Sweep | Wick beyond + close reclaim (Type1) | Pierce + reclaim + holdBars=2 | **OK** (truncated) |
| 3 Confirm | **Displacement / MSS (CHoCH)** after reclaim | `RequireChoch` / `RequireDisplacementV2` **OFF** | **MISSING** |
| 4 Entry | FVG/OB retrace **or** retest of swept level | Market at reclaim+2 close | **INCORRECT vs guide** |
| 5 SL | Beyond sweep wick + ATR buffer | Structural wick + **% buffer only** | **Partial** |
| 6 TP | Opposing liquidity (structural) | Opposing pool capped `maxTpRr=2` | **Partial** |
| 7 Prereqs | Killzone / session, HTF bias, vol expansion | All quality gates **OFF** | **MISSING** |

**Conclusion:** CORE is a **truncated classical fade trigger** (steps 1–2 + capped structural risk), not a complete liquidity-sweep strategy. Fake-sweep bleed is expected when steps 3–4/7 are skipped — reclaim alone is explicitly called insufficient in ICT literature.

That does **not** mean “liquidity has no edge.” Soft oracle / `ok_path` cohort still shows latent edge. It means **our entry definition is incomplete**.

## 2. VP-style prepared vs bleed cells (Y1)

Prepared (pnl>0, PF≥1), examples:

- `range|vol<15|dispOK|slWide` PF 1.64  
- `breakdown|vol15+|dispOK|slWide` PF 1.31  
- `breakout|vol15+|dispOK|slWide` PF 1.08  

Bleed dominated by **`dispWeak` or `slTight`** (and breakout+tight SL).

**Universal relative pattern:** displacement OK **and** wide structural SL → prepared; weak displacement or tight SL → bleed.

Soft closest to green: `dispOK_slWide` PF **0.975** / −2.3% @ 3.0/wk (not quite pass).

## 3. Hard A/B (guide knobs + structural exits)

Windows: Y1 2025-07→2026-07, HOLD 2024-07→2025-07. Gates: PF≥1, ret>0, tw≥2 both.

| Variant | Y1 PF/ret/tw | HOLD PF/ret | Note |
|---------|--------------|-------------|------|
| CORE | 0.66 / −86 / 6.3 | 0.67 / −83 | |
| TP uncapped / cap3 | worse | ~flat | uncapped hurts Y1 |
| ATR SL buf 0.2 | ~0.67 | ~0.68 | noop |
| minSl 1.2% | **0.90 / −14 / 2.8** | 0.89 / −20 | best single quality |
| wick 1.5 / sameBar / killzone | worse | worse | |
| dispV2 1.2 | 0.72 | 0.65 | |
| choch | 0.64 | 0.86 | |
| mitigation 0.5 | 0.74 | 0.78 | |
| **disp+vol+minSl** | **0.94 / −6.8 / 2.1** | 0.80 / −27 | **best Y1** |
| guide_mss_entry (choch+disp+mit+atrBuf) | 0.56 / −45 / **1.7** | **1.29 / +53 / 2.1** | year invert — **do not lock** |
| disp+minSl+notToxic | 0.97 / −2.3 / **1.2** | **1.06 / +5.7 / 1.6** | near expectancy; **freq &lt; 2** |

## 4. Verdict

**REJECT promote** (no variant clears Y1+HOLD at tw≥2).

Progress vs CORE:

1. Implementation gap **named and confirmed** by hard tests: adding displacement + minSl moves PF 0.66 → **0.94**.  
2. Prepared-cell physics match guide: **displacement + room for structural stop**.  
3. Full guide MSS+mitigation stack is **year-unstable** (HOLD green, Y1 red) — same class as VP ambiguous cells; need subtype, not blanket lock.  
4. Structural TP uncapped is **not** the fix on this window.

## 5. Next (LIQ-only, VP process)

1. Treat `dispOK ∧ slWide` as **prepared path**; autopsy residual bleed inside that cell (session / level / prior) for **one** relative abstain.  
2. Frequency restore: multi-coin on the prepared cell, not reopening `dispWeak|slTight`.  
3. Optional: LIQ-native FVG-after-sweep entry (still LIQ playbook, not SMC product fork) once prepared cell is green.  
4. Do **not** default-on full guide stack on CORE without coin-native locks.
