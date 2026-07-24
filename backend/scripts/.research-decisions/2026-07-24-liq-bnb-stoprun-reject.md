# BNB LIQ_BNB_STOPRUN probe — REJECT (2026-07-24)

Coin: **BNBUSDT** 15m. Base: `INTRADAY_PRO_LIQ_ACCEPT_BNB_15M` (hold-beyond continuation).  
Artifacts: `.liq-bnb-stoprun-ab.json`, `.liq-bnb-stoprun-follow-ab.json`.

## Hypothesis

Classical fade CORE and ACCEPT H0 are EDGE FAIL. Rebuild continuation as **STOPRUN**: weekly+PDH pools, with-trend HTF, displacement follow-through — Y25→H12 first, keep tw≥2.

## Hard A/B (ACCEPT + isolated / combo knobs)

| Variant | Y25 PF/ret | H12 ret | FULL PF/ret | tw | Note |
|---------|------------|---------|-------------|----|------|
| ACCEPT_H0 | 0.44 / −1.7 | −0.2 | 0.51 / −100 | 6.6 | prior REJECT |
| SR_weekly | 0.49 / −2.8 | −0.6 | 0.57 / −100 | 6.0 | |
| SR_weekly_asian | 0.41 / −0.6 | −0.05 | 0.54 / −100 | 8.5 | N spam |
| SR_htf | 0.48 / −5.0 | −1.0 | 0.61 / −100 | 6.2 | |
| SR_vol15 | 0.52 / −2.2 | −0.5 | 0.48 / −100 | 6.1 | |
| SR_weekly_htf | 0.55 / −5.1 | −1.5 | 0.66 / −100 | 5.7 | best FULL PF; still ruin |
| SR_weekly_htf_vol15 | 0.58 / −6.2 | −2.0 | 0.64 / −100 | 5.3 | |
| SR_hold1_weekly_htf | 0.53 / −4.0 | −1.0 | 0.61 / −100 | 6.2 | |
| SR_follow / disp / veto_ct | ≡ H0 | — | — | — | **no-op** before wire |

## Follow-through wire (infra)

`passesGuideFollowThrough` was classic-only. Wired into `buildSetupFromAcceptanceCycle` (opt-in). Re-test:

| Variant | FULL PF/ret | tw | Verdict |
|---------|-------------|----|---------|
| SR_follow_wired (0.5 ATR / 2) | 0.49 / −100 | 6.6 | N≈H0 — almost all already pass |
| SR_follow_1.0 / 3 bars | 0.49 / −100 | 6.6 | no-op-ish |
| SR_wk_htf_follow ± vol | ≤0.65 / −100 | 5.3–5.7 | **REJECT** |

## Verdict

**REJECT** STOPRUN-as-ACCEPT-enhancement for BNB returns+freq. Frequency OK; edge never appears (FULL always account-ruin). Do **not** ship a STOPRUN preset. Follow-through on ACCEPT stays available as research opt-in (off by default).

## Next (honest fork)

1. Soft oracle on ACCEPT: if no MFE latent edge → continuation family is dead on BNB 15m (not just “missing HTF”).
2. If oracle still green → need a **new** path rule (not weekly/HTF/vol stacks).
3. Else: redefine LIQ for BNB (e.g. different TF, or true first-pierce stop-run with coin-native autopsy) — not more ACCEPT knobs.
