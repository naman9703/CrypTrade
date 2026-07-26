# Strategy Research — Handoff / Context

> Persistent context so any new chat (or after a Cursor crash) can continue
> without re-deriving everything. Last updated: 2026-07-15.
> **A new chat should read this file first.** Reference it with `@STRATEGY_RESEARCH_HANDOFF.md`.

## Goal

Find/build a profitable, automated intraday crypto trading strategy with the
**maximum honest, repeatable risk-adjusted return** (originally framed as
"50%+/month" — see the reality check below).

**Optimization doctrine:** Read `docs/STRATEGY_OPTIMIZATION_RULEBOOK.md`. We optimize
for **higher validated returns**, not random tweaks. Every experiment needs a
hypothesis, one change, full simulation, OOS check, and acceptance gates.
**There is currently no certified deployable baseline.** Do not treat any prior
“winner” as the default answer until it re-passes the harness with correct exits.

## TL;DR verdict (what we actually found)

- **50%/month is not achievable** with any honest, repeatable strategy. Any
  backtest showing it is overfit, ignores fees/slippage, or uses ruinous leverage.
- We rigorously tested **many registered strategies** across BTC/ETH/BNB,
  multiple timeframes, and up to 18 months of data with realistic costs. Most
  are net-negative OOS after costs (fee bleed on high-frequency paths).
- **`SUPERTREND_ELITE` deployability is REVOKED (2026-07-14).** Earlier “only
  OOS-validated / ~10–21% CAGR” tables used **wrong trailing** vs the exit we
  would actually run. Those numbers are **not** enough evidence to deploy.
  Decision: `backend/scripts/.research-decisions/2026-07-14-supertrend-elite-deployability-revoked.md`.
- **No strategy in this repo is currently certified for live capital.** Agents
  must not default answers to “use SUPERTREND_ELITE.”

## SUPERTREND_ELITE (research candidate — not certified)

5-gate Supertrend stack remains in the codebase for research
(`supertrendElite.js`, presets, portfolio scripts).

**Honesty re-validation (2026-07-14) under locked trail-only exit:** **REJECT.**
Exit contract: `2026-07-14-elite-st-exit-contract.md`.  
Decision: `2026-07-14-elite-st-honesty-reval-reject.md`.  
Phase 2 hypothesis: `2026-07-14-phase2-hypothesis-after-st-reject.md`
(disaster SL vs unbounded MAE/liq — one change next).

Historical pre-contract CAGR tables remain stale artifacts.

## Scripts created (all in `backend/scripts/`, run from `backend/`)

- `backtest-strategy-compare.mjs` — compare every strategy, ranked by return.
  `ONLY=HTF_RSI SYMBOLS=BNBUSDT FROM=2026-01-01 node scripts/backtest-strategy-compare.mjs`
- `backtest-validate-supertrend.mjs` — SUPERTREND_ELITE param sweep + WF + MC + gates per symbol.
- `backtest-portfolio-supertrend.mjs` — multi-coin portfolio, shared-account compounding + risk scaling.
  `SYMBOLS=BTCUSDT,BNBUSDT FROM=2025-01-01 node scripts/backtest-portfolio-supertrend.mjs`
- `backtest-validate-regime.mjs` / `backtest-validate-mc.mjs` — generic OOS validation harness.
- `backtest-regime-sweep.mjs` — REGIME_ADAPTIVE config sweep (strategy REJECTED, kept for reference).
- `backfill-taker-volume.mjs` — backfills real aggressor (taker) volume from Binance futures.
- `REGIME_ADAPTIVE_VALIDATION.md` — why the regime-adaptive strategy was rejected.

## Important data / infra state

- **Real order-flow data:** 1m candles had ZERO taker volume (order flow ran on a
  weak OHLC proxy — a big reason order-flow backtests were rubbish). Backfilled
  **BTC + ETH 15m** taker volume (`dataTier=taker`, ~100% coverage). 1m + BNB 15m
  still need backfilling (each symbol takes ~7 min due to Timescale compression).
- **Backfill gotcha:** the hypertable is compressed; bulk UPDATE needs
  `SET timescaledb.max_tuples_decompressed_per_dml_transaction = 0` on the client.
- **DB runs in Docker** (TimescaleDB on `localhost:54333`). If you get
  `ECONNREFUSED 127.0.0.1:54333`, Docker Desktop stopped — run `open -a Docker`,
  wait for the daemon, then `docker compose up -d` from repo root. Data persists in
  the `trading_trading-data` volume.
