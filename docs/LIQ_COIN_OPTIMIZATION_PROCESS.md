# LIQ coin optimization process

> Companion to `docs/LIQ_CORE_PLAYBOOK.md` and the reference liquidity-sweep guide.
> Use this when tuning **one coin** (e.g. BNB) without stacking every filter at once.

## Audit verdict (vs reference guide)

| Guide layer | Our status | Action |
|-------------|------------|--------|
| Named pools (PDH/PDL, session) | **PRESENT** (CORE) | Keep |
| Fractal swing lookback N | **ADDED** `swing_pivot` mode | Opt-in via `intradayLiqLevels` |
| Pierce + close back | **PRESENT** | Keep; same-bar via `RequireSameBarReclaim` |
| Wick/body ≥ 1.5 | **ADDED** `intradayLiqMinSweepWickBodyRatio` | Opt-in; do not default-on |
| Volume ×1.5 / w20 | **PRESENT** | Proven on BNB AST sleeve |
| HTF EMA bias | **PARTIAL** (21/50 soft) | Opt-in; prior CORE A/B **REJECT** at high N |
| Active session | Narratives / killzone / UTC hours | Coin-native; fix live parity (done) |
| Follow-through 0.5 ATR / 1–2 bars | **ADDED** `RequireFollowThrough` | Opt-in |
| SL beyond wick + ATR buffer | **ADDED** `SlBufferAtrMult` | Opt-in; % buffer remains default |
| Risk% sizing | **PRESENT** (`RISK_AT_SL`) | Keep |
| RiskGuard daily / consec | **PRESENT** (runner + overlay) | Enable on research sleeves |
| Fees + slippage | **PRESENT** | Always on; no separate spread line |
| Live ≡ backtest (LIQ solo) | **FIXED** — live uses `selectIntradayPicks` | Mandatory |

**Do not** turn the full guide stack on CORE by default. Stacking wick + HTF + killzone + displacement crushed frequency without durable OOS edge on BNB CORE. Promote one gate at a time after autopsy.

---

## Coin optimization steps (ordered)

### 0. Baseline
1. Start from `INTRADAY_PRO_LIQ_CORE_15M` (X4 + T1 + P1 + X5).
2. Full `runSimulation` on coin, ≥18–36 months, fees + slippage.
3. Store every trade + `liqContext.features`.

### 1. Autopsy (failure mode first)
Cluster losers by: `never_green` / `FAST_FAIL`, level type, session narrative, vol spike, ADX, SL%, day situation, month.
Name **one** recurring failure (e.g. “weak-volume Asia PDH fades in 2026”).

### 2. One-change matrix (guide-aligned knobs)

Tune **one** key per experiment. Soft-oracle on completed trades first; hard gate only if soft lifts holdout.

| Param | Typical band | What it answers |
|-------|--------------|-----------------|
| `intradayLiqSweepMinVolRatio` | 1.0 → 1.2 → **1.5** → 1.8 | Real liquidity grab vs quiet wick |
| `intradayLiqSweepVolLookback` | 10–30 (default 20) | Vol baseline stability |
| `intradayLiqRequireSameBarReclaim` | off / on | Pin rejection vs multi-bar reclaim |
| `intradayLiqMinSweepWickBodyRatio` | 1.0 → **1.5** → 2.0 | Guide wick/body rejection |
| `intradayLiqMinSweepPokeWickRatio` | 0.3–0.6 | Wick/range (our older metric) |
| `intradayLiqSessionNarratives` | asia / london / ny | Session SNR |
| `srIntradaySessionStartHour/End` | match narratives | Outer UTC window |
| `intradayLiqRequireKillzone` | off / on | SMC killzone only |
| `intradayLiqDaySituationBias` | off / on | No fade into breakout day |
| `intradayLiqRequirePremiumDiscountAlign` | off / on | Loc vs day range |
| `intradayLiqMaxSlPct` | 0.006–0.012 | Cap wide wick risk |
| `intradayLiqSlBufferAtrMult` | 0 → **0.2** | Guide ATR stop pad |
| `intradayLiqSlBufferPct` | 0.001–0.002 | % pad (CORE default 0.0015) |
| `intradayLiqRequireFollowThrough` + `FollowThroughAtrMult` | 0.4–0.8 / 1–3 bars | Guide displacement-before-trust |
| `intradayLiqRequireHtfAlign` (+ `HtfAlignPdhPdl`) | off / on | With-trend fades only |
| `intradayLiqLevels` | `daily` / `daily,session` / `+swing_pivot` | Pool set |
| `intradayLiqSwingPivotLookback` | 3–8 (default 5) | Fractal significance |
| `intradayLiqReclaimHoldBars` | 0–3 | Path confirm (P1=2 on CORE) |
| `intradayLiqMaxTpRr` | 1.5–3 | Payoff vs hold time |
| `riskPerTrade` | 0.5–2.5% | Size (not edge) |
| `maxDailyLoss` / `riskConsecutiveLossLimit` | 2–5% / 2–4 | Circuit breaker |

### 3. Windows (honest)
Compare **same costs** on: latest calendar year, prior year, last 12m holdout, full multi-year.
Reject calendar cherry-picks. Half-year bleed is a residual to name, not hide.

### 4. Promote rule
Promote a knob into a **coin research sleeve** only if:
- Holdout return improves (or holds ≥ baseline) **and** PF ≥ 1
- Frequency does not collapse below research floor without a restore plan
- Live path uses the same pick engine (LIQ solo → `selectIntradayPicks`)

Promote to **live** only after WF + MC + 4-gate harness (≥30 OOS trades).

### 5. BNB reference (current)
Sleeve: `INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M`  
Stack: Asia + same-bar + toxic + maxSl 0.8% + prem/disc + **vol≥1.5** + RiskGuard 3%/3  
Label: `RESEARCH_SLEEVE_LOW_FREQ` (~0.21/wk) — not CORE, not certified.

Next BNB one-changes (isolated): follow-through 0.5 ATR, wick/body 1.5, ATR SL buffer 0.2, `swing_pivot` levels — each vs AST_VOL15 baseline.

---

## Implementation map

| Guide idea | Config / function |
|------------|-------------------|
| Swing pivots | `intradayLiqLevels: "daily,swing_pivot"`, `intradayLiqSwingPivotLookback` → `liq/liquidityLevels.js` |
| Wick/body | `intradayLiqMinSweepWickBodyRatio` → `rejectionWickBodyRatio` |
| Volume | `intradayLiqSweepMinVolRatio` / `SweepVolLookback` |
| Follow-through | `intradayLiqRequireFollowThrough`, `FollowThroughAtrMult`, `FollowThroughBars` |
| ATR stop pad | `intradayLiqSlBufferAtrMult` → `computeLiquidityBrackets` |
| Live parity | `isLiqSoloStack` + `signal()` → `selectIntradayPicks` |
