# BNB LIQ — MFE-survivor at-entry discriminator REJECT (2026-07-24)

Coin: **BNBUSDT**. Baseline: CORE X4+T1+P1+X5. Soft only.  
Artifact: `.liq-bnb-mfe-survivor-discriminator.json`.

## Hypothesis

Oracle keep `mfe≥0.5%` → FULL PF ~2.63 / +115% @ 3.9/wk.  
If any **at-entry** LIQ feature stably separates survivors from `never_green`/`sl_no_follow`, soft keep should clear Y24+Y25+H12 ret>0 and FULL PF≥1 at tw≥2 — then hard-gate that one feature.

## Soft contrast (survivors n=607 vs death n=427)

Largest lifts are weak / noisy: sweepAcceleration, timeInsideLiquidity, attemptCount, atrPct (~0.05–0.25 relative). No clean separable score.

## Soft keep results (causal features)

| Gate | FULL PF/ret | tw | Y25 | Clears? |
|------|-------------|----|-----|---------|
| keep_mfe05 **oracle** | **2.63 / +115** | 3.9 | +5.2 | look-ahead only |
| attemptCount≥2 | 0.82 / −27 | 4.2 | −3.1 | no |
| atrPct≥0.45% | 0.80 / −20 | 2.8 | −0.5 | no |
| hour 0–8 | 0.77 / −21 | 2.3 | −0.2 | no |
| bodyEff≥0.5 | 0.75 / −30 | 2.8 | −1.5 | no |
| volSpike≥1.5 | 0.73 / −52 | 4.6 | −2.2 | no |
| All other score/HTF/impulse/hour gates | ≤0.72 / red | ≥2 | red | no |

**No soft candidate** other than the MFE oracle clears PF≥1 + multi-window ret>0.

## Verdict

**REJECT** — instant no-follow is **not** stably labeled at entry with current LIQ feature vector (same conclusion as progress-confirm / hybrid archives). Do not hard-gate attemptCount/atrPct/hour from this soft pass.

## Next

**LIQ_BNB_STOPRUN** — new continuation family on weekly+PDH pools with with-trend / displacement (ACCEPT plumbing + isolated level/HTF/follow A/B). Not more CORE fade vetoes.
