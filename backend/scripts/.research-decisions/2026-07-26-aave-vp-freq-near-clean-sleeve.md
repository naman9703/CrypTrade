# 2026-07-26 — AAVE VP FREQ: near-clean research sleeve

## Verdict

**NEAR-CLEAN research sleeve** — not strict year-clean; not deploy-certified.

Locked stack (coin-native):
- F3 `va_rejection` only
- HTF align + `vpMinHtfSepPct: 0.0035`
- `vpRejectionSellBlockExtendedDown` (prior20 ≤ −5%)
- Deny bleed cells: weak_bear/bear_trend/bull_chop vacuum SELLs + BUY bull_chop vacuum/structured
- score 7 / gap 2 / maxDay 2

FULL (research sim): **n=30 · tw 0.11 · +129.6% · Calmar 1.78 · PF 2.22**
Years: all ≥0 except **2023–24 −0.34%** and **2025–26 −2.94%** (no catastrophic year).

Do **not** call this live-ready until WF+MC+gates pass under this locked exit model.
Frequency fails the ≥2/wk mandate — same class as DOGE/NEAR sleeves.

## Path (evidence)

| Round | Finding |
|-------|---------|
| Phase 0 | F3 HTF0.15: OOS +46% / FULL +2.8% / 4 red years |
| R1 levers | No single lever year-cleaned; HTF/ATR shrink residual reds |
| Soft vacuum | Misleading — hard deny-all-vacuum destroys book (n=19 −20%) |
| R2 cells | `sellExt+bleed` → +163% / Cal 0.89 / only −8.9% / −8.0% reds |
| R3 residual | Denying SELL bull_trend vacuum swaps reds onto good years |
| Lock pick | **HTF 0.35% on sellExt+bleed** — best Calmar; near-flat residual reds |

## Rejected / do not retest without new evidence

- Deny-all-vacuum / deny SELL bull_trend vacuum (kills paying good-year vacuum)
- HTF ≥0.40% on this lock (re-reds 2024–25)
- Ultra-thin “clean” stacks (htf50+denyVac n=1) — rulebook N crush
- Copying DOGE ATR/body or NEAR sep 0.45 wholesale

## Live reliability stance

1. Preset `VOLUME_PROFILE_FREQ_AAVE_15M` is a **research checkpoint only**.
2. Certification (2026-07-26): **`REJECT_CERTIFICATION`** — WF degradation 70%,
   OOS n=13. See `2026-07-26-aave-vp-freq-certification-reject.md`.
3. Do **not** paper-size or live-size. Unlike DOGE/NEAR, AAVE failed stability
   gates (not only frequency).
4. Reopen only with a hypothesis that raises OOS N and cuts WF degradation.

## Artifacts

- `research-vp-freq-aave-f3-midyear-autopsy.mjs`
- `research-vp-freq-aave-f3-cell-clean.mjs`
- `research-vp-freq-aave-f3-residual-clean.mjs`
- `backtest-validate-vp-freq-aave.mjs`
- Preset: backend + frontend `VOLUME_PROFILE_FREQ_AAVE_15M`
