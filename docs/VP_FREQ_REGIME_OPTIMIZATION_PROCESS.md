# VP FREQ — regime / market-condition optimization process

> **Purpose:** Repeatable process for making a setup survive **any** market year —
> trade when conditions match trained physics; **abstain** when they do not.
> Distilled from the ETH FREQ work that fixed 2022–23 / 2023–24 / 2024–25 / 2025–26
> (see `.research-decisions/2026-07-15-*` and `2026-07-16-eth-vp-freq-*`).
>
> Companion: `docs/STRATEGY_OPTIMIZATION_RULEBOOK.md`, `STRATEGY_RESEARCH_HANDOFF.md`.

---

## North star (what “optimized” means)

| Do | Do not |
|----|--------|
| Name the **market regime** of the bad year | Year-hardcode (`if year == 2021`) |
| Change **behaviour** under measurable conditions | Random knobs, session filters, N-crush |
| Keep setups that pay in *other* regimes | Delete a setup because one year bled |
| Abstain when physics are **unprepared** | Trade everything and hope |
| Full `runSimulation` on **all** holdout years | Harvest counterfactuals only |
| Coin-native cells / thresholds | Copy BTC locks onto ETH (or vice versa) |

**Live contract:** When live tape matches a **prepared** condition → take the trade
(optimum path). When it matches a **known bleed** or **unknown/untrained** regime →
ignore. That is how the setup “survives any condition.”

### Ambiguous cells (same coarse features, opposite outcomes)

If a cell pays in one regime and bleeds in another and **no discriminator** is found:

1. Do **not** year-hardcode or blindly blanket (that kills prepared edge).
2. Prefer: keep searching for a measurable subtype → abstain only the bleed subtype.
3. If still irreducible: document as residual risk, or **size-down** that cell —
   full abstain only when multi-year EV of the cell is ≤ 0.
4. Never present “OOS green via destroying the lock path” as reliability.

---

## How ETH 2022–26 was actually fixed (template)

Each bad year was solved the **same way**:

```
1. Isolated year window vs a strong reference year (usually 2025–26)
2. Setup P&L split (VAH / VAL / va_rejection / …) — what bled vs what paid
3. Feature autopsy on losers vs winners (prior5d/20d/60d, HTF sep, path%, MFE/MAE, …)
4. Separate UNIVERSAL features (same sign every year) from YEAR-SPECIFIC ones
5. Write “how the setup SHOULD act by scenario” (behaviour table)
6. ONE hypothesis → implement as condition→behaviour rule
7. Full sim A/B: bad year + all other years + lock window (must not crush good years)
8. LOCK only if bad year improves AND good years hold (or improve)
9. Residual autopsy → next ONE change (never stack blind)
```

### Worked examples (ETH)

| Bad year | Market character | Named failure | Adaptive rule (locked) |
|----------|------------------|---------------|------------------------|
| **2023–24** | Bull grind | VAL shorts on shallow HTF against macro bull | `vpSellMacroAdapt` — harder SELL HTF when macro bull |
| **2022–23** | Bear + violent squeezes | Vacuum VAH chase (`path≥2%`, relief prior5d); SELL rej into washout | Vacuum path cap (non-bull); rej block when prior20d extended down; later vacuum `prior5d≤1%` |
| **2023–24 residual** | Weak-bear transition | Shorts with `macroBull=false` but prior20d > −10% + shallow HTF | `vpSellWeakBearMinHtfSepPct` |
| **Chop / WHIPSAW** | Flat prior60d, giveback after MFE | VAL prints +1–3% MFE then full SL | Chop SELL MFE trail (not flat BE) |

**Rejected patterns from that work:** global prior5d chase as endpoint; vacuum→retest entry;
flat BE; deleting `val_breakdown`; BTC prepared allowlist on ETH.

---

## Hard process (use for every new bad year / coin)

### Phase 0 — Baseline

1. Freeze the **current prepared stack** that already works on trained years.
2. Do **not** mix coin locks. ETH ≠ BTC.
3. Run full sim on: bad year · each good year · full multi-year lock window.
4. Record N / ret / DD per window. This is the bar not to destroy.

### Phase 1 — Market character (not trade list)

Answer in writing:

- What was the auction? (blow-off, grind bull, clean bear, squeeze bear, chop, …)
- Dominant HTF / prior60d / vol regime at **entries** vs the good year
- Which **setups** paid vs bled (table)
- Path risk (peak→trough DD) vs headline return

### Phase 2 — Physics autopsy

For each bleeding setup:

1. Loser vs winner feature deltas (same year)
2. Same setup in the **good year** — why it paid there
3. Bucket expectancy (path%, prior5d, prior20d, prior60d, HTF sep, …)
4. Mark each feature:
   - **Universal** — same direction in bad *and* good years → strong candidate for a rule
   - **Year-specific** — helps one year, hurts another → **reject** as global lever

### Phase 3 — Behaviour table (mandatory before code)

Write:

| Condition (measurable) | Current behaviour | Desired behaviour |
|------------------------|-------------------|-------------------|
| e.g. SELL VAL + macro bull + HTF sep &lt; 0.5% | Takes short | Abstain or require deeper HTF |

If you cannot fill this table, you are not ready to code.

### Phase 4 — One change

1. Implement **one** condition→behaviour rule.
2. Full sim A/B vs Phase-0 baseline on **all** windows.
3. Accept only if:
   - Bad year improves (return and/or DD), **and**
   - Trained lock window does **not** lose its class of edge (for ETH: the ~150–170t / ~+480%+ / controlled DD path), **and**
   - Frequency not crushed without a restore plan.
4. Log decision (LOCK / REJECT) with numbers.

### Phase 5 — Residual / live readiness

- Remaining bleed → new Phase 1–4 cycle (named mode, one change).
- Unknown live regimes: prefer **abstain** only after cells are measured multi-year —
  not after a single CF hunt.
- Certification (WF + MC + gates) only after residual years are addressed or
  explicitly accepted with abstention contract.

---

## Banned “random path” behaviours

- Hunting harvest counterfactuals and locking the first slice that flips one year green
- Copying another coin’s deny/allow cell list
- Stacking 2+ new filters in one commit
- Session / hour filters without physics autopsy
- Calling “less negative” success while lock window edge collapsed
- Report-and-stop after one failed year without the behaviour table

---

## Scripts that follow this process

| Step | ETH scripts |
|------|-------------|
| Year vs year deep features | `research-vp-freq-eth-regime-autopsy.mjs` |
| Multi-year setup×regime | `research-vp-freq-bad-years-deep.mjs` |
| Adaptive stack A/B | `backtest-vp-freq-eth-adaptive-stack.mjs` (pattern) |
| Single-rule A/B | `backtest-vp-freq-eth-*.mjs` one family at a time |
| Decisions | `backend/scripts/.research-decisions/YYYY-MM-DD-eth-vp-freq-*.md` |

For a **new** bad year (e.g. 2021–22): extend windows in the autopsy scripts, write the
behaviour table, then one A/B — do not invent a parallel “surgical” track.

---

## Status checklist before saying “optimized for live”

- [ ] Every trained year has a named regime + behaviour rules covering its bleed
- [ ] Bad / OOS years either green or covered by abstain rules with multi-year evidence
- [ ] Lock window edge class preserved
- [ ] WF + MC + 4-gate harness pass under the **same** exits that will go live
- [ ] Coin-native (no silent cross-coin copy)
