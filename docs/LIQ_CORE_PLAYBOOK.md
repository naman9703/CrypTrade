# LIQ_CORE Playbook — Classical Liquidity Sweep Rebuild

> **Living doctrine** for the `LIQ_CORE` stream under `SR_INTRADAY` / `INTRADAY_PRO`.  
> Read before changing entry filters, picks, or exits.  
> Companion: `docs/TRADING_GLOSSARY.md` §10, `docs/STRATEGY_OPTIMIZATION_RULEBOOK.md`, `STRATEGY_RESEARCH_HANDOFF.md`.  
> **Status:** research rebuild (2026-07-23) — **not certified for live.**

---

## 1. Why rebuild

Legacy classical PDH/PDL fade (`INTRADAY_PRO_LIQ_15M`) is well instrumented but:

- Frequency ceiling ≈ **~1 trade/week** on BNB after quality gates; FREQ_EDGE failed to reach 2–5/wk.
- Backtests used **EOD best-of-day** (`intradayLiqOnePickPerDay`) — **look-ahead vs live**.
- Stacked filters (body ratio, minRr, entry score, V2 market-state/quality gates, VP dual-gates) mostly **cut N** without durable OOS edge.

**LIQ_CORE** is a **parallel** playbook: concept-only hard gates, live-faithful chronological picks, frequency from levels + multi-coin breadth + short holds — not from more entry vetoes.

Do **not** replace or delete legacy LIQ / failed `LIQ_15M_V2` presets.

---

## 2. Market concept (fundamentals)

| Term | Meaning in this setup |
|------|------------------------|
| **BSL / SSL** | Buy-side liquidity above highs (stops of shorts + breakout buys); sell-side below lows |
| **Stop run / sweep** | Price pierces a pool (wick beyond PDH/PDL or EQH/EQL), then fails to hold |
| **PDH / PDL** | Previous day high/low — primary daily stop magnets |
| **EQH / EQL** | Equal highs/lows / session extremes — secondary intraday pools |
| **Reclaim** | Close back through the swept level (auction rejects the break) |
| **Displacement** | Impulsive move away from the pool (context / score — not a CORE hard gate yet) |
| **Draw on liquidity** | Opposing pool (e.g. PDH after PDL sweep long) as structural target |

**Edge thesis:** After a clear stop-run of a **named** pool, mean-reversion toward the opposing pool has positive expectancy **if** risk is tight (SL beyond wick) and we do not fade genuine breakout days without a measurable relative rule.

**Non-thesis:** Random “liquidity” labels, CHoCH-required stacks, VP dual-gates, or day-router trend legs (banned until rewrite).

---

## 3. Four-layer stack

```
Layer 1 — Context   Optional later: session / measurable day-type. CORE default: off.
Layer 2 — Trigger   Sweep: wick pierces named pool by sweepPct.
Layer 3 — Confirm   Reclaim: close back through level (same-bar pin allowed).
Layer 4 — Risk      SL beyond wick + buffer; full size → TP2 (opposing / maxTpRr·R) or SL.
```

Pick layer (execution): **chronological first-valid** within day / side / bar-gap caps — same rule live and backtest.

### 3b. Liquidity technical layers — promote vs reject (evidence 2026-07-23)

