# 2026-07-18 — ETH relative adaptive lock: extending residual-bull VAL

## Principle

2021–22 **can** be optimized — not as a year, but as **relative market physics**.
Same `val_breakdown` setup; behaviour changes when conditions say the auction
is still *extending* a residual bull (blow-off residue) vs a brief squeeze inside
a prepared path.

Bear60-only was rejected (crushed lock +638%→+288%). This rule is a **subtype**.

## Why trades failed in 2021–22 (relative)

VAL losers vs 2025–26 VAL winners (H1+H2 baseline):

| Feature | 21–22 losers | 25–26 winners | Read |
|---------|-------------:|--------------:|------|
| prior60d | +3% | −4% | more residual bull |
| prior20d | −2% | −8% | less washed |
| **prior20/prior60 (ext)** | **0.89** | **0.52** | 20d still extending 60d bull |
| prior120d | +20% | −13% | sustained cycle bull vs bear |
| MFE | 0.8% | 3.3% | no follow-through |

## Adaptive rule (H3)

```text
if SELL val_breakdown
   AND prior60d > +5%          // residual / elevated 60d bull
   AND prior20d / prior60d > 0.6  // 20d still extending that bull
→ ABSTAIN
```

Outside bull60 → **no-op** (clean bear VAL untouched).  
Inside bull60 with mean-reverting / weak 20d vs 60d → still tradeable (squeeze path).

## Full-sim A/B (on H1+H2)

| Variant | Lock 22–26 | 2021–22 | 22–23 | 23–24 | 25–26 |
|---------|-----------:|--------:|------:|------:|------:|
| H1+H2 | 154t / +637.9% | −20.5% | +32.5% | +56.4% | +169.6% |
| extend ratio 0.5 | 148t / +645.5% | −13.4% | +45.4% | +47.6% | +155.4% |
| **extend ratio 0.6 (LOCK)** | **149t / +689.8%** | **−13.4%** | **+45.4%** | **+56.4%** | **+155.4%** |

Lock **improved**. 2021–22 improved. No trained year collapsed.

## Live / OOS robustness

- Prepared (clean bear VAL, structured VAH, non-extending bull60 vacuum, …) → trade  
- Known bleed subtypes (dump-into-bull, non-vac bull60, **extending residual bull**) → abstain  
- Unknown cells → continue matrix / novelty work; do not blanket-kill prepared edge  

## Residual

2021–22 still ~−13%. Next relative autopsy on remaining losers (weak_bear vacuum,
BUY rej geometry, prior120d cycle) — one change at a time, same lock-preservation gate.

## Status

Locked in `VOLUME_PROFILE_FREQ_ETH_15M`. Not WF+MC certified.
