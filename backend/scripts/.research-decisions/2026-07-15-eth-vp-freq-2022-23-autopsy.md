# 2026-07-15 — ETH VP FREQ 2022–23 autopsy (vs 2025–26)

**Run:** `0e26b212-cd11-430c-bcb8-2822f15eba64`  
**Window:** 2022-06-01 → 2023-05-31 · ETHUSDT 15m · FREQ · −9.3% · **DD 47.6%** · 61 trades  
**Compare:** `fa11601a` 2025-06→2026-05 · +124% · 78 trades

## Verdict — different failure than 2023–24

| Year | Regime | What bled | What worked |
|------|--------|-----------|-------------|
| **2022–23** | Bear + violent squeezes (Luna aftermath → FTX) | **BUY `vah_breakout` −$19** · **SELL `va_rejection` −$25** | **SELL `val_breakdown` +$18** |
| **2023–24** | Bull grind | SELL `val_breakdown` | BUY mild + |
| **2025–26** | Bearish legs with real HTF | — | SELL `val_breakdown` +$116 · BUY mild + |

Do **not** apply the 2023–24 short-only fix here. Shorts were the **profit** engine in 2022–23.

## Path (why DD looks worse than −9%)

| Month | Net | Equity | Note |
|-------|----:|-------:|------|
| 2022-07 | **+$74** | ~173 | Squeeze / reclaim cluster (all setups paid) |
| Aug–Oct | bleed | ~148 | VAH longs fail |
| **2022-11** | **−$22** | ~126 | FTX — SELL va_rejection + val bleed |
| Dec–May | grind down | **91** | Peak→trough **DD 48%** |

Headline −9% understates path risk: strategy peaked then gave back the year.

## Technical failure modes

### 1. VAH breakout = chasing relief rallies (main long bleed)

26 BUY VAH · 31% WR · **−$19.22**

| | Losers (18) | Winners (8) |
|--|------------:|------------:|
| avg prior **5d** | **+8.6%** | +4.5% |
| avg prior **60d** | **+10.8%** | **−21.2%** |
| avg MFE before SL | **0.62%** | 3.62% |
| INSTANT/FAST/WHIPSAW | 10/18 | 0 |

**Market read:** In a bear year, VAH “breakouts” after a sharp 5d bounce are often **short-covering / dead-cat** — local HTF flips up, structure triggers, then price rejects. Winners were washout reclaim (deep prior60d). Losers were **chase**.

Counterfactual (trade autopsy, not full sim yet): block VAH BUY when `prior5d > +8%`  
→ 2022–23 **+$0.83** (was −$9.3) · 2025–26 still **+$130** (drops 1 trade).

### 2. SELL va_rejection = shorting into reclaim / bounce

5 trades · **0% WR** · **−$24.88** (largest single setup hole)

All in deep drawdown context (prior20d −6% to −26%). Pattern: brief MFE then SL (WHIPSAW / FAST_FAIL) — classic **short into bounce** after VA rejection in oversold bear.

Dropping only these → 2022–23 **+$15.6**; 2025–26 almost unchanged (−$1.3).

### 3. What did *not* fail

`val_breakdown` shorts: **+$17.8** @ 33% WR — same setup that destroyed 2023–24. Confirms **regime-conditional edge**, not a broken detector.

## Why same setup works in 2025–26

- Macro prior20d at entries **−4.9%** (bearish continuation) vs 2022–23 **+0.2%** (chop / squeeze).
- VAH losers fewer chase signatures; val shorts have stronger HTF sep and follow-through.
- Loss mix: fewer WHIPSAW on structure (6 vs 11); winners’ TP mass dominates.

## Technical solution (hypothesis — not “delete setups”)

**H1 (primary):** Block **BUY `vah_breakout`** when the auction is a **relief chase** — e.g. prior ~5d return above a cap (~8%). Keeps washout VAH longs; removes squeeze chases.  
**H2 (secondary, separate experiment):** Gate or drop **SELL `va_rejection`** when already extended down / in bounce risk — or remove from ETH FREQ allow-list after isolated test.

Do **not**: raise ADX, crush maxTrades/day, or delete `val_breakdown` / all VAH.

## Next

1. Implement H1 as one change (`vpBuyMaxPrior5dPct` or equivalent on VAH only).  
2. Full sim 2022–23 + 2023–26 + 2025–26 holdouts.  
3. Only then consider H2 in isolation.
