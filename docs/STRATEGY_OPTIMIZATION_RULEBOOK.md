# Strategy Optimization Rulebook

> **Read this before any strategy research.** Companion: `STRATEGY_RESEARCH_HANDOFF.md`, `.cursor/rules/strategy-optimization-rulebook.mdc`

## North star

**Build setups with the highest honest, repeatable returns we can validate — not the highest backtest curve.**

**User mandate (non-negotiable):** We want **higher returns**, **higher frequency**, and a **profitable** strategy — together, not one at the expense of the others.

| Optimize for | Do not optimize for |
|--------------|-------------------|
| OOS return, CAGR, Calmar on multi-year multi-coin | In-sample return on one coin / one quarter |
| **Deployable trade frequency** (enough activity to use capital; see minimums below) | “Edge” on 3–16 trades/year that cannot be validated or deployed |
| Positive expectancy after fees + slippage + funding | Win rate or meanR on harvested setups that never become live trades |
| Portfolio return at controlled max DD | “Damage control” filters that only reduce losses but never beat cash/flat OOS |
| Positive OOS after fees + gates | Novel indicators, data feeds, or presets without a prior hypothesis |

**Current deploy baseline:** **none certified.** Prior `SUPERTREND_ELITE` ~10–21% CAGR
“validated” claims are **revoked** (wrong trailing in those runs). New streams must
pass the **same validation harness** (WF + MC + 4 gates) with **correct exits** —
do not treat stale ST Elite tables as the bar to beat or the default recommend.

---

## Frequency + profitability floor (not optional)

A result that is barely positive on a handful of trades is **not** an acceptable endpoint.

| Metric | Minimum bar (research) | Notes |
|--------|------------------------|-------|
| Trades | **≥30 OOS** per coin **or** pooled portfolio with enough N for WF/MC | 3–16 trades/17mo is **insufficient evidence** — do not call it “profitable research” without a path to more N |
| Frequency | **Meaningful deployment** — target **≥2 trades/week per active coin** (or equivalent via multi-coin portfolio) unless user explicitly accepts lower | Do **not** treat ~0.06–1 trade/week as success |
| Return | **OOS > 0** after realistic costs | Near-breakeven on tiny N is a **hypothesis checkpoint**, not a deliverable |
| Expectancy | **PF ≥ 1**, positive mean R where applicable | High WR on 3 trades is noise |

**Banned “solutions”:**

- Tightening gates until trade count collapses to single digits/year and calling that “quality.”
- Presenting a backtest table and stopping when targets are missed — **without** a named failure mode and **next** experiment.
- Recommending VP Tier-A / breakdown veto / onePickPerDay-style throttles as the **final** answer when frequency is already unacceptable.
- Declaring “research-only profitable” with no iterative plan to raise frequency **and** keep expectancy.
- **Excluding hard OOS years / regimes from the evaluation window** to make a curve look good (e.g. “just don’t test 2021”). Lock windows are for *comparison*, not for pretending live won’t see that regime. Live invents 2021-class stress — the setup must **survive** it via relative/adaptive rules, or abstain with measurable conditions, not by calendar cherry-picking.
- Copying another coin’s bleed/prepared cell list onto a different coin without coin-native autopsy (BTC novelty bleed on ETH is a known foot-gun).

**When targets are missed:** autopsy → hypothesis → **one** change → re-test → repeat. Explore **exits**, **playbooks**, **timeframes**, **multi-coin breadth**, and **coin-specific routing** — not only stricter entry filters. If a path cannot reach frequency + profit after honest iteration, **archive it with reason** and switch stream — do not pretend low-N curves are deployable.

---

## What counts as real progress

A change is progress **only if all are true:**

1. **Hypothesis first** — names the recurring failure mode (e.g. “long fades into OI cascade lose −0.4R”).
2. **Single change** — one logic/filter/risk knob per experiment.
3. **Same engine** — full `runSimulation` with realistic costs, same preset family.
4. **OOS improves** — holdout or walk-forward fold, not just full-window IS.
5. **Gates checked** — OOS>0, MC p5>0, Calmar>1, WF degradation<35% (see `backtest-validate-supertrend.mjs` pattern).
6. **Trade count sane** — enough trades to matter (rule of thumb: ≥30 OOS trades per coin or pooled portfolio OOS).

If a filter improves IS but **holdout return or expectancy does not improve**, it is **rejected** — not “maybe useful.”

---

## Approved workflow (no shooting in the dark)

