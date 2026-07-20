# 2026-07-18 — ETH 2021–22 regime autopsy (process Phase 1–3)

**Process:** `docs/VP_FREQ_REGIME_OPTIMIZATION_PROCESS.md`  
**Data:** `research-vp-freq-eth-2021-22-regime.mjs` → `.vp-freq-eth-2021-22-regime.json`  
**Baseline:** ABC adaptive stack that already works on 2022–26 (**surgical bull60 OFF**
in autopsy — clean physics vs trained setup).

This replaces random CF / BTC-copy patching with the same method used for
2022–23 / 2023–24 / 2025–26.

---

## Phase 1 — Market character

| Year | N / Net / WR | Entry context | Dominant story |
|------|-------------:|---------------|----------------|
| **2021–22** | 55t / **−$32** / 31% | **55% bull60**, avg prior60d **+15.7%** | Blow-off residual + crash: shorts into still-elevated 60d bull |
| 2022–23 | 38t / +$24 / 39% | 42% bull60, prior60d +4.9% | Bear + squeezes (already adapted) |
| 2023–24 | 23t / +$44 / 52% | high bull60 but **VAL already gated** by macro-adapt | Bull grind (already adapted) |
| 2024–25 | 52t / +$39 / 40% | 54% bear60, prior60d −7.4% | Mixed / transitioning |
| **2025–26** | 51t / **+$151** / 53% | **57% bear60**, prior60d **−6.0%** | Clean bear VAL follow-through |

**2021–22 is not the 2023–24 failure.** Macro-adapt already removed shallow-HTF
bull shorts (`VAL + macroBull + shallow HTF` = **0 trades** in 2021–22).  
Losers and winners have **similar HTF sep (~1.2%)**. Raising HTF again will not fix this year.

### Setup split (2021–22)

| Setup | N | Net | Read |
|-------|--:|----:|------|
| **SELL `val_breakdown`** | 35 | **−$35.8** | **entire year hole** |
| BUY `vah_breakout` | 15 | **+$10.4** | keep — not the problem |
| BUY `va_rejection` | 4 | −$3.5 | thin secondary |

Same `val_breakdown` in 2025–26: **+$125**. Do **not** delete the setup.

---

## Phase 2 — Physics (VAL shorts)

### Inside 2021–22

| Slice | N | Net | WR |
|-------|--:|----:|---:|
| VAL + **bull60** (prior60d>+5%) | 16 | **−$25.4** | 13% |
| VAL + bear60 | 10 | −$2.5 | 40% |
| VAL bull60 **vacuum** | 14 | **−$19.5** | 14% |
| VAL bull60 **non-vacuum** | 2 | −$5.9 | 0% |
| VAL bull60 + **dump20** (prior20d≤−5%) | 6 | **−$14.0** | **0%** |
| VAL strong HTF (≥0.5%) | 33 | −$37.9 | 21% |

Loser vs winner: losers have **higher prior60d** (avg ~12% vs ~5%). Local HTF is not the discriminator.

### Cross-year (universal vs year-specific)

| Slice | 21–22 | 25–26 | Verdict |
|-------|------:|------:|---------|
| VAL bull60 | −$25 | **+$33** | **YEAR-SPECIFIC — do not blanket** |
| VAL bull60 vacuum | −$20 | **+$37** | **YEAR-SPECIFIC — do not blanket** (this is why blanket bull60 crushed lock) |
| VAL bull60 nonVac | −$6 | −$4 | soft multi-year bleed (thin) |
| **VAL bull60 + dump20** | **−$14** | **$0 (0t)** | **UNIVERSAL bleed candidate** |
| VAL prior20d>0 | −$4 | +$19 | year-specific — reject |
| VAH vacuum | +$7 | −$6 | not 2021–22’s problem |

**prior60d≥15% alone is not universal:** 2021–22 13t/−$18 vs 2025–26 4t/+\$15.
Extreme 60d bull during a **sustained blow-off year** ≠ brief squeeze spikes inside a bear year.

---

## Phase 3 — Behaviour table (mandatory before code)

| # | Condition (measurable) | Current (ABC only) | Desired behaviour | Why |
|---|------------------------|--------------------|-------------------|-----|
| 1 | SELL VAL + prior60d>+5% + prior20d≤−5% | Takes short | **Abstain** | Dead-cat dump into residual bull — 0% WR in 21–22; bleeds every year it appears; **never fires in 25–26** |
| 2 | SELL VAL + prior60d>+5% + path &lt; vacuum | Takes short | **Abstain** (candidate H2) | Structured/tight shorts into residual bull — multi-year soft bleed; keeps vacuum path for later discrimination |
| 3 | SELL VAL + prior60d>+5% + vacuum | Takes short | **Keep for now** | Pays **+$37** in 2025–26; blanketing kills trained edge. Needs a **finer** discriminator (H3) |
| 4 | BUY VAH (all path bands in 21–22) | Takes long | **Keep** | Net positive in the bad year |
| 5 | Raise global / macro SELL HTF further | — | **Reject** | Shallow HTF already gated; not this year’s physics |

### How this maps to “survive any live condition”

- **Prepared:** clean bear VAL, structured VAH, vacuum VAH under existing chase/path caps,
  VAL in bull60 **only** when not dump-into-bull / not non-vac (until H3).
- **Abstain:** dump-into-residual-bull VAL (rule 1); non-vac bull60 VAL (rule 2, after A/B).
- **Unprepared residual:** vacuum + bull60 that still looks like 2021–22 blow-off —
  **do not guess**; measure H3 features first (next autopsy), then one rule.

---

## Ranked hypotheses (one change each — full sim required)

### H1 — LOCK candidate (process-aligned)

**Abstain SELL `val_breakdown` when `prior60d > +5%` AND `prior20d ≤ −5%`.**

- Named failure: dump-into-residual-bull / dead-cat short  
- Universal bleed evidence across years; zero cost to 2025–26  
- Note: matches interim `vpValSellBlockBull60Dump` — now **justified by regime process**,
  not CF hunting. Re-confirm with full-sim A/B vs ABC baseline on lock + all years.

### H2 — next isolated experiment (after H1 confirmed)

**Abstain SELL VAL when bull60 AND non-vacuum path.**

- Must prove lock window (~485% class) does not regress; 2025–26 vacuum bull60 kept.

### H3 — residual research (do not code yet)

**Discriminate bad vs good vacuum+bull60** (21–22 −$20 vs 25–26 +$37).

Candidates to measure (row autopsy, not vibes): duration/intensity of bull60,
prior5d into the short, RV, whether macro is *sustained* blow-off vs *brief* squeeze.
Only then one adaptive rule.

### Explicit rejects

- Blanket block all bull60 VAL  
- BTC prepared allowlist / deny-cell copy  
- Drop all BUY / thin-cell harvest locks  
- Further HTF raises as the 2021–22 fix  

---

## Status

| Phase | Status |
|-------|--------|
| Process doc | done |
| Phase 1–3 for 2021–22 | **done (this file)** |
| Phase 4 H1 full-sim A/B | **next** |
| H2 / H3 | blocked until H1 confirmed |
| WF+MC certify | not yet |

No new knobs in this commit beyond documenting process + autopsy.