| Layer | Type | Keep? | Why |
|-------|------|-------|-----|
| Named pools (PDH/PDL + session extremes) | Trigger | **Yes** | Concept floor; defines the setup |
| Sweep pierce + reclaim | Trigger/confirm | **Yes** | Classical stop-run definition |
| Chronological picks | Execution | **Yes** | Live ≡ backtest |
| Full-size runner (no early TP1 partial) | Exit | **Yes** | W/L: winners hold ~38 bars / MFE ~1.9%; X4 lifts PF 0.31→0.50 @ same freq |
| Closer structural TP (`maxTpRr=2`) | Exit | **Yes** | T1: PF 0.50→0.53, WR 24→28%, freq intact |
| Reclaim hold 2 bars | Confirm / path | **Yes** | P1: PF 0.53→0.60, ret −99→−93, freq 7.5→6.4/wk |
| Dead-trade MFE×bars SL compress | Exit | **No** | Correct failure-class idea; on CORE it clips slow runners (winner $↓) |
| HTF align / “not against” | Context gate | **No** | Soft keep cuts N; hard gate → ~3.3/wk, PF flat |
| Killzone / session narrative | Context gate | **No** | All narratives negative avg; N-only |
| Premium/discount day-loc | Context gate | **No** | Classical loc buckets not better (often worse) |
| Toxic-day fade veto | Context gate | **No** | Cuts N; PF unchanged |
| MaxSl / minExt / first-cycle / no-same-bar | Quality gate | **No** | No material PF/ret lift (or worse) |
| `trend_pullback` entry mode | Context | **No** | PF worse + freq crush (2.7/wk) |
| Displacement / reclaim-hold1 / CHoCH / score / V2 | Confirm pile | **No** | Prior + this pass: N-cut or no-op |
| Chop MFE trail / late BE / hold96 alone | Exit knobs | **No** | Not enough to flip edge |

**Rule:** a layer is “optimum-enhancing” only if it improves PF **or** OOS return **without** collapsing frequency (&lt;~60% of CORE). Otherwise leave it off.

---

## 4. Operational rules (LIQ_CORE defaults)

| Rule | Definition |
|------|------------|
| **Entry TF** | **15m** (TF sweep: 5m PF 0.24; 15m 0.31 @ 7.3/wk; 1h 0.33 @ 5.5/wk — none profitable; 15m best freq×PF) |
| Levels | PDH/PDL **on**; session EQH/EQL **on** (`intradayLiqSessionExtreme: true`) |
| Sweep | Pierce beyond level by `sweepPct` (default 0.1%) |
| Reclaim | Close back through level; `reclaimHoldBars` **2** (path-confirm; P1) |
| Same-bar | **Allowed** at reclaim detection (`rejectSameBarReclaim: false`); entry is **2 bars later** |
| Body / HTF / score floors | **Off** as hard gates |
| CHoCH / V2 quality / VP / trend-cont | **Off** |
| Brackets | SL beyond wick + buffer; **no TP1 partial**; TP2 capped by `maxTpRr` (**2**) |
| `minRr` | **1.0** (concept floor); ablate vs 1.5 |
| Pick mode | `intradayLiqPickMode: "chronological"` |
| Caps | `maxTradesPerDay` 3–5; `maxTradesPerSidePerDay` 2; `minBarGap` 2 |
| Hold | `maxHoldBars` 48 (15m ≈ 12h) |
| Dead-trade | **Off** (A/B REJECT — clips slow runners) |

Preset key: `INTRADAY_PRO_LIQ_CORE_15M` · playbook tag `intradayLiqPlaybook: "LIQ_CORE"`.

---

## 5. Implementation contract (live ≡ backtest)

| Requirement | Detail |
|-------------|--------|
| Causal levels | Prev-day H/L assigned before updating the current day |
| No EOD look-ahead | Do **not** sort the day’s candidates by quality and pick the winner after the fact |
| Chronological picks | First valid setups in bar order, subject to caps / minBarGap |
| Solo fast path | Liquidity-only gates; no Fib/VP/OF required |
| Config honesty | `RequireHtfAlign` without counter-trend veto is a **no-op on PDH/PDL** in legacy code — CORE leaves HTF align **off** until a real gate is proven |

### Known legacy defects (do not reintroduce)

| Issue | Location | CORE rule |
|-------|----------|-----------|
| EOD `onePickPerDay` quality sort | `selectIntradayPicks` | Use `chronological` |
| HTF align no-op on PDH/PDL | `passesLiqHtfAlign` | Off until wired + A/B |
| Session hours only on composite path | `intradayPro` | Killzone off by default |
| Body 0.35 / score≥52 / minExt 0.8% | Legacy LIQ_15M | Ablate; not CORE defaults |
| V2 binary gates | `LIQ_15M_V2` | Stay off |

---

## 6. Banned / rejected paths (do not re-run as “fixes”)