- **`metrics.js` fix:** R-multiples now use entry-time risk (`initialRiskUsd` /
  `initialSlPrice`, recorded in `runner.js`) so breakeven-trailing no longer
  inflates R to infinity. Trades also carry `regime`.
- **Risk overlay** (in `runner.js` + `bot.js`): `riskScale`, vol-target sizing,
  `riskKillSwitchDdPct`, `riskConsecutiveLossLimit`, `riskWeeklyMaxLossPct` — built,
  tested, NOT yet wired into live execution.

## Rejected approaches (don't re-chase these)

- REGIME_ADAPTIVE (trend/range/breakout router): negative OOS, entries below random hit-rate.
- Mean-reversion, EMA cross, breakout-vol, momentum-surge: all net-negative; high-frequency ones lose 90%+ to fees.
- HTF_RSI: UI claimed ~125% but honest backtest is −17.8% (overfit).
- Order-flow engine on real data: over-gated (0–6 trades), no edge as currently written.

## Active research stream (2026-07)

**Volume Profile FREQ (coin-resolved, 2026-07-15):** Uniform ETH config fails on BNB.
Presets (UI fees / pad / signalStart): ETH open+softHTF ~79t / ~+118% @ 1.5/wk;
BNB **vah+val + HTF 0.25%** ~70t / ~+52% @ 1.35/wk; BTC shorts HTF 0.15% ~41t / ~+17% @ 0.8/wk
(BTC funnel reopen rejected — loosening goes net-negative).
**ETH macro-adapt SELL HTF (2026-07-15):** pullback shorts in bull macro were the 2023–24
bleed. Locked `vpSellMacroAdapt` soft 0.25% / bull 0.50% → 3y +148% vs +94% baseline;
all Jun–May years ≥0; N 239→199. See `2026-07-15-eth-vp-freq-2023-24-autopsy.md`,
`2026-07-15-eth-vp-freq-macro-adapt-sell.md`.
**ETH buy-chase filter (2026-07-15):** REJECTED as endpoint (settling for +0.8% by cutting
N). Deep regime autopsy: year gap is VAL follow-through (+$22 vs +$101) + vacuum VAH
(path≥2% loses **both** years) + thin va_rejection — not prior5d. Vacuum-retest and flat
BE@MFE also REJECTED full-sim. See `2026-07-15-eth-vp-freq-regime-behavior-autopsy.md`.
**ETH chop SELL MFE giveback trail (2026-07-15):** locked — same N=263, full +135%→+145%,
2022–23 −5.4%→−1.5%, 2023–24/2025–26 unchanged. SELL-only (BUY trail regresses 2023–24).
Decision: `2026-07-15-eth-vp-freq-chop-mfe-trail.md`.
**ETH va_rejection wick quality (2026-07-16):** locked `vpRejectionMinWickRatio=0.35` →
full +145%→+184%, 2023–24 0%→+4.2%, 2025–26 +119%→+127%, N 263→259. Close-depth and
global vacuum max-path REJECTED (regress 2023–24). Decision:
`2026-07-16-eth-vp-freq-rejection-wick-lock.md`.
**ETH regime-adaptive stack (2026-07-16):** locked three condition→behaviour rules on top of
macro+chop+wick: (A) vacuum VAH cap outside bull macro (`path>2%`, `prior60d≤5%`), (B) block
SELL `va_rejection` when `prior20d≤−5%`, (C) non-bear VAL shorts need HTF≥0.5% when
`prior60d>−5%`. Combined ABC: **204t +250% DD35%**; 22–23 **−1.5%→+8.5%**, 23–24
**+4.2%→+5.3%**, 25–26 +127%→+124%. See
`2026-07-16-eth-vp-freq-regime-adaptive-lock.md`.
**ETH buy-chase reopen (2026-07-16):** on top of the adaptive lock, the previously rejected
plain chase filter becomes valid: `vpBuyChaseFilter=true`, `vpBuyChaseMaxPrior5dPct=0.08`.
Result: **186t +353% DD27%**; 22–23 **+18.1%**, 23–24 **+23.4%**, 25–26 unchanged at
**+124.0%**. Non-bull-only chase variant failed to improve. New baseline removes many residual
bad VAH continuation / relief-rally buys; re-run autopsy for what remains. Decision:
`2026-07-16-eth-vp-freq-buy-chase-reopen.md`.
**ETH weak-bear short floor (2026-07-16):** remaining 2023–24 short losers were not bull-macro
shorts, but *weak-bear transition* shorts (`macroBull=false`, `prior20d>-10%`) with shallow HTF.
Locked `vpSellWeakBearMinHtfSepPct=0.005`, `vpSellWeakBearPrior20dFloorPct=-0.1`. Result on top
of chase baseline: **177t +466.7% DD26.8%**; 22–23 **+17.2%**, 23–24 **+45.5%**, 25–26
**+130.5%**. Tighter 0.8% REJECTED (kills 2025–26). Decision:
`2026-07-16-eth-vp-freq-weak-bear-short-lock.md`.
**ETH vacuum VAH pullback gate (2026-07-16):** residual 2022–23 bleed was vacuum
`vah_breakout` chase (`prior5d>1%`) not structured 1–2% breaks. Locked
`vpBuyVacuumMaxPrior5dPct=0.01` on path≥2% only. Row autopsy: 22–23 vacuum
9t/−$10 → 4t/+$8; 23–24 vacuum improves. Full-sim A/B pending DB recovery.
Decision: `2026-07-16-eth-vp-freq-vacuum-pullback-lock.md`.
Runtime: `vpPlaybook=FREQ` → `fillVolumeProfileFreqDefaults`. Also
`2026-07-15-vp-freq-coin-tune.md`, `2026-07-15-vp-freq-bnb-btc-funnel.md`.
Research-only; not WF+MC certified.

