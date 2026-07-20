# 2026-07-16 — ETH VP FREQ regime-adaptive lock (22–23 / 23–24 dependency fix)

**Mandate:** Find what the setup depends on in bad years; adapt behaviour (not N-crush)
until 22–23 and 23–24 approach 25–26 quality.

**Data:** `research-vp-freq-bad-years-deep.mjs` → `.vp-freq-bad-years-deep.json`  
**A/B:** `backtest-vp-freq-eth-adaptive-stack.mjs` → `.vp-freq-eth-adaptive-stack.json`

## Market dependencies (measured)

| Year | Regime | What bleeds | What works |
|------|--------|-------------|------------|
| **2022–23** | Bear + violent squeezes | BUY `vah_breakout` vacuum path (≥2%); SELL `va_rejection` into extended down | SELL `val_breakdown` |
| **2023–24** | Bull grind | SELL `val_breakdown` on shallow HTF (0.3–0.5%) in non-bear macro | BUY VAH in mild prior5d |
| **2025–26** | Clean bear continuation | BUY `vah_breakout` vacuum (same pathology) | SELL `val_breakdown` (+$104) |

**Universal:** VAH path 1–2% (structured) wins all years; path ≥2% (vacuum) loses in bear/chop.
**Year-specific:** `prior5d` chase filter is wrong lever (helps one year, hurts another).

## Three adaptive rules (one hypothesis each, then combined)

| Rule | Condition | Behaviour | 22–23 | 23–24 | 25–26 |
|------|-----------|-----------|------:|------:|------:|
| **A** Vacuum cap | `path>2%` AND `prior60d≤5%` (non-bull) | Skip VAH breakout | −2.8% | −0.9% | +118% |
| **B** Rej block | SELL `va_rejection` AND `prior20d≤−5%` | Skip bounce shorts | **+13.0%** | +4.2% | +127% |
| **C** Non-bear VAL HTF | `prior60d>−5%` → min HTF 0.5% | Harder shorts in chop/bull | −4.2% | **+10.7%** | +127% |
| **ABC combined** | All three | — | **+8.5%** | **+5.3%** | **+124%** |

Full window: **259t +184% DD48%** → **204t +250% DD35%** (prior wick-only vs combined).

## Locked in `VOLUME_PROFILE_FREQ_ETH_15M`

```text
vpBuyBreakoutMaxPathPct: 0.02
vpBuyBreakoutMaxPathNonBullOnly: true
vpBuyVacuumBullPriorPct: 0.05
vpRejectionSellBlockExtendedDown: true
vpRejectionExtendedPriorPct: 0.05
vpSellNonBearMinHtfSepPct: 0.005
vpSellBearPrior60dPct: -0.05
```

(Plus existing: macro-adapt SELL HTF, chop SELL MFE trail, rejection wick 0.35.)

## Verdict

**LOCK ABC** — first stack that turns 22–23 positive (+8.5% vs −1.5%) and lifts 23–24 (+5.3%)
without crushing 25–26 (+124% vs +127%). Not WF+MC certified.

**Not parity with 25–26** — gap is structural (2025 = sustained bear + VAL follow-through;
22–23 = squeeze VAH noise; 23–24 = bull grind). Remaining bleed post-lock:

- 22–23: BUY `vah_breakout` still −$16 (12 vacuum trades where brief prior60d>5% in squeeze)
- 23–24: SELL `val_breakdown` still −$1.6; VAH prior5d>8% chase −$10

## Next ONE change (if continuing)

**VAH chase guard in non-bull only** (`vpBuyChaseFilter` + `prior5d>8%` when `prior60d≤5%`) —
targets 22–23 relief-rally false breaks without blocking 25–26 washout longs. Isolate + full sim.

## Status

Research checkpoint — iterate until WF+MC gates pass; do not cite as deployable.