| Path | Verdict | Decision / note |
|------|---------|-----------------|
| LIQ FREQ_EDGE | REJECT | `2026-07-14-liq-freq-edge-stream-reject.md` |
| LIQ_15M_V2 filter stack | REJECT | Destroyed recall |
| LIQ + VP confluence | REJECT | N collapse |
| LIQ + VP proximity | REJECT | Worse PnL + freq |
| CHoCH required | REJECT | 0 trades (BTC) |
| Blanket breakdown veto on BNB | REJECT | Coin-specific; hurts BNB |
| Trend continuation + day-router | BANNED | Until full rewrite |
| onePickPerDay off alone (legacy) | Hurt return | Need chronological + risk caps, not spam |
| Full guide stack on CORE by default | REJECT default | Wick+HTF+KZ+disp crush N; use `docs/LIQ_COIN_OPTIMIZATION_PROCESS.md` one-change |

**Guide alignment (2026-07-23):** live LIQ solo now uses `selectIntradayPicks` (parity with backtest). Opt-in guide knobs: wick/body, follow-through ATR, ATR SL buffer, `swing_pivot` levels. See `docs/LIQ_COIN_OPTIMIZATION_PROCESS.md`.

---

## 7. Filter policy

1. **Hypothesis first** — name the failure mode.
2. **One change** per experiment.
3. Full `runSimulation` with fees + slippage (+ funding when available).
4. Promote a hard gate **only if** OOS return improves (or holds ≥ baseline) **and** frequency does not collapse.
5. Soft scores may rank when two signals conflict; they must not silently delete most candidates.
6. Prefer **exit** changes over entry vetoes when edge is near breakeven at acceptable N.

---

## 8. Experiment log

| Date | Hypothesis | Change | Window / coins | N / tw | Ret / PF | Verdict |
|------|------------|--------|----------------|--------|----------|---------|
| 2026-07-23 | Rebuild needs doctrine + live picks | Ship LIQ_CORE + chronological + baseline script | — | — | — | **INFRA** |
| 2026-07-23 | Concept-only + chrono raises frequency without wrecking edge | CORE vs legacy + ablations | 2025-01→2026-06 BNB/ETH/BTC | CORE BNB **539 / 7.3/wk** PF **0.31** (−146%); legacy BNB **75 / 1.0/wk** PF **0.55** (−29%) | `.liq-core-baseline.json` | **FREQ OK / EDGE FAIL** |
| 2026-07-23 | Autopsy → exits / confirm / killzone / HTF restore edge | Full autopsy + A/B r1–r3 | same | Instant SL dominates (−$200); no A/B reaches PF≥1 at high N | `.liq-core-autopsy.json`, optimize-ab/r2/r3 | **OPTIMIZE REJECT** |
| 2026-07-23 | W/L + TF + only enhancing layers | Feature autopsy; 5m/15m/1h; exit/risk A/B | BNB 2025-01→2026-06 | **15m** best TF; **X4 no-partial** PF **0.50** / −99% @ 7.4/wk; entry filters reject | `.liq-core-wl-tf-enhance.json`, `.liq-core-risk-layer-ab.json`, `2026-07-23-liq-core-wl-tf-enhance.md` | **ENHANCE PARTIAL** (exit wired; still EDGE FAIL) |
| 2026-07-23 | Dead-trade compresses no-follow without cutting N | D1–D10 + T1 A/B on CORE+X4 | BNB same | D* **REJECT** (winner $ 97→76); **T1 maxTpRr=2** PF **0.53** | `.liq-core-rootcause-deadtrade.json`, `.liq-core-deadtrade-r2.json`, `2026-07-23-liq-core-deadtrade-reject.md` | **DEAD-TRADE REJECT / T1 PROMOTE** |
| 2026-07-23 | Path-confirm / multi-coin / next playbook probe | hold2–3, trend_pullback, oracle skip | BNB+ETH+BTC | Multi-coin all EDGE FAIL; oracle PF **2.54**; **P1 hold2** PF **0.60** | `.liq-core-next-playbook-probe.json`, `2026-07-23-liq-core-next-after-deadtrade.md` | **P1 PROMOTE / fade still FAIL** |
| 2026-07-23 | BNB-only 3y + liquidity feature optimize | Feature autopsy + L*/C* A/B + holdout | BNB 2023-07→2026-07 | **1056t / 6.7/wk / PF 0.53**; L8/C1 IS lift but HOLD worse | `.liq-core-bnb-3y-optimize.json`, `2026-07-23-liq-core-bnb-3y-optimize.md` | **3Y EDGE FAIL / NO NEW GATE** |
| 2026-07-23 | Y25 autopsy → Asia/same-bar/tox/maxSl/loc; residual wide-SL / weak vol | AST stack + **SweepMinVolRatio 1.5** | BNB 2023-07→2026-07 | vol15: Y25 **+11** / H12 **+11** / Y26 **+1.4** / FULL **+26** PF **1.56** @ **0.21/wk** | `.liq-bnb-l0-vol-hard-ab.json`, `2026-07-23-liq-bnb-ast-vol15-sleeve.md` | **RESEARCH_SLEEVE_LOW_FREQ** (not CORE / not live) |