**BTC VP FREQ two-sided lock (2026-07-16):** “Short-biased” was a **mistaken ban** after
one bear-year VAH funnel. BUY `va_rejection` was always live and strong; raw VAH fails
via **vacuum/bear**, not “BTC can’t long.” Reopened `vah_breakout` with
`vpBuyBreakoutMaxPathNonBullOnly` vacuum cap. Full-sim **~56t / +90% / DD24%** (was
~34t / +62% shorts-only); all four years ≥0; ~0.27/wk. Decision:
`2026-07-16-btc-vp-freq-long-reopen-lock.md`. Not WF+MC certified.
**BTC frequency attempts (2026-07-17):** 5m VP FREQ **REJECTED** on 2025–26
(15m +31% vs 5m about −40%; VAL shorts and VAH longs both fail). SELL-only MFE
giveback exit **REJECTED** as promotion (DD improves but return falls +90%→+80–84%).
Decisions: `2026-07-17-btc-vp-freq-5m-playbook-reject.md`,
`2026-07-17-btc-vp-freq-sell-mfe-exit-reject.md`.
**BTC prepared-regime abstention (2026-07-17):** concept accepted (abstain outside
validated conditions, not year hardcodes). Best OOS damage control still −9% on
2021–22 and cuts lock frequency; **no preset change**. Decision:
`2026-07-17-btc-vp-freq-regime-abstain.md`.
**BTC prepared-regime Layer-1 LOCK (2026-07-17):** matrix-validated bleed cells
blocked (`vpPreparedRegimeOnly`: vacuum VAH + vacuum VAL in bear_trend).
OOS 2021–22 −34%→−4%; lock 2022–26 +90%→+116% DD24→9; full 2021–26 +13%→+84%.
Doctrine for live novelty in
`2026-07-17-btc-vp-freq-prepared-regime-lock.md`. Not WF+MC certified.
**BTC robust-path follow-up (2026-07-17):** vacuum **retest** REJECTED (still bleeds;
lock collapses). Frequency restore via poc expand fragile. Residual OOS bleed was
SELL `va_rejection` after prior20d≤0 → locked adaptive block (`vpRejectionExtendedPriorPct:0`);
OOS **+7.4%**, lock unchanged **+116%**. Decision:
`2026-07-17-btc-vp-freq-robust-path.md`.
**BTC VP FREQ certification (2026-07-17):** 2020–2026 frozen-lock validation with
funding + expanding purged WF + MC + cost stress passes the **4 core gates** and
has **no negative Jun→May years**: ~**75 trades / +145% / CAGR ~15% / Calmar ~1.10 / DD ~13.7%**;
WF OOS sum ~**+86.9%** on **61** OOS trades; MC p5 ~**+13.2%**. However
frequency is only ~**0.22 trades/week**, so verdict is **RESEARCH_SLEEVE_LOW_FREQ**
— **not** a standalone deployable stream under the ≥2/wk rule. Cost sensitivity is
acceptable at slip×2/×4, but liquidity crunch turns sharply negative. Decision:
`2026-07-17-btc-vp-freq-certification-sleeve.md`.
**BTC VP FREQ matrix extension (2026-07-17):** 2020–2026 fold-aware cell matrix confirms
`SELL|val_breakdown|bear_trend|vacuum` as durable bleed; unknown/unseen cells still
dominate early folds, so allowlist-only is **too sparse** today. Added shared
condition-cell taxonomy + novelty monitor plumbing; keep deny-known-bleed doctrine,
not strict allowlist for live. Decision:
`2026-07-17-btc-vp-freq-cell-matrix-2020-26.md`.
**BTC VP FREQ frequency restore (2026-07-17):** isolated probes to raise N without
vacuum reopen all **rejected**. `poc_bounce` improved 2021–22 and N but reduced
lock return (~+115%→+101%) and added negative POC trades; softer rejection wick
damaged both OOS and lock; score/gap loosening was non-binding. No BTC-only
frequency promotion. Decision:
`2026-07-17-btc-vp-freq-frequency-restore-reject.md`.
**BTC VP FREQ stress/risk (2026-07-17):** synthetic flash-crash / exchange-gap
behavior is tolerable; sustained bear remains positive but lower; liquidity crunch
(slippage×8, taker-only) is strongly negative. Backtest risk overlays
(`riskKillSwitchDdPct`, weekly cap, consecutive-loss cooldown) did **not** improve
the locked stream; keep overlays **off** for research baseline and use the new live
plumbing as protection, not as edge creation. Decision:
`2026-07-17-btc-vp-freq-stress-risk.md`.

