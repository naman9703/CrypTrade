# Volume Profile FREQ — BTC / ETH / BNB optimization summary

> **Purpose:** Single handoff for how we optimized the VP FREQ setup per coin, what is locked, what certification said, and how to start the **next coin**.  
> **Last updated:** 2026-07-20  
> **Companions:** `docs/STRATEGY_OPTIMIZATION_RULEBOOK.md`, `docs/VP_FREQ_REGIME_OPTIMIZATION_PROCESS.md`, `STRATEGY_RESEARCH_HANDOFF.md`  
> **Presets:** `frontend/src/lib/volumeProfilePresets.ts` (+ backend `fillVolumeProfileFreqDefaults` / `vpPlaybook=FREQ`)

---

## Doctrine (applies to every coin)

1. **Coin-native only** — do not copy BTC prepared/bleed matrices onto ETH/BNB (or vice versa) without coin-native autopsy.
2. **One change per experiment** → full `runSimulation` with realistic costs → holdout years must not be crushed.
3. **Relative rules / abstain**, never calendar year hardcodes (`if year == 2021`).
4. **Success** = gates + better OOS return + acceptable frequency. Tiny N / “less negative” is not a deliverable.
5. **Frequency floor** for standalone deploy: ~≥2 trades/week/coin and ≥30 OOS trades. Low-N sleeves can still be **research sleeves**, not live main streams.
6. Decision logs live under `backend/scripts/.research-decisions/`.

**Engine path:** `vpPlaybook=FREQ` resolves per symbol to the locked preset below.

| Coin | Preset key | UI label (approx.) |
|------|------------|--------------------|
| BTC | `VOLUME_PROFILE_FREQ_BTC_15M` | ★ BTC FREQ |
| ETH | `VOLUME_PROFILE_FREQ_ETH_15M` | ★ ETH FREQ |
| BNB | `VOLUME_PROFILE_FREQ_BNB_15M` | ★ BNB FREQ (VAL lock) |
| SOL | `VOLUME_PROFILE_FREQ_SOL_15M` | ★ SOL FREQ (VAL bear60) |

---

## Shared starting point (before coin forks)

- **Strategy:** Volume Profile on **futures 15m** (rolling / composite VP — not true session TPO).
- **Core FREQ philosophy:** take prepared VA / vacuum / rejection setups when HTF + macro physics align; **abstain** known bleed cells.
- **Early multi-coin lesson (2026-07-15):** one uniform ETH funnel **fails on BNB**; BTC was short-biased by mistake after one bear-year VAH autopsy — longs were reopenable with vacuum caps.
- **Rejected globally for FREQ:** year hardcodes; BTC novelty allowlists on ETH; loosening vacuum gates only to raise N; 5m VP FREQ on BTC (2025–26 destroy).

---

## BTC — how we optimized

### Path (high level)

1. **Funnel reopen** — two-sided stack; reopen `vah_breakout` with non-bull vacuum path cap (long ban was wrong).
2. **Macro / weak-bear SELL HTF** — harder shorts in bull macro and weak-bear transition.
3. **VAL shorts** — require bear `prior60d` floor.
4. **Prepared-regime Layer-1** — `vpPreparedRegimeOnly`: block vacuum VAH + vacuum VAL in `bear_trend` (matrix-validated bleed cells).
5. **SELL `va_rejection`** — adaptive block after extended-down prior (`vpRejectionExtendedPriorPct: 0` lock).
6. **Frequency restore probes** — all rejected (poc expand fragile; softer rej wick hurts; score/gap non-binding).
7. **Certification 2020→2026** — frozen lock only.

### Locked behaviour (summary)

- Setups: vacuum, VAH breakout, VAL breakdown, va_rejection, naked POC (no `poc_bounce` in locked BTC FREQ).
- HTF base **0.5%**; macro-adapt SELL; weak-bear SELL HTF **0.8%**.
- Vacuum VAH path cap outside bull; prepared abstain on vacuum VAH + vacuum VAL bear.
- Novelty monitor **off** for live research baseline (`vpNoveltyEnabled: false` on portfolio; BTC sleeve keeps deny-known-bleed doctrine).

