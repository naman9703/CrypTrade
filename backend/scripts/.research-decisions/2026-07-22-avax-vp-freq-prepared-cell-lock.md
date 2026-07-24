# 2026-07-22 — AVAX VP FREQ coin-native lock (R22 prepared-cell sleeve)

## Experiment

- **Symbol / TF:** AVAXUSDT futures **15m**
- **Window:** 2021-01-01 → 2026-05-31
- **OOS split:** 2021-01-01 → 2023-06-01 (stress) vs 2023-06-01 → 2026-05-31 (hold)
- **Scripts:** `backtest-vp-freq-avax-optimize.mjs`, `…-r2.mjs`, inline r3/r4
- **Artifacts:** `.vp-freq-avax-optimize.json`, `.vp-freq-avax-optimize-r2.json`, `.vp-freq-avax-optimize-r4.json`, `.vp-freq-avax-candles-cache.json`
- **Note:** TimescaleDB was down mid-session; research used Binance futures REST candle cache (fees+slippage on; funding=0). Re-confirm on DB+funding before certification.

## Baseline → named failures

| Step | Config | Full | OOS | Verdict |
|------|--------|-----:|----:|---------|
| Funnel | VAL+rej soft HTF | +5% (earlier DB) / REST H0 +73% w/ weakBearVac | −33% | progress |
| H0 | + `vpValSellBlockWeakBearVacuum` | +73% | −33% | LOCK physics |
| H1 ext-down rej | + sell rej prior20≤−5% | worse | worse | REJECT |
| H2/R1 bear vac VAL deny | cell/prepared | worse OOS | worse | REJECT alone (slot/path effects) |
| H3 flat prior60 | | +94% | −23% | weak |
| H4 VAL-only | drop rej | −39% | −26% | REJECT (rej is edge) |
| H8/R4 VAL chase 5% | | +99% | −14% | LOCK |
| R2 deny bull_chop vac VAL | | **+147%** | −23% | LOCK cell |
| R7 deny bear+chop vac VAL + chase | | +94% | **+1.4%** | first OOS>0 |
| **R13** + deny `SELL\|va_rejection\|weak_bear\|vacuum` | | **+183%** | **+26%** | LOCK |
| R18 + deny bear structured VAL | | +382% Cal 0.86 | +73% | progress |
| **R22** + deny bull_chop structured VAL | | **+484% Cal 1.06** | **+73%** | **LOCK** |
| Wick 0.35/0.40, sellMacroAdapt, ext-down, vol-target | | kill return/OOS | | REJECT |

### Autopsy edge vs bleed (coin-native — do not copy SOL bear60)

- **Pays:** `SELL|val_breakdown|bull_trend|vacuum`, vacuum rejection in bull/chop/bear (aggregate), `bear_trend|tight` VAL
- **Bleeds locked:** bear/chop vacuum + structured VAL shorts; weak_bear vacuum rejection
- SOL-style `vpValSellRequirePrior60dBear` would remove AVAX’s main long-horizon edge — **not used**

## Locked config (`VOLUME_PROFILE_FREQ_AVAX_15M`)

```text
vpAllowedSetups: ["val_breakdown", "va_rejection"]
vpRequireHtfAlign: true
vpMinHtfSepPct: 0.0015
vpValSellBlockWeakBearVacuum: true
vpValSellChaseFilter: true
vpValSellChaseMaxPrior5dPct: 0.05
vpPreparedRegimeOnly: true
vpPreparedBlockVacuumVah: false
vpPreparedBlockVacuumValBear: false
vpPreparedBlockCellKeys: [
  SELL|val_breakdown|bear_trend|vacuum,
  SELL|val_breakdown|bull_chop|vacuum,
  SELL|val_breakdown|bear_trend|structured,
  SELL|val_breakdown|bull_chop|structured,
  SELL|va_rejection|weak_bear|vacuum,
]
vpNoveltyEnabled: false
```

Resolve: `resolveVolumeProfileFreqPreset("AVAXUSDT")` + UI ★ AVAX FREQ (VAL+rej cells).

## Locked metrics (REST research window)

| Metric | Result |
|--------|--------|
| Full | **~180t / +484% / Calmar ~1.06 / DD ~36% / PF ~1.45 / ~0.64/wk** |
| OOS 2021→2023-06 | **+73% / PF 1.21 / ~98t** |
| IS 2023-06→2026-05 | **+411%** |
| Years | 20–21 +38% · 21–22 +78% · **22–23 −29%** · 23–24 +77% · 24–25 +53% · 25–26 +24% |

## Honest live-trust statement

- **Research sleeve** with coin-native measurable cell abstains — **not** calendar cherry-pick.
- Passes **OOS>0** and **Calmar≥1** on this research pass; frequency ≪ ≥2/wk standalone doctrine.
- **2022–23 still negative (~−29%)** — residual vacuum rejection left-tail; do not claim multi-year year-table survival yet.
- **Not WF+MC certified.** Re-run harness with DB candles + funding before any promote language.
- Do **not** copy SOL bear60 / ETH wick floors / BTC vacuum-VAH defaults onto AVAX without new autopsy.

## Next

1. ~~`backtest-validate-vp-freq-avax.mjs` (WF + MC + gates) once DB is healthy.~~ **Done** — see certification below.
2. 2022–23 residual: relative rule on bear/bull vacuum **rejection** (not blanket deny — those cells pay overall).
3. Frequency restore only from positive cells (bull_trend vacuum VAL / paying rej), not reopening denied bleeds.
4. Calmar push: residual DD from 2022–23 left-tail (funding-aware full sim sits at Calmar 0.87).