**LIQ FREQ_EDGE stream — REJECTED (2026-07-14).** Classical fade only (no trend
continuation). Full-window test: best frequency ~1 trade/week on BNB legacy, still
slightly negative; FREQ_EDGE presets worse. Target 2–5 trades/week/coin **not found**.
Decision: `2026-07-14-liq-freq-edge-stream-reject.md`. Script: `backtest-liq-freq-edge.mjs`.

**LIQ_CORE rebuild (2026-07-23) — active research stream.** Parallel to legacy LIQ:
concept-only hard gates, chronological picks, PDH/PDL + session extremes.
Doctrine: `docs/LIQ_CORE_PLAYBOOK.md`.
Preset: `INTRADAY_PRO_LIQ_CORE_15M` — **X4** + **T1** + **P1** + **X5 BE-off** (still EDGE FAIL at high N).
Dead-trade / ACCEPT / hybrid / progress-confirm: **REJECT**.
**BNB LIQ research sleeve (updated 2026-07-23):** `INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M` —
Asia+**London** + same-bar + toxic + maxSl 0.8% + prem/disc + vol≥1.5 +
**session extremes OFF** (PDH/PDL). Hard: FULL **~+28%** PF **1.44** @ **~0.27/wk**;
Y24/Y25/Y26/H12 green; Y23H2 ~flat. Still **`RESEARCH_SLEEVE_LOW_FREQ`** — not live.
Decisions: `2026-07-23-liq-bnb-ast-vol15-sleeve.md`,
`2026-07-23-liq-bnb-freq-restore-noSess.md`. Next: WF+MC+gates; multi-coin breadth for freq.

**LIQ SWEEP_RECLAIM classical** — BNB ~1/wk near breakeven on 17mo; ETH/BTC coin-specific.
Trend continuation + day-router **remain banned** until rewrite.

**Funding-rate cash-and-carry — research CLOSED (NO-GO) on BTC/ETH form.**
Code remains at `backend/src/strategy/fundingArb/` for future reopen only.
- Phase 2a/2b: dual-leg sim fails honesty (fees > funding after anti-churn).
  Decisions: `2026-07-14-funding-arb-phase2-nogo.md`,
  `2026-07-14-funding-arb-phase2b-nogo.md`.
- **Do not** reopen with more threshold / hold / maker tweaks on BTC+ETH.
- Reopen **only** under a different premise: (1) ≥50%+ ann extreme episodes,
  (2) multi-symbol (non-BTC/ETH) high-funding regimes, and/or (3) real spot+basis
  after candles stop overwriting futures (current basis ≈ 0 proxy).
- No certified deployable stream. Do not nominate SUPERTREND_ELITE by default.

## Open next steps

