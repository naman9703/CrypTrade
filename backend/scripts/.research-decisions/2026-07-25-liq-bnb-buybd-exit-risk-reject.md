# 2026-07-25 — LIQ BNB BUYBD exit/risk economics (Calmar / MC p5)

**Status:** `REJECT` — no exit or risk-overlay change lifts FULL Calmar above ~0.7 or flips MC p5 > 0 on the BUYBD+comp≥0.75 sleeve.
**Baseline:** `INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M` (compression 0.75), guards off for expectancy.
**Prior sleeve:** `2026-07-25-liq-bnb-buybd-compression-standdown.md` (ACCEPT_RESEARCH_SLEEVE, gates FAIL).

## Hypothesis

Validation blockers were Calmar 0.69 (DD 25.6%) and MC p5 −6.7%. Autopsy of residual trades:

| Exit       | W n | L n | L sumR |
|------------|-----|-----|--------|
| sl         | 0   | 115 | **−127** |
| time_stop  | 64  | 54  | −19.6  |
| tp         | 90  | 0   | 0      |

Dominant loss $ = **full SL with near-zero MFE** (never-green). Cannot be exit-saved.
Secondary = time_stop losers at max hold 48. Soft streak-drop looked strong but was
**look-ahead on loss outcome** (invalid causal estimate).

## Experiments (one family at a time, hard A/B)

### 1. Risk guards (engine, causal) — REJECT

Script: `research-liq-buybd-risk-guard-ab.mjs` → `.liq-buybd-risk-guard-ab.json`

| Variant | HOLD ret | OOS ret | FULL calmar | Notes |
|---------|----------|---------|-------------|-------|
| baseline | +5.3% | +46% | **0.69** | — |
| consec3 | **−1.6%** | +55% | 0.66 | Rest-of-day cooldown; hurts HOLD |
| daily3% | +5.3% | +46% | 0.69 | No effect at 2.5% risk/trade |
| both | −1.6% | +55% | 0.66 | Same as consec3 |

### 2. DD kill-switch / weekly cap — REJECT

Script: `research-liq-buybd-dd-guard-ab.mjs` → `.liq-buybd-dd-guard-ab.json`

| Variant | FULL ret | FULL calmar | Notes |
|---------|----------|-------------|-------|
| kill12/15/18 | crush N / red | ≤0.03 | Stays blocked while underwater |
| week5 | +42% | 0.46 | Worse |
| week8 | +66% | 0.70 | ≈ baseline, no lift |

Soft size-down while DD>10–15% also **worsened** Calmar (cuts recovery trades).

### 3. Exit BE@MFE / maxHold / chopTrail — REJECT

Script: `research-liq-buybd-exit-be-hold-ab.mjs` → `.liq-buybd-exit-be-hold-ab.json`

| Variant | FULL ret | FULL calmar | Notes |
|---------|----------|-------------|-------|
| beMfe 0.5–1.0% | −19%…−63% | negative | Clips runners (238 BE exits @ 0.5%) |
| hold32 / hold40 | +29% / +49% | 0.25 / 0.45 | Worse than baseline |
| chopTrail | +39% | 0.35 | Worse |

**Best = baseline.** No preset change.

## Diagnosis (plain terms)

The sleeve’s edge is real (OOS +46%, no red half) but **path drawdown is structural**:
clusters of never-green SL hits. Risk overlays that pause or shrink size while
underwater also shrink the recovery that rebuilds equity. Early BE / shorter hold
converts would-be runners into scratch/loss and destroys expectancy.

Calmar > 1 / MC p5 > 0 will require **higher expectancy** (fewer never-green SLs
or larger winners), not tighter risk/exit on the same trade set.

## Next (do not re-test)

Banned without new evidence:
- consec rest-of-day, maxDailyLoss, kill-switch, weekly cap on this sleeve
- BE@MFE, shorter maxHold, chop MFE trail on this sleeve
- Soft streak-drop as causal (look-ahead)

Allowed next single mechanisms:
1. **Residual never-green SL autopsy** with causal *entry-time* features only (new
   separator beyond compression) — one hard A/B if found.
2. **Multi-coin** check of BUYBD+comp (ETH/BTC) before any promote language.
3. Accept research-sleeve status; paper at reduced risk if user wants live feel
   without claiming gates PASS.