### Certification (2026-07-17)

| Metric | Result |
|--------|--------|
| Window | BTCUSDT 15m, 2020-01-01 → 2026-05-31 |
| Full sim | **75t / +145.4% / CAGR 15.0% / Calmar 1.10 / DD 13.7% / PF 2.17** |
| Frequency | **~0.22 / week** |
| Core gates | **PASS** (OOS>0, MC p5>0, Calmar>1, WF deg&lt;35%) |
| Verdict | **`RESEARCH_SLEEVE_LOW_FREQ`** — not standalone deploy |

**Do not next:** reopen vacuum gates to chase N.  
**Decision:** `2026-07-17-btc-vp-freq-certification-sleeve.md`

---

## ETH — how we optimized

### Path (high level)

ETH is the **template coin** for the regime process (`VP_FREQ_REGIME_OPTIMIZATION_PROCESS.md`).

| Phase | Failure named | Locked fix |
|-------|---------------|------------|
| 2023–24 | VAL shorts vs bull macro | `vpSellMacroAdapt` (soft vs bull HTF) |
| Chop | SELL MFE giveback | Chop SELL MFE trail only (BUY trail rejected) |
| Rejection quality | Thin `va_rejection` | `vpRejectionMinWickRatio=0.35` |
| Regime adaptive | Vacuum VAH / weak-bear rej / non-bear VAL HTF | Path cap non-bull; rej block extended down; non-bear VAL HTF≥0.5% |
| Chase | Bad VAH continuation | `vpBuyChaseFilter` @ 8% prior5d (reopened after adaptive lock) |
| Weak-bear shorts | Transition shorts shallow HTF | `vpSellWeakBearMinHtfSepPct` |
| Vacuum pullback | Relief `prior5d` on vacuum VAH | `vpBuyVacuumMaxPrior5dPct=0.01` |
| 2021–22 prepared | Dump / non-vac / extending bull60 VAL | H1–H3 relative abstains + H4 BUY rej min body |
| Cert path | Bull vacuum VAH chase; residual weak_bear vac VAL | **H6** block bull_trend vacuum VAH; **H5** prior60 ceil 15%; **volTargetSizing** |

**Rejected:** plain chase as endpoint; vacuum→retest; flat BE; BTC novelty crush; cell blankets; kill-switch as edge; fill-bar rejection path mismatch.

### Locked behaviour (summary)

- Broad setup allow-list (vacuum, VAH, VAL, POC bounce, va_rejection, naked POC).
- Macro-adapt SELL + weak-bear + non-bear HTF floors.
- Buy chase + vacuum prior5d + bull60 VAL dump/non-vac/extending blocks.
- H5/H6 + vol-target sizing (ATR ref 0.5%, mult 0.4–2×).
- Chop SELL MFE trail; rejection wick 0.35; buy rej min body 0.2.

### Certification (2026-07-19)

| Metric | Result |
|--------|--------|
| Window | ETHUSDT 15m, 2020-01-01 → 2026-05-31 |
| Full sim | **225t / +567% / CAGR 34.4% / Calmar 1.37 / DD 25.1% / PF 1.89** |
| Frequency | **~0.67 / week** |
| Core gates | **PASS**; catastrophic-year **PASS** |
| Cost stress | Survives slip×2; fragile slip×4 / liq crunch |
| Verdict | **`RESEARCH_SLEEVE_LOW_FREQ`** |

**Prior reject (2026-07-17):** Calmar/MC/catastrophic years failed before H5/H6/vol-target.  
**Decision:** `2026-07-19-eth-vp-freq-certification-sleeve.md`

---

## BNB — how we optimized

### Path (high level)

