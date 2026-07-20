# 2026-07-16 — BTC VP FREQ regime-adaptive lock

**Mandate:** BTC-native regime adaptation (not ETH long-side copy). Raise honest
multi-year return without year-hardcoding; do not “solve” via N≈0.

**Artifacts**
- Autopsy: `research-vp-freq-btc-bad-years-deep.mjs` → `.vp-freq-btc-bad-years-deep.json`
- A/B: `.vp-freq-btc-adaptive-stack.json`, `-r2.json`, `-r3.json`, `-r4.json`

## Baseline → locked

| | N | Full ret | 22–23 | 23–24 | 24–25 | 25–26 | DD |
|--|--:|--------:|------:|------:|------:|------:|---:|
| Baseline (HTF 0.15%) | 173 | **−72%** | −40 | −53 | −14 | +17 | 85% |
| **Locked GW + prior60d VAL** | **30** | **+49%** | **+5** | **+8** | **+12** | **+18** | **20%** |

All four Jun–May years ≥ 0. Sensitivity: prior60d floor −3% → +55% / 31t (also all ≥0);
locked **−5%** to match existing bear-floor ontology (less threshold fishing).

## BTC nature (measured)

- Short-biased; VAH longs banned (funnel 2026-07-15).
- Under tight HTF, **`va_rejection` carries**; raw `val_breakdown` still bleeds in grind.
- Chop SELL MFE trail **REJECTED** (full sim worse than baseline).
- ETH vacuum / buy-chase **N/A** (no VAH path).

## Locked rules (`VOLUME_PROFILE_FREQ_BTC_15M`)

```text
vpMinHtfSepPct: 0.005
vpSellMinHtfSepPct: 0.005
vpSellMacroAdapt: true
vpSellMacroBullMinHtfSepPct: 0.005
vpSellMacroPrior20dBullPct: 0.02
vpSellWeakBearMinHtfSepPct: 0.008
vpSellWeakBearPrior20dFloorPct: -0.1
vpValSellRequirePrior60dBear: true
vpValSellPrior60dBearPct: -0.05
```

Condition→behaviour:
1. Stronger 1h separation globally (quality).
2. Weak-bear / bull macro → still harder HTF via existing sell resolver.
3. VAL shorts only in **deep prior60d bear** (≤ −5%); va_rej still allowed in other regimes.

New code: `passesVpValSellMacroFilter` (`vpValSellBearOnly` optional; locked path uses
`vpValSellRequirePrior60dBear`).

## Rejected

| Change | Why |
|--------|-----|
| Chop SELL MFE trail | Full ret worse |
| Global HTF 0.4% | −43% |
| va_rej-only | +50% but N=5 (frequency crush / not deliverable) |
| Full `vpValSellBearOnly` (macroBull veto) | Fixes 23–24 but **regresses 22–23** |
| ETH wick / extended-down rej copy | Mixed / opposite sign on BTC |
| Looser funnel (no HTF, +VAH) | Prior funnel REJECT |

## Frequency honesty

~30 trades / ~4y ≈ **0.15/week** — below ≥2/wk target. Ceiling is structural on BTC 15m
after honesty filters; do not reopen with looser gates (already proven net-negative).
Next frequency path = different TF/playbook, not gate relaxation.

## Status

**Research LOCK** on preset — **not** WF+MC certified / not deployable claim.
Frontend mirror updated. Re-apply ★ BTC FREQ in UI (or rely on `fillVolumeProfileFreqDefaults`).