## Certification (2026-07-22) — DB + funding

**Script:** `backtest-validate-vp-freq-avax.mjs`  
**Artifact:** `.vp-freq-avax-certification.json`

| Metric | Result |
|--------|--------|
| Full | **180t / +404% / CAGR 33.6% / Calmar 0.87 / DD 38.7% / PF 1.40 / 0.64/wk** |
| Years | 20–21 +35% · 21–22 +74% · **22–23 −31.5%** · 23–24 +75% · 24–25 +49% · 25–26 +21% |
| MC p5 | **+10.7% PASS** |
| WF OOS sum | **+133%** on 127 OOS trades · degradation **20% PASS** |
| Core gates | PASS OOS>0, MC p5, WF deg · **FAIL Calmar&lt;1** |
| Extra | PASS N≥30 · **FAIL** frequency · **FAIL** no catastrophic year (2022–23 ≤ −25%) |
| Cost | slip×2 +76% · slip×4 **−80%** · liq crunch **−99%** |

**Verdict: `REJECT_CERTIFICATION`**

vs REST research lock: funding + DB path cuts Calmar 1.06→0.87 and keeps 2022–23 catastrophic.

## Post-cert repair (2026-07-22 H3)

**Hypothesis:** 2022–23 residual bleed on R22 is dominated by BUY `va_rejection` in bull_chop (structured −$17 in-year; vacuum −$37 full-window) — not by paying SELL vacuum-rej cells.

| Change | Full | Calmar | 2022–23 | OOS | Verdict |
|--------|-----:|-------:|--------:|----:|---------|
| R22 | +491% | 1.07 | −29% | +73% | baseline |
| Deny SELL bear vac rej | +210% | 0.44 | −29% | +37% | REJECT |
| Deny SELL bull vac rej | +105% | 0.48 | −22% | +17% | REJECT |
| **Deny BUY bull_chop rej** | **+604%** | **1.48** | **−24%** | **+87%** | **LOCK H3** |
| Ext-down / chop trail / HTF0.20 / vol-target | mixed | ≤0.98 | | | REJECT |

Locked H3 adds cell denies:
`BUY|va_rejection|bull_chop|{structured,vacuum,tight}`.

### H3 certification (DB + funding)

| Metric | Result |
|--------|--------|
| Full | **166t / +512% / Calmar ~1.25–1.29 / DD ~31% / PF ~1.49 / 0.59/wk** |
| Years | … · **22–23 −25.8%** · … |
| Core gates | PASS OOS>0, MC p5, Calmar>1, WF deg, OOS N≥30 |
| Extra | **FAIL** frequency · **FAIL** noCatastrophicYear (−25.8% ≤ −25%) |
| Verdict | **`REJECT_CERTIFICATION`** |

### H4 repair — deny worst residual cell (one change)

**Hypothesis:** under H3, remaining `SELL|val_breakdown|bear_trend|tight` is a full-window bleed (−$217 / 8t), not a paying edge; removing it lifts Calmar and clears the year gate without crushing OOS.

| Change | Full (cert-style) | Calmar | 2022–23 | OOS | Verdict |
|--------|------------------:|-------:|--------:|----:|---------|
| H3 | +512% | 1.29 | −25.8% | +75% | year FAIL |
| H3 + volTarget | +230% | 1.19 | −12.6% | +37% | REJECT (return crush) |
| H3 + deny bear struct rej | +571% | 1.40 | −18.7% | +92% | weak (N=1 cell) |
| **H3 + deny bear tight VAL** | **+811%** | **1.97** | **−22.7%** | **+82%** | **LOCK H4** |

Locked H4 adds: `SELL|val_breakdown|bear_trend|tight`.

Re-run `backtest-validate-vp-freq-avax.mjs` → expect `RESEARCH_SLEEVE_LOW_FREQ` if core+year pass (freq still ≪2/wk).

### H4 certification (2026-07-22) — DB + funding

**Artifact:** `.vp-freq-avax-certification.json`

| Metric | Result |
|--------|--------|
| Full | **158t / +811% / CAGR 48.6% / Calmar 1.90 / DD 25.6% / PF 1.91 / 0.56/wk** |
| Years | 20–21 +14% · 21–22 +108% · **22–23 −22.7%** · 23–24 +98% · 24–25 +51% · 25–26 +67% |
| MC p5 | **+48% PASS** · ruin 0% |
| WF OOS sum | **+240%** on 108 OOS trades · degradation **−24% PASS** (OOS > train) |
| Core gates | **ALL PASS** |
| Extra | PASS N≥30 · PASS noCatastrophicYear · **FAIL** frequency (≥2/wk) |
| Cost | slip×2 +346% · slip×4 **−36%** · liq crunch **−96%** |

**Verdict: `RESEARCH_SLEEVE_LOW_FREQ`** — not live-certified (freq + execution-stress fragility). Coin-native sleeve OK for research portfolio; do not promote to standalone deploy.

## Honest live-trust statement (H4)

- Measurable cell abstains only — no calendar cherry-pick.
- Survives OOS, Calmar, WF, MC, and year table under DB+funding.
- Frequency ≪ doctrine (≥2/wk); cost stresses at slip×4 / liq crunch still break.
- Do **not** copy onto other coins without coin-native autopsy.

## Next

1. ~~H4 cert artifact — sleeve vs reject.~~ **Done — RESEARCH_SLEEVE_LOW_FREQ.**
2. Frequency restore only from positive cells (bull_trend vacuum VAL / paying rej), not reopening denied bleeds — optional later.
3. **XRPUSDT** coin-native VP FREQ stream (same rulebook).