```
1. Pick ONE strategy stream (already wired in runner.js)
2. Run baseline → store trades + features
3. Autopsy losers → cluster by regime / feature (not gut feel)
4. Write hypothesis + expected direction of change
5. Implement ONE change
6. Backtest baseline vs change (identical window, costs, sizing)
7. Run validation harness (WF + MC + gates)
8. Promote ONLY if gates pass; else archive with reason
```

**Scripts that follow this path:**

| Step | Script |
|------|--------|
| Baseline compare | `backtest-strategy-compare.mjs`, `backtest-portfolio-supertrend.mjs` |
| Rigorous validation | `backtest-validate-supertrend.mjs` |
| Trade autopsy | `research-liq-trade-diagnostic.mjs`, `audit-sr-run-trades.mjs` |
| Feature → expectancy | `research-liq-feature-expectancy.mjs` (hypothesis generation only) |
| Abstention test | `research-abstention-experiment.mjs` (must confirm on **full sim**, not harvest-only) |

**Do not skip step 7.** A positive harvest meanR or holdout WR on 11 trades is **not** a deployable result.

---

## Banned patterns (random / low signal)

- Trying a new strategy preset, data source, or filter **without** a written hypothesis tied to loser autopsy.
- Stacking multiple filters because each looked good in isolation (combo overfit).
- Declaring edge from **candidate harvest** or day-picked setups when full `runSimulation` is negative.
- Switching strategy families (LIQ_MAP → SR_INTRADAY → SMC) mid-thread without re-establishing baseline.
- Presenting “less negative” as success when OOS return is still ≤ 0.
- Chasing 50%/month or short-window H1 rankings from `backtest-strategy-compare.mjs`.
- **Using ultra-low trade count as the “fix”** when frequency or returns miss target (e.g. Tier-A / veto / onePickPerDay → &lt;1 trade/month) without a follow-up plan to restore frequency with edge.
- **Report-and-stop:** one backtest, targets missed, no autopsy and no next hypothesis.

---

## Methods that looked promising (provisional — not certified)

| Method | Outcome |
|--------|---------|
| Trend + multi-gate stack + trail exit (`SUPERTREND_ELITE`) | Appeared strong in older runs; **deploy claim revoked** until re-validated with correct trailing |
| Multi-coin portfolio + risk-at-SL sizing | Useful capital allocation pattern when a stream actually passes gates |
| Walk-forward + Monte Carlo + 4 acceptance gates | Stopped dozens of overfit candidates — keep this |
| Trade autopsy → one gate at a time | Good process; LIQ filters mostly damage control only |
| Realistic costs in every backtest | Exposed that high-frequency MR/scalp paths are fee victims |

---

## Methods that did NOT produce deployable edge (archived)

- Binance funding / Bybit OI as **ranking** signals (Families A/C/D) — no discrimination
- Coinalyze + funding abstention on LIQ sweep — helps WR on harvest; **full SR_INTRADAY sim still OOS negative** on portfolio
- LIQ+S/R A+ confluence — positive IS, **failed MC/WF gates**
- REGIME_ADAPTIVE, HTF_RSI, order-flow solo — rejected in handoff

---

## Decision log template (required for new experiments)

```markdown
## Experiment: [name]
- **Baseline:** [strategy + preset + window]
- **Hypothesis:** [failure mode → proposed fix]
- **Single change:** [exact cfg/key]
- **IS result:** return / DD / trades
- **OOS result:** return / DD / trades
- **Gates:** pass/fail (list)
- **Verdict:** PROMOTE | REJECT | NEEDS_MORE_DATA
- **Reason:**
```

Save completed experiments under `backend/scripts/.research-decisions/` (create as needed).

---

## Agent mandate

When the user asks for “better results” or “optimum setup”:

1. State what **validated baseline** we are trying to beat.
2. Propose the **next hypothesis** from evidence, not a new random preset.
3. Run the **full validation path** before claiming improvement.
4. Be explicit when a result is **research-only** (damage control, insufficient N, failed gates).
5. **Do not stop at one failed run.** If return, frequency, or profitability targets are missed, diagnose why and **propose and execute the next experiment** in the same thread when possible — not a dead-end table.
6. **Never** satisfy “profitability” by crushing frequency to ~0 trades/month unless the user explicitly opts into a ultra-selective research mode.

**Higher returns and higher frequency are both goals — but only outcomes that survive unseen data and meet minimum N count.**

---
