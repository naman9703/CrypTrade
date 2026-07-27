# 2026-07-26 — AAVE VP FREQ certification

## Verdict

**`REJECT_CERTIFICATION`** — not a research sleeve, not live-eligible.

Core Calmar/MC/OOS return pass, but **WF degradation FAIL** (69.9% > 35%) and
**OOS trades FAIL** (13 < 30). Frequency also FAIL (0.11/wk).

Do **not** paper-size or promote. Preset remains a research checkpoint only.

## Window / stack

- Symbol: AAVEUSDT 15m futures
- Window: 2021-01-01 → 2026-05-31
- Preset: `VOLUME_PROFILE_FREQ_AAVE_15M`
  (F3 rej, HTF 0.35%, sellExtDown, bleed-cell deny)

## Full-window

| Metric | Value |
|--------|-------|
| Trades | 30 (0.11/wk) |
| Return | +129.6% |
| CAGR | 16.1% |
| Calmar | 1.40 |
| Max DD | 11.5% |
| PF | 2.22 |
| Years | residual reds −0.3% / −2.9% (no catastrophic year) |

## Gates

| Gate | Result |
|------|--------|
| OOS return > 0 | **PASS** (WF OOS sum +37.9%) |
| MC p5 > 0 | **PASS** (+3.1%) |
| Calmar > 1 | **PASS** (1.40) |
| WF degradation < 35% | **FAIL** (69.9%) |
| OOS trades ≥ 30 | **FAIL** (13) |
| No year ≤ −25% | **PASS** |
| Frequency ≥ 2/wk | **FAIL** (0.11) |

## Cost stress

| Variant | Ret |
|---------|-----|
| slip×2 | +99% |
| slip×4 | +66% |
| liq_crunch | +0.7% (fragile) |

## Root cause

This was **not** primarily an expectancy-sign failure. The failure mode was
**walk-forward instability from N-crush / trade concentration**:

- Locked reject stack (`HTF 0.35%` + sellExt + bleed-cell deny) kept only **30**
  trades total and **13 OOS WF trades**
- Trade distribution was front-loaded: roughly **57%** of all trades came from
  `2020-21` + `2021-22`
- WF folds became sparse/noisy (`2/4/2/5/0` test trades by fold), so train
  expectancy stayed high while test expectancy was dominated by a few trades
- Result: **WF degradation 69.9%** even though OOS return and MC p5 stayed > 0

So the FULL curve looked good because the lock overfit toward a small number of
early-period winners, not because the setup was fold-robust enough for live use.

## Repair attempts

We explicitly tried to fix the *actual* failure mode by restoring OOS N and
reducing early-year concentration, rather than tightening further:

- **Loosen HTF on sellExt+bleed**
  - `htf20_sellExt_bleed`: `n=44`, `oosN=27`, `wfDeg=44.1%`, only `2025-26` red
  - `htf25/30_sellExt_bleed`: higher Calmar, but OOS N fell further
- **Restore blocked bear-vacuum SELLs**
  - `htf20_no_bearVac`: **best honest repair**
  - `n=46`, `FULL +221%`, `Calmar 1.48`, **year-clean**, `oosN=27`,
    `wfDeg=44.1%`, `mcP5=+12.8%`
- **Add `poc_bounce` for more N**
  - OOS N improved (`45–56`) but MC p5 turned negative / Calmar fell below 1 /
    red years reopened
- **Cut early 2020-21 blow-off BUYs**
  - `prior60` caps or denying BUY bull-vacuum lowered train expectancy, but then
    Calmar and/or MC p5 broke before WF degradation got under 35%

Net: there was **no single repair path** that simultaneously achieved:

1. `WF degradation < 35%`
2. `OOS trades >= 30`
3. `Calmar > 1`
4. `MC p5 > 0`
5. acceptable year stability

## Why not RESEARCH_SLEEVE

DOGE/NEAR sleeves passed WF + OOS≥30 with only frequency failing. AAVE still
fails **stability gates** after targeted repair:

- best year-clean repair: `htf20_no_bearVac` → `oosN=27`, `wfDeg=44.1%`
- best high-N repair: `htf20_bleed_poc` → `oosN=45`, but `wfDeg=82.9%`,
  `Calmar 0.76`, `MC p5 < 0`

That means AAVE is not merely low-frequency; it is **not validation-stable**.

## Artifact

- `backtest-validate-vp-freq-aave.mjs`
- `.vp-freq-aave-certification.json`
- Prior: `2026-07-26-aave-vp-freq-near-clean-sleeve.md`

## Next

1. Archive current AAVE VP FREQ stack as **cert reject**.
2. Reopen only with a **new causal hypothesis** that specifically targets fold
   stability / OOS N, not more HTF crushing or more cell denies.
3. UI button may remain as research preset — label should not imply cert.