1. **BTC VP FREQ** — certified only as a **low-frequency research sleeve**, not a
   standalone stream. Next = either (a) a genuinely new BTC-native positive setup
   family / timeframe with its **own** prepared matrix, or (b) ETH breadth /
   portfolio honesty. Do **not** loosen 15m vacuum gates to chase N. See
   `2026-07-17-btc-vp-freq-certification-sleeve.md`,
   `2026-07-17-btc-vp-freq-frequency-restore-reject.md`.
2. **VP ETH FREQ — certified research sleeve (2026-07-19).**
   H1–H4 + **H5** (weak_bear vac VAL prior60>15%) + **H6** (block bull_trend
   vacuum VAH) + **volTargetSizing**. Certification 2020→2026:
   **225t / +567% / Calmar 1.37 / MC p5 +34% / no year ≤−25%** →
   **`RESEARCH_SLEEVE_LOW_FREQ`** (freq 0.67/wk fails ≥2/wk deploy).
   Decision: `2026-07-19-eth-vp-freq-certification-sleeve.md`.
   Prior reject: `2026-07-17-eth-vp-freq-certification-reject.md`.
   UI: rebuild Docker app after preset change (`vpNoveltyEnabled` still false).
3. **VP BNB FREQ — RESEARCH_SLEEVE_LOW_FREQ (2026-07-23 H9).**
   Coin-native VAL-only stack + **H9 flat prior60 ±8%** (was ±5%). Cert window:
   **104t / +303.9% / Calmar 1.31 / MC p5 +22.5% / no year ≤−25%**, WF OOS
   **+223.7%** on **84** trades. Core gates **PASS**; freq **0.31/wk** fails deploy.
   Decision: `2026-07-23-bnb-vp-freq-h9-calmar-sleeve.md`.
   Prior Calmar-miss reject: `2026-07-20-bnb-vp-freq-certification-reject.md`.
4. **VP FREQ portfolio honesty** — multi-coin sim with wired per-leg resolve (already in worker).
5. **VP FREQ next-5 (2026-07-25/26):** ZEC/DOGE/NEAR/ADA/XLM screened.
   - ZEC F3 soft-reject (green only via N-crush).
   - **DOGE F3 `RESEARCH_SLEEVE_LOW_FREQ` (2026-07-26 cert):** rej + paying POC (bleed POC
     denied), minATR 0.8%, BUY body 0.25, score 6, gap 1. FULL **+329% / Calmar 1.49 /
     tw 0.21**. Core gates **PASS** (OOS/MC/Calmar/WF); freq **FAIL**.
     Decisions: `2026-07-26-doge-vp-freq-poc-cell-cleanup.md`,
     `2026-07-26-doge-vp-freq-certification-sleeve.md`.
     Harness: `backtest-validate-vp-freq-doge.mjs`.
     Post-cert freq A/B: no path to ≥2/wk without re-redding years — archive N-chase.
   - Next: **NEAR F3** coin-native stream.
6. **LIQ BNB BUYBD + compression + maxAdx50 (2026-07-25) — RESEARCH_SLEEVE, 4-gate PASS.**
   Compression 0.75 fixed regime-red halves; never-green SL autopsy → `intradayLiqMaxAdx: 50`
   clears Calmar 1.17 + MC p5 +8.5% + OOS +64%. FULL **+108% @ 1.7/wk**. Frequency still
   under ≥2/wk; mild red half 2025H1 −0.056; BNB-only. Preset:
   `INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M`.
   Decisions: `2026-07-25-liq-bnb-buybd-compression-standdown.md`,
   `2026-07-25-liq-bnb-buybd-nevergreen-maxadx.md` (exit/risk reject:
   `2026-07-25-liq-bnb-buybd-exit-risk-reject.md`).
   Next: multi-coin check; do not re-loosen ADX/compression to chase frequency.
6. ~~VP BNB Calmar~~ **Done** — H9 sleeve above.
6. Phase 2 Exp-1: disaster SL on locked trail Elite (see phase2 hypothesis).
7. Funding arb parked until a reopen criterion is met.
8. Paper-trade only after gates pass under the exit model that will go live.

## Environment gotchas

- The sandbox cannot list/kill processes (`pkill`/`pgrep` fail) — avoid launching
  multiple long backtests at once; they contend for CPU and can't be killed.
- Run heavy backtests on the small 2026 window first; full 49k-bar history is slow.
- Some strategies (ENSEMBLE/CONFLUENCE/HTF aggregators) can be O(n²) and hang on 49k bars.
