# 2026-07-15 — ETH VP FREQ yearly inconsistency (2023–24 autopsy)

**Run:** `380cf902-e467-4024-8515-9ef78b42d7c1`  
**Window:** 2023-06-01 → 2026-05-31 · ETHUSDT 15m · `vpPlaybook=FREQ` · RISK_AT_SL  
**Headline:** 237 trades · **+95.1%** · **DD 41.2%**

## Verdict

Yearly inconsistency is **not random noise**. **Jun 2023 – May 2024** is a **regime failure on shorts**:
local VAL breakdown / VA rejection shorts against a bullish ETH grind. Soft HTF (`vpMinHtfSepPct=0.15%`)
did not prevent counter-trend SELLs. Same `vp_val_breakdown` is **strongly positive in 2025–26** —
do **not** delete the setup; gate it by HTF / regime.

## Year PnL (shared $100 equity)

| Year (Jun–May) | N | WR | Net $ | Equity | Year ret | Intra DD |
|---|---:|---:|---:|---|---:|---:|
| 2023–24 | 64 | 28.1% | **−32.60** | 100→67 | −32.6% | **41.2%** (= full-run max DD) |
| 2024–25 | 95 | 35.8% | +19.65 | 67→87 | +29.2% | 34.5% |
| 2025–26 | 78 | 46.2% | +108.02 | 87→195 | +124% | 22.0% |

## 2023–24 failure mode

- **SELL 39 / 17.9% WR / −$45** vs **BUY 25 / 44% WR / +$12**
- Worst setup: **`vp_val_breakdown` shorts** 32t · 22% WR · **−$23.30**
- Also bleed: SELL `va_rejection` 4t **0% WR −$12**; SELL `poc_bounce` 3t **0% WR −$9**
- Loss patterns: FAST_FAIL 13 (−$31), INSTANT_SL 10 (−$28), WHIPSAW 10 (−$23)
- NY session: 28t −$24 (mostly shorts)
- Loser avg MFE only +0.51% before SL; winner avg MFE +2.61%
- Max loser streak: **10**

Counterfactual: **BUY-only** on 2023–24 → **+$12.45**.

## Contrast (why not “delete val_breakdown”)

| Year | val_breakdown N | WR | Net |
|---|---:|---:|---:|
| 2023–24 | 32 | 22% | −23 |
| 2024–25 | 40 | 30% | −17 |
| 2025–26 | 39 | 51% | **+101** |

## Config that enabled the bleed

- Open ETH FREQ funnel (all setups)
- `vpRequireHtfAlign=true` but **`vpMinHtfSepPct=0.0015` (0.15%)** — too weak for SELL filter
- Structure brackets on; trail off; fixed TP on (VP structure TP)

## Next experiments (one change each)

1. **H1** — Asymmetric HTF: higher sep required for SELL than BUY  
2. **H2** — Block SELL when HTF trend sign is up  
3. **H3** — Drop SELL-only `va_rejection` / `poc_bounce` (small N, bad in yr1)  
4. **H4** — Reclaim / hold-beyond-VAL confirmation before short entry  

Do **not** promote on full-window +95% while yr1 DD = 41% from counter-trend shorts.