### Autopsy root causes (BNB CORE) — the WHY

Bad equity is **path economics after entry**, not “missing” session/HTF confirms:

1. **Instant no-follow** — `never_green` + `sl_no_follow` ≈ **−$165** (~78% of loss $). Reclaim often fails to displace; full 1R SL fires.
2. **Payoff asymmetry** — SL mass (−$201) vs winners (+$66); need ~50–60% WR to break even, have ~26%.
3. **Runners pay** — bars 33+ are the only positive hold bucket; early TP1 partials amputate them → **X4 no-partial** (PF 0.31→0.50).
4. **Toxic fades secondary** (−$49). Range fades also lose — not “just trend days.”
5. **Entry/liquidity filters fail as optimization** — HTF / killzone / prem-disc / maxSl / minExt cut N without PF≥1. Failure is weak as an entry label.
6. **Dead-trade also fails as optimum** — bar×MFE cannot tell “never green” from “slow true stop-run”; compression clips the paying cohort.
7. **Latent edge exists** — oracle skip of instant cohort → PF **~2.5** / +69%. Path-confirm (hold2) captures a slice of that without look-ahead.

### Optimum optimization path (updated after A/B)

| Do | Don't |
|----|-------|
| Keep concept entries + chronological + X4 full size | Stack context/confirm gates that only cut frequency |
| **Closer TP** (`maxTpRr=2`) + **reclaim hold 2** | Pretend soft “keep good hours” is edge |
| Build **LIQ_ACCEPT** (hold-beyond sweep continuation) as new stream | Tune D* / trend_pullback / day-router spam |
| Leave dead-trade **off** on CORE | Default-wire dead-trade after REJECT |

Decision: `2026-07-23-liq-core-rootcause-why.md`, `2026-07-23-liq-core-deadtrade-reject.md`, `2026-07-23-liq-core-next-after-deadtrade.md`.

### Code / preset updates

- Killzone gate works without requiring market-state gate.
- `intradayLiqHtfAlignPdhPdl` wires HTF onto PDH/PDL when requested.
- CORE exit: `intradayLiqPartialTp: false`, `intradayLiqTp1Enabled: false` (X4).
- CORE TP: `intradayLiqMaxTpRr: 2` (T1).
- CORE path: `intradayLiqReclaimHoldBars: 2` (P1).
- CORE BE: `intradayLiqBreakevenAfterPartial: false` (X5) — was clipping runners at 1R after X4.
- Dead-trade compression available in `runner.js` (opt-in) — **not** CORE default.
- Mitigation / level-rebreak plumbing exists (opt-in) — **not** CORE default (holdout fail).

**No live lock.** CORE remains a harvest / research baseline (PF ~0.65 after X5; still EDGE FAIL).

---

## 9. Next experiments (ordered)

