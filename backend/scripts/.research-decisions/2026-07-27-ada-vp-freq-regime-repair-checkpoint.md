# 2026-07-27 — ADA VP FREQ deep autopsy + regime repair

## Context

Phase 0 at default HTF 0.15% showed **OOS mirage** (FULL −1.9% / OOS −59% / IS +57%).
User requested full trade autopsy + regime-specific parameter repair.

## Baseline loss autopsy (111 trades, F3 va_rejection, HTF 0.15%)

### Why trades lost (by regime cell)

| Failure mode | Evidence |
|--------------|----------|
| **SELL vacuum in chop/bear** | `SELL\|bull_chop\|vacuum` net −19.3 bad vs +23.2 good; `SELL\|bear_trend\|vacuum` concentrated losses in 2020-22 |
| **BUY weak_bear vacuum** | `BUY\|weak_bear\|vacuum` net −10.3 in bad years; blow-off BUYs into extended moves |
| **Low-ATR never-green SLs** | Soft `drop_neverGreen` → net +141 (harvest); full-sim `minAtr_008` → +91% |
| **HTF too loose (0.15%)** | Default lets marginal rejections through; tightening HTF is master lever |

Bad years (2020-21, 2021-22, 2022-23): 54 trades, net −49, WR 20%.  
Good years (2023-26): 57 trades, net +62, WR 33%.

### Feature discrimination (losers vs winners in bad years)

- Losers: lower prior60d, lower pathPct, lower htfSep, lower atr
- Winners in good years: higher prior60d, higher atr, stronger HTF separation

## Regime-specific repairs tested (one-change + stacks)

| Variant | FULL | OOS | IS | Calmar | Red years | n |
|---------|------|-----|-----|--------|-----------|---|
| baseline htf15 | −1.9% | **−59%** | +57% | −0.01 | 3 early | 111 |
| **htf35** | +124% | **+138%** | −15% | 0.54 | 3 mild | 56 |
| **htf40+atr008** | +94% | **+92%** | **+1.8%** | 0.61 | **2020-21 only (−7.9%)** | 39 |
| htf35+atr008 | +114% | +120% | −6% | 0.63 | 2020-21, 2021-22 | 43 |
| htf35+atr008+bleed | +64% | +51% | +13% | **0.97** | **2020-21 only (−4.3%)** | 27 |
| htf35+buyBody20 | +136% | +146% | −10% | 0.66 | 3 mild | 52 |

### Optimum stack (honest checkpoint, not certified)

**`htf40+atr008`** — best balance of OOS + both-window positive + fewest reds:

- `vpMinHtfSepPct: 0.004` — require stronger HTF trend separation
- `vpMinAtrPct: 0.008` — block low-vol never-green SL traps
- Keeps F3 va_rejection only (no calendar year rules)

**`htf35+atr008+bleed`** — best Calmar / lowest DD, thinnest:

- Above + deny cells: SELL/ BUY vacuum in bull_chop, bear_trend, weak_bear
- OOS +51% but only 13 OOS trades

## Root cause summary

ADA's Phase 0 failure was **not** "no edge" — it was **wrong default gates for this coin**:

1. HTF 0.15% is too loose → marginal rejections in chop/vacuum bleed hard **in-sample**
2. Low ATR entries → stop-outs before trade goes green
3. Vacuum rejection cells in bear/chop regimes → structural losers in 2020-22 bear/chop ADA

Tightening HTF to 0.35-0.40% **inverts** the OOS curve (+92 to +138% OOS vs −59% baseline).

## Verdict

**`RESEARCH_CHECKPOINT`** — reopen ADA; do **not** call deployable yet.

- Fixed OOS sign with coin-native HTF + minAtr (major progress)
- Still **not year-clean** (2020-21 sticky mild red on best stacks)
- Best Calmar stack has **OOS n=13** — below ≥30 cert bar
- Needs: HTF fine ladder on `htf40+atr008` lock, cert harness, freq restore

## Artifacts

- `research-vp-freq-ada-f3-midyear-autopsy.mjs`
- `research-vp-freq-ada-f3-residual-clean.mjs`
- `.vp-freq-ada-f3-midyear-autopsy.json`
- `.vp-freq-ada-f3-residual-clean.json`

## Next

1. HTF fine ladder 0.0038–0.0045 on `htf40+atr008` for year-clean
2. Target 2020-21 bleed without crushing OOS N
3. Run `backtest-validate-vp-freq-ada.mjs` if year-clean achieved