1. **Uniform ETH config fails** — BNB needs its own funnel (early 2026-07-15 coin-tune).
2. **Legacy mixed funnel** (`vah+val` + HTF 0.25%) was a checkpoint only — not the final lock.
3. **Coin-native autopsy** — VAH continuation/vacuum was the multi-year destroyer → **VAL-only** allow-list.
4. **Shared physics kept where BNB agreed:** bull60 VAL dump / non-vac / extending abstains.
5. **Prepared weak-bear:** block vacuum VAL in weak_bear + prepared bear vacuum VAL.
6. **H7** — flat/transition `prior60` VAL shorts bleed → `vpValSellBlockFlatPrior60` (±5%).
7. **H8** — sharp 5d rally shorts squeeze → `vpValSellChaseFilter` @ 5% prior5d.
8. **Rejected for cert:** VAH reopen; copying ETH `volTargetSizing`; flat chop exit overlays; blunt HTF harden as “fix Calmar”; ceilings that crush lock runners.

### Locked behaviour (summary)

```text
vpAllowedSetups: ["val_breakdown"]   # VAL shorts only
vpMinHtfSepPct: 0.0025
vpValSellBlockBull60Dump / NonVac / Extending (extend ratio 0.6)
vpValSellBlockWeakBearVacuum + vpPreparedRegimeOnly + vpPreparedBlockVacuumValBear
vpValSellBlockFlatPrior60 (±5%)
vpValSellChaseFilter @ prior5d 5%
vpNoveltyEnabled: false
```

### Certification (2026-07-20)

| Metric | Result |
|--------|--------|
| Window | BNBUSDT 15m, 2020-01-01 → 2026-05-31 |
| Full sim | **108t / +260.7% / CAGR 22.6% / Calmar 0.96 / DD 23.4% / PF 1.72** |
| Frequency | **~0.32 / week** |
| Core gates | **FAIL Calmar** (0.96 &lt; 1); OOS/MC/catastrophic-year **PASS** |
| Cost stress | Better than early BNB funnels; liq crunch still severe |
| Verdict | **`REJECT_CERTIFICATION`** (improved research baseline, not sleeve promote) |

**Decision:** `2026-07-20-bnb-vp-freq-certification-reject.md`  
**Next on BNB (if revisited):** raise Calmar without N-crush (sizing / one residual bleed cell) — do not reopen VAH without new coin-native evidence.

---

## SOL — how we optimized

### Path (high level)

1. **Backfill** SOLUSDT 15m futures from listing (~2020-09) — local DB previously only had ~2025-06+.
2. **Phase 0 FREQ core** — −94% full; only 2022–23 paid (+110%).
3. **Autopsy** — VAH vacuum multi-year destroyer; VAL pays in **bear60** only; rej/poc net-negative when VAL prepared.
4. **H1** vacuum VAH block → improves 2021–22; residual structured VAH still bleeds → **drop VAH**.
5. **H2b** `vpValSellRequirePrior60dBear` (−5%) — LOCK.
6. **H9 VAL-only** — all Jun→May years ≥0; chase overlays REJECT (hurt 2021–22).

### Locked behaviour (summary)

```text
vpAllowedSetups: ["val_breakdown"]
vpRequireHtfAlign: true
vpMinHtfSepPct: 0.0015
vpValSellRequirePrior60dBear: true
vpValSellPrior60dBearPct: -0.05
vpNoveltyEnabled: false
```

### Certification (2026-07-20)

| Metric | Result |
|--------|--------|
| Full sim | **154t / +111% / Calmar 0.55 / DD 26.7% / PF 1.33** |
| Frequency | **~0.55 / week** |
| Core gates | **FAIL** (Calmar, MC p5); OOS + WF **PASS** |
| Verdict | **`REJECT_CERTIFICATION`** |

Decision: `2026-07-20-sol-vp-freq-val-bear60-lock.md`  
**Next on SOL:** fix MC p5 / Calmar without reopening VAH or crushing N; optional bear-vacuum `va_rejection` add-back (one change).

---

## Side-by-side status

| Coin | Preset | Cert verdict | Full-window snapshot | Freq /wk | Standalone deploy? |
|------|--------|--------------|----------------------|----------|--------------------|
| **BTC** | `…_BTC_15M` | Research sleeve | 75t / +145% / Cal 1.10 | ~0.22 | **No** |
| **ETH** | `…_ETH_15M` | Research sleeve | 225t / +567% / Cal 1.37 | ~0.67 | **No** |
| **BNB** | `…_BNB_15M` | Reject cert | 108t / +261% / Cal 0.96 | ~0.32 | **No** |
| **SOL** | `…_SOL_15M` | Reject cert | 154t / +111% / Cal 0.55 | ~0.55 | **No** |

