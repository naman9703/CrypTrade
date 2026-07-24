# LIQ BNB — implementation audit + Y2025 behaviour table (2026-07-23)

> **Scope:** liquidity setup only (`LIQ_CORE` / classical fade). Not VP.  
> Process: VP-style year flip starting at **Y2025**.  
> Artifact: `.liq-bnb-y25-deep-autopsy.json`

---

## 1. Apology / course correction

Prior session incorrectly pivoted BNB profitability work to VP FREQ.  
User mandate: **liquidity setup only** — make it profitable and live-reliable.  
VP H9 sleeve is unrelated to this stream and must not be treated as the LIQ answer.

---

## 2. How LIQ is implemented (fundamentals → code)

| Concept | Meaning | Wired? | CORE default |
|---------|---------|--------|--------------|
| BSL / SSL pools | Stops above highs / below lows | Yes — PDH/PDL + session EQH/EQL | **On** |
| Sweep | Wick pierces pool by `sweepPct` | Yes | On |
| Reclaim | Close back through level | Yes | On (+ hold 2 bars) |
| Chronological picks | Live ≡ backtest | Yes | On |
| Draw on liquidity (TP) | Opposing pool / maxTpRr | Yes | maxTpRr=2 |
| SL beyond wick | Invalidation | Yes | On |
| Full-size runner | No TP1 partial | Yes (X4) | On |
| BE off when no TP1 | Avoid 1R clip | Yes (X5) | On |
| Weekly / Asian pools | HTF hierarchy | Code exists | **Off** |
| Killzone | London/NY windows | Code exists | **Off** (A/B reject) |
| Toxic-day abstain | No fade into accepted break | Code exists | **Off** |
| Macro-align fade | No SELL bull60 / BUY bear60 | Code exists | **Off** |
| Premium/discount align | Long discount / short premium | **Wired 2026-07-23** | **Off** (research) |
| Same-bar pin reclaim | Sweep+reclaim same candle | **Wired 2026-07-23** | **Off** (research) |
| Displacement confirm | Impulse after sweep | Code exists | **Off** |
| Mitigation entry | Limit back to pool | Code exists | **Off** |
| ACCEPT (with-sweep) | Failed reclaim continuation | Separate playbook | Parallel; 3y REJECT |

**Edge thesis (classical):** after a named-pool stop-run + reclaim, fade toward opposing liquidity with tight SL.

**Dominant failure (all years):** `never_green` + `sl_no_follow` ≈ majority of loss $ — false reclaim / no displacement after entry.

---

## 3. Y2025 market character (Phase 1)

| Window | N | tw | ret% | PF |
|--------|---|----|------|---|
| Y2025 | 343 | 6.6 | **−3.0** | **0.75** |
| Y2024 | 377 | 7.2 | −36.7 | 0.65 |
| Y2023 | 167 | 6.4 | −59.0 | 0.65 |
| FULL | 1034 | 6.6 | −99.7 | 0.65 |

Y2025 is the **least bad** year (near flat DD 3.6%) — correct year to flip first.

### Cells (Y2025)

| Cell | n | PF | pnl$ | Note |
|------|---|----|------|------|
| **same-bar reclaim** | 101 | **1.14** | **+0.46** | Only clear positive cell |
| multi-bar reclaim | 242 | 0.60 | −3.44 | Bleeds (year-specific vs 2023) |
| toxic fades | 150 | 0.67 | −1.80 | Worse than ok |
| loc-against | 72 | 0.56 | −0.99 | Conceptually wrong fades |
| loc-align | 91 | 0.78 | −0.78 | Not enough alone |
| london hours | 72 | 0.53 | −1.38 | Worst session |
| asia | 124 | 0.95 | −0.23 | Least bad session |
| session_low | 47 | 1.02 | +0.03 | Tiny N |

### Universal vs year-specific

| Feature | Y25 dPF | Y24 dPF | Verdict |
|---------|---------|---------|---------|
| !toxic | +0.07 | +0.03 | Universal mild lift; never PF≥1 alone |
| !locAgainst | +0.04 | +0.05 | Universal mild lift |
| multiBar | **−0.15** | +0.05 | **Year-specific** — do not globalize |
| same-bar prefer | soft + | (opp of multi) | Y2025 candidate; check hard + Y24 |

---

## 4. Behaviour table (before code)

| Condition (measurable) | Current | Desired |
|------------------------|---------|---------|
| Sweep+reclaim **same bar** (pin) | Taken with multi-bar | **Prefer / require** for Y2025 path |
| Sweep+reclaim multi-bar | Taken | Abstain when same-bar rule on |
| BUY in day **premium** / SELL in **discount** | Taken | **Abstain** (loc-against) |
| BUY on breakdown / SELL on breakout | Taken | Abstain (toxic) — secondary |
| London killzone fades | Taken | Watch; soft worst — not first lock |

---

## 5. Next experiment (one change)

1. Wire `intradayLiqRequireSameBarReclaim` + `intradayLiqRequirePremiumDiscountAlign` (done).  
2. Hard A/B Y25 + Y24 + Y23 + H12 + FULL.  
3. LOCK only if Y25 → PF≥1 / ret>0 **and** other years not crushed worse than baseline without a restore plan.  
4. If same-bar helps Y25 but hurts Y23 → seek subtype discriminator (not year-hardcode).

Gates stay **off** on CORE until holdout-valid.
