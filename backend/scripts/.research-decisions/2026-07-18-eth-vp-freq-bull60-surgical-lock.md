# 2026-07-18 — ETH 2021–22: ETH-native surgical fix (not BTC copy)

## User correction

BTC prepared-regime allowlist/deny was the wrong tool. It crushed the locked ETH
research path the user already had:

| | Trades | Ret | DD |
|--|------:|----:|---:|
| User / restored ABC+vacuum-prior5d (2022–26) | ~164–166 | **~+483–485%** | **~25%** |
| BTC-style allowlist (wrong) | 194 | ~+313% | ~34% |

Doctrine stays “abstain unprepared physics” — but **ETH cells ≠ BTC cells**.

## Why 2021–22 was bad (ETH character)

On the **restored** baseline (not allowlist):

| Slice in 2021–22 | N | Net | Read |
|--|--:|----:|------|
| **SELL `val_breakdown`** | 35 | **−$18.4** | primary bleed |
| of which **prior60d > +5% (bull60)** | 18 | **−$15.9 / WR17%** | shorting VAL into 60d bull / top |
| BUY `vah_breakout` | 16 | +$5.2 | fine |
| BUY `va_rejection` | 4 | −$2.5 | secondary |

ETH in 2021–22 = blow-off then crash. VAL shorts into residual **bull60** got run.
That is **opposite** of BTC’s main bleed (vacuum VAL *in bear*).

## What does NOT work

| Idea | Lock 2022–26 | Why reject |
|------|-------------:|------------|
| BTC allowlist / deny-cell copy | crushed (~+313%) | wrong coin physics |
| Block **all** bull60 VAL | +485% → **+322%** | kills 2025–26 vacuum bull60 (+$33) |
| `vpValSellRequirePrior60dBear` alone | +485% → **+346%** | same — over-prunes |

## Surgical ETH rules (locked)

```text
vpValSellBlockBull60Dump: true
  → abstain SELL VAL when prior60d > +5% AND prior20d ≤ −5%
     (dump-into-bull dead-cat; multi-year −$26 on that slice)

vpValSellBlockBull60NonVac: true
  → abstain SELL VAL when prior60d > +5% AND path is non-vacuum
     (keeps vacuum bull60 = 2025–26 edge)
```

## Full-sim A/B

| Variant | Lock 22–26 | OOS 21–22 | Full 20–26 |
|---------|-----------:|----------:|-----------:|
| Restored baseline | 166t / **+484.8%** / DD24.8% | −32.4% | +178% / DD59% |
| Dump only | 160t / **+604.6%** / DD22.0% | −22.8% | +310% / DD48% |
| Non-vac only | 159t / +530.7% / DD23.3% | −30.3% | +238% / DD54% |
| **Dump + non-vac (LOCK)** | **154t / +637.9% / DD19.6%** | **−20.5%** | **+383% / DD42%** |

Lock window **improved** vs the user’s ~483% reference (more return, less DD, N still ≥150).
2021–22 improved but **still negative** — remaining bleed is outside this surgical slice
(other SELL VAL regimes / thin BUY rej). Next one-change must stay ETH-native and
must not regress the ~638% lock path.

## Status

- Restored + surgically improved ETH lock. **Not BTC copy.**
- Not WF+MC certified.
- Residual 2021–22 still open — continue ETH-native autopsy under this new baseline.