None meet ≥2 trades/week. ETH/BTC are **portfolio research sleeves**; BNB is a **stronger-than-before baseline** that still fails Calmar.

---

## What “optimized” means here (honest)

- **Optimized** = coin-native failure modes named → relative abstain / sizing → lock holds good years → WF+MC+gates run.
- **Not optimized for live size** until frequency doctrine is met **or** user explicitly accepts a low-freq sleeve portfolio.
- Portfolio honesty (shared capital, per-leg resolve) is still an open step (`vpPlaybook=FREQ` already resolves per symbol in worker).

---

## How to optimize the **next coin**

Follow `docs/VP_FREQ_REGIME_OPTIMIZATION_PROCESS.md`. Condensed checklist:

### Phase 0 — Baseline

1. Start from **FREQ core** defaults only (or a minimal HTF+setup allow-list) — **not** ETH/BTC/BNB locked overlays.
2. Pick symbol + **15m** unless coin-native evidence says otherwise.
3. Full sim: multi-year lock window + each Jun→May year. Record N / ret / DD / setup P&L split.

### Phase 1 — Autopsy (one bad window at a time)

1. Name **market character** (bull grind, bear vacuum, chop, squeeze…).
2. Split P&L by setup (VAH / VAL / vacuum / va_rejection / …).
3. Loser vs winner features: prior5d/20d/60d, HTF sep, path%, MFE/MAE, session if relevant.
4. Separate **universal** vs **coin-specific** features.

### Phase 2 — One change

1. Write hypothesis: *condition → behaviour* (take / abstain / size).
2. Implement **one** flag/threshold.
3. A/B full sim: bad year + good years + full window.
4. LOCK only if bad year improves **and** good years hold.
5. Log under `backend/scripts/.research-decisions/YYYY-MM-DD-<coin>-vp-freq-….md`.

### Phase 3 — Stack → certify

1. Freeze stack into `VOLUME_PROFILE_FREQ_<COIN>_15M` (+ backend resolve).
2. Run validation harness (same windows as BTC/ETH/BNB: ~2020→2026, expanding purged WF, MC, cost stress).
3. Verdict language: **REJECT** / **RESEARCH_SLEEVE_LOW_FREQ** / (only if freq+gates) promote path — never claim deploy on tiny N.

### Hard bans for the next coin

- Do not paste ETH H5/H6/vol-target or BTC prepared matrix without coin-native cells.
- Do not “fix” a year by excluding it from the cert window.
- Do not crush N to green a curve.

---

## Key artifacts / scripts

| Coin | Cert decision | Typical validate script |
|------|---------------|-------------------------|
| BTC | `2026-07-17-btc-vp-freq-certification-sleeve.md` | `backtest-validate-vp-freq-btc.mjs` |
| ETH | `2026-07-19-eth-vp-freq-certification-sleeve.md` | `backtest-validate-vp-freq-eth.mjs` |
| BNB | `2026-07-20-bnb-vp-freq-certification-reject.md` | `backtest-validate-vp-freq-bnb.mjs` |

JSON artifacts (when present): `backend/scripts/.vp-freq-{btc,eth,bnb}-certification.json`

---

## Next chat prompt (copy-paste)

```text
Read docs/VP_FREQ_BTC_ETH_BNB_OPTIMIZATION.md and docs/VP_FREQ_REGIME_OPTIMIZATION_PROCESS.md.
Optimize Volume Profile FREQ for <SYMBOL>USDT on 15m — coin-native autopsy,
one change at a time, full sim, no copying BTC/ETH/BNB locks blindly.
Start with Phase 0 baseline full-sim + year/setup split.
```

Replace `<SYMBOL>` with the next coin (e.g. SOL, XRP, …).
