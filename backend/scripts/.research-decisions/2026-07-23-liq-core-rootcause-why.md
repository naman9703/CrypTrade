# LIQ_CORE — root cause of bad results & optimum optimization path

Date: 2026-07-23  
Window / coin: BNBUSDT 15m, 2025-01 → 2026-06 (CORE chronological; X4 = no TP1 partial)  
Artifacts: `.liq-core-autopsy.json`, `.liq-core-wl-tf-enhance.json`, `.liq-core-risk-layer-ab.json`  
Script (validate dead-trade): `research-liq-core-rootcause-deadtrade.mjs`

---

## The WHY (setup optimization)

Bad results are **not** primarily from “trading the wrong hours / HTF / premium-discount.”
They are from **post-entry path economics** of classical fade after a named-pool reclaim.

### 1. Dollar attribution (BNB CORE harvest, n=539)

| Bucket | n | PnL $ | Role |
|--------|---|-------|------|
| **SL exits** | 272 | **−201** | Dominates the curve |
| Winners (all) | 139 | +66 | Too small vs SL mass |
| tp2 | 45 | +33 | Only strong structural wins |
| time_stop | 129 | +24 | Long-hold cohort helps |
| `never_green` | 111 | **−75** | Reclaim never goes green |
| `sl_no_follow` | 132 | **−90** | MFE &lt; 0.5% then full SL |
| Instant-death sum | 243 | **≈ −165** | **~78% of all loss dollars** |
| Toxic day fades | 183 | −49 | Real but **secondary** |
| Bars 0–4 | 113 | −76 | Early death |
| Bars 33+ | 177 | **+11** | Only positive hold bucket |

### 2. Payoff math (why WR looks “ok” but equity dies)

- Avg win ≈ **+$0.47**, avg loss ≈ **−$0.53** (before X4; asymmetry worse with early partials).
- At that payoff you need **~50–60% WR** to break even; actual WR ≈ **26%**.
- Winners that work look like **true stop-runs**: MFE ~1.9%, hold ~38 bars.
- Losers look like **false reclaim / continuation through the pool**: MFE ~0.55%, often dead by bar 4.

### 3. Why entry/liquidity filters fail as “optimization”

Tested hard/soft gates (HTF, killzone, toxic-day, prem/disc, maxSl, minExt, same-bar reject, displacement, first-cycle, score/V2):

- They **reduce N** (sometimes a lot).
- They **do not** create PF≥1 at deployable frequency.
- Soft “keep better buckets” still leaves **aggregate PnL negative**.

**Conclusion:** the failure mode is largely **not observable as a stable entry label**. Predicting “this reclaim will never green” at signal time with session/HTF/loc is weak on this data. Filters that only abstain are **frequency taxes**, not edge.

### 4. What *does* improve results (evidence)

| Change | Effect | Why it matches the autopsy |
|--------|--------|----------------------------|
| **X4 — no early TP1 partial** | PF 0.31 → **0.50**, freq intact | Winners need **full size** for 33+ bar MFE; partials amputate the only paying cohort |
| **15m entry TF** | Best freq×PF among 5m/15m/1h | 5m noise; 1h lower N / still negative |
| Counterfactual: compress/zero instant-death losses | Upper bound PF can flip **>1** if instant cohort is neutralized without killing winners | Points to **exit/risk path**, not entry veto |

### 5. Optimum solution (hypothesis → implement)

**Named failure mode:** *False-reclaim / no-follow path takes full 1R while true stop-runs need time + full size.*

**Optimum fix (liquidity-concept aligned, not an entry pile):**

1. Keep CORE entries (named pool + sweep + reclaim + chronological) — do not throttle N for “quality.”
2. Keep X4 (full size to TP2 / SL).
3. **Dead-trade risk compression:** after N bars, if MFE &lt; `minMfeR`, move SL from full structural risk to `maxLossR` · initial risk. Same idea already proven useful on `LIQUIDITY_MAP`.

This is a **Layer-4 risk** enhance: same setups, smaller loss when the auction refuses to displace away from the pool.

Engine: `runner.js` / `_headReplay/runner.js` now apply dead-trade for `SR_INTRADAY` / `INTRADAY_PRO` when `intradayLiqDeadTrade*` (or `liqMapDeadTrade*`) are set.

**A/B completed 2026-07-23 — DEAD-TRADE REJECT on CORE.**  
See `2026-07-23-liq-core-deadtrade-reject.md`. Early bar×MFE compression clips slow true stop-runs (winner $ 97→76). Refined longer waits ≈ noise. **T1 `maxTpRr=2`** mild promote (PF 0.50→0.53).

**Follow-up 2026-07-23 — path-confirm P1 promote.**  
`reclaimHoldBars=2` → PF 0.53→0.60 @ 6.4/wk. Oracle skip-instant → PF **2.54** / +69% (latent edge). Multi-coin still EDGE FAIL. Next = **LIQ_ACCEPT** playbook.  
See `2026-07-23-liq-core-next-after-deadtrade.md`.

### 6. Secondary research (after dead-trade)

- ~~Closer structural TP (`maxTpRr` 1.5–2)~~ **Done** — T1 wired on CORE.
- ~~Path-confirm hold2~~ **Done** — P1 wired.
- **LIQ_ACCEPT** — sweep hold-beyond continuation (not naive day-router).

---

## Verdict

**Root cause:** payoff asymmetry driven by **instant no-follow SL**, not “missing” HTF/session confirmations.  
**Optimum optimization attempted:** dead-trade — **rejected**; path-confirm hold2 — **mild promote**. Best CORE stack = **X4 + T1 + P1** (PF ~0.60).  
**Status:** still **EDGE FAIL**. Do not stack entry/liquidity gates that only cut N. Next stream = LIQ_ACCEPT.