1. ~~Baseline + ablation~~ **Done** (FREQ OK / EDGE FAIL).
2. ~~Autopsy~~ **Done** — SL/never-green dominate.
3. ~~Confirm/exit/killzone/HTF optimize~~ **Done** — **REJECT** entry piles.
4. ~~W/L + TF + enhance map~~ **Done** — 15m TF; X4 exit wired.
5. ~~Dead-trade A/B~~ **Done** — **REJECT** on CORE; T1 wired.
6. ~~Path-confirm + multi-coin honesty~~ **Done** — P1 wired; fade still FAIL on BNB/ETH/BTC.
7. ~~**LIQ_ACCEPT playbook**~~ **Done** — implemented; BNB 3y **REJECT** (`2026-07-23-liq-accept-bnb-3y-reject.md`). Holdout PF 0.46–0.55, ret ≤ 0.
8. ~~BNB 3y liquidity-feature optimize~~ **Done** — no holdout-valid gate; see `2026-07-23-liq-core-bnb-3y-optimize.md`.
9. WF + MC + gates only when multi-coin OOS>0, ≥30 OOS trades, PF≥1.
10. ~~**Hybrid fade+accept router**~~ **Done** — BNB Y25/H12/FULL **REJECT** (`2026-07-23-liq-bnb-hybrid-year-regime-reject.md`). ACCEPT spam; no Y25 PF≥1.
11. ~~**Progress-confirm stop entry**~~ **Done** — soft near-flat FOOLED; hard Y25 **−34%** → **REJECT** (`2026-07-23-liq-bnb-progress-confirm-reject.md`). Plumbing opt-in only.
12. ~~**BNB LIQ AST + vol15**~~ **Done as sleeve** — `INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M` (`2026-07-23-liq-bnb-ast-vol15-sleeve.md`). Low-freq research only (~0.2–0.3/wk) — **not** the returns+freq answer.
13. ~~**No-follow exit proxies**~~ **Done** — dead-trade regrid + progress-confirm **REJECT** at tw≥2 (`2026-07-24-liq-bnb-nofollow-exit-reject.md`). Soft MFE keep remains look-ahead only.
14. ~~**MFE-survivor at-entry discriminator**~~ **Done** — no causal feature soft-clears (`2026-07-24-liq-bnb-mfe-survivor-discriminator-reject.md`).
15. ~~**LIQ_BNB_STOPRUN**~~ **Done** — ACCEPT+weekly/HTF/vol/follow **REJECT** (FULL ~−100%; `.liq-bnb-stoprun-ab.json`, `2026-07-24-liq-bnb-stoprun-reject.md`). Follow-through wired on ACCEPT (opt-in). Soft abort-with-cost also fails Y25/H12 (`2026-07-24-liq-bnb-soft-abort-holdout-fail.md`).
16. ~~**CORE + RequireFollowThrough 0.5ATR/2**~~ **Done** — near no-op (1034→1001; FULL PF 0.65); **REJECT** (`2026-07-24-liq-bnb-core-followthrough-reject.md`). “Missing confirm” at guide default is not the gap on BNB CORE fade.
17. ~~**Adaptive autopsy + relative FT + continuous soft**~~ **Done** — instant_no_follow 75.5% of loss $; relative FT modes wired (`atrPct|volSpike|regime`); **0 softPassers**; hard A/B skipped (`2026-07-24-liq-bnb-core-adaptive-soft-reject.md`).
18. ~~**Architecture fork LIQ_MAP + SMC**~~ Ran once; **FORK_REJECT** — user clarified stay on LIQ trade autopsy, not other strategies (`2026-07-24-liq-bnb-arch-fork-reject.md`).
19. ~~**1y deep candle autopsy**~~ **Done** — micro_mfe_then_sl dominates $ loss; ok_path PF~2.6; MinSlPct 1.2% → Y1 PF 0.90 still red — **REJECT** (`2026-07-24-liq-bnb-core-1y-deep-autopsy.md`).
20. ~~**Guide audit + VP-style param optimize**~~ **Done** — CORE is truncated vs ICT (missing disp/MSS + retest entry). Soft prepared = `dispOK∧slWide`. Best hard `disp+vol+minSl` Y1 PF **0.94** still FAIL gates; `guide_mss_entry` year-inverts — **REJECT promote** (`2026-07-24-liq-bnb-guide-correct-optimize.md`).
21. ~~**Prepared-cell + freq restore**~~ **Done** — expectancy green Y1+HOLD+FULL on mitigation+disp+minSl+toxic. Locked research sleeves `INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_15M` (~+13% FULL @ 1.56/wk) and `…_H020_15M` (~+60% FULL @ 1.5/wk). **tw&lt;2** — RESEARCH_SLEEVE not live (`2026-07-25-liq-bnb-prepared-mit-sleeve.md`).
22. ~~**Residual + one-sided toxic freq restore**~~ **Done** — soft: one-sided daySit near tw≥2; hard: `DaySituationBias` modes `buy_breakdown`|`sell_breakout`. Cleared **Y1+HOLD tw≥2 + EG + FULL EG**. Primary `INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M` (mit030/h020/buy_bd): Y1 +22% @ 2.01/wk, HOLD +7% @ 2.3/wk, FULL +31% @ 2.25/wk. Cousin `…_SELLBO_15M` FULL +44% @ 2.13/wk. **RESEARCH_SLEEVE** — not live until WF+MC+4-gates (`2026-07-25-liq-bnb-onesided-freq-restore.md`).
23. ~~**BUYBD forward-slice check**~~ **Done** — UI backtest reconciliation split Y1 by half: **2025 H2 +40% @ 2.51/wk PF 1.46** vs **2026-01→07 −9.6% @ 1.41/wk PF 0.78 DD 16%**. Item 22's Y1 PASS is a **window artifact** — the gain is regime-concentrated in 2025 H2 and the forward slice fails return *and* frequency. **BUYBD not deployable; WF/MC blocked** (`2026-07-25-liq-bnb-ui-backtest-smc-not-buybd.md`, `scripts/verify-buybd-window-ab.mjs`).
24. ~~**Compressed-regime stand-down**~~ **Done** — half-year R-autopsy → soft screen → hard A/B `intradayLiqRangeCompressionMin: 0.75`. Flips every previously-red half (2024H1/2025H1/2026H1) to flat/green; FULL **+64.5% @ 2.02/wk**, OOS **+46% @ 1.75/wk**, no red half n≥10. Wired into BUYBD preset. **RESEARCH_SLEEVE** — 4-gate FAIL (MC p5 −6.7%, Calmar 0.69, OOS tw 1.75). Decision: `2026-07-25-liq-bnb-buybd-compression-standdown.md`.
25. ~~**Exit/risk economics for Calmar**~~ **Done — REJECT** — consec/daily/kill/weekly guards and BE@MFE/hold/chopTrail all fail to lift Calmar or MC p5; dominant loss is never-green SL (not exit-saveable). Decision: `2026-07-25-liq-bnb-buybd-exit-risk-reject.md`.
26. ~~**Never-green SL → maxAdx**~~ **Done — ACCEPT_RESEARCH_SLEEVE** — entry-time autopsy → hard A/B `intradayLiqMaxAdx: 50` on BUYBD+comp. **4-gate PASS** (OOS +64%, MC p5 +8.5%, Calmar 1.17). Freq ~1.7/wk FULL / 1.5 OOS (under ≥2). Mild red half 2025H1 −0.056. Wired into BUYBD preset. Decision: `2026-07-25-liq-bnb-buybd-nevergreen-maxadx.md`.
27. Next: multi-coin check (ETH/BTC) of BUYBD+comp+maxAdx50; freq restore only with a new named mechanism (not re-loosening ADX/compression).

---

## 10. Code map

| Piece | Path |
|-------|------|
| Cycle / brackets | `backend/src/strategy/techniques/liquidity.js` |
| Levels | `backend/src/strategy/techniques/liq/liquidityLevels.js` |
| Market / killzone | `backend/src/strategy/techniques/liq/marketState.js` |
| Picks / fast path | `backend/src/strategy/intradayPro.js` |
| CORE preset | `backend/src/strategy/presets/srIntradayOptimized.js` → `INTRADAY_PRO_LIQ_CORE_15M` |
| Frontend preset | `frontend/src/lib/srIntradayPresets.ts` |
| Baseline script | `backend/scripts/backtest-liq-core-baseline.mjs` |
| Autopsy script | `backend/scripts/research-liq-core-autopsy.mjs` |
| Thin alias | `backend/src/strategy/srIntraday.js` |

---

## 11. Glossary cross-refs

- `docs/TRADING_GLOSSARY.md` — §10 Liquidity & stop pools; §11 ICT/SMC (displacement, CHoCH); §17 Sessions.
