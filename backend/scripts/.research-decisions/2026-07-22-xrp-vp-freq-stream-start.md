# 2026-07-22 — XRP VP FREQ coin-native stream

## Context

- After AVAX H4 → `RESEARCH_SLEEVE_LOW_FREQ`, next coin: **XRPUSDT**.
- Prior 1y coin-tune: uniform ETH-shaped **−37%** (VAH+VAL).
- Rulebook: coin-native only — **do not copy AVAX cells**.

## Phase 1 — funnel screen (DB + funding, 2021→2026-05)

**Script:** `backtest-vp-freq-xrp-optimize.mjs`  
**Artifact:** `.vp-freq-xrp-optimize.json`

| Funnel | Full | OOS | tw | Verdict |
|--------|-----:|----:|---:|---------|
| F0 open | −99% | −95% | 2.93 | REJECT |
| F1 VAL+rej | −95% | −84% | 1.84 | REJECT |
| F2 VAL-only | −94% | −82% | 1.54 | REJECT |
| **F3 rej-only** | **−20%** | **−7.6%** | **0.33** | **least-bad baseline** |
| F4 VAH+VAL | −99% | −94% | 2.60 | REJECT |
| F5 VAL+rej + wbVac | −91% | −76% | 1.55 | REJECT |
| F6 + chase | −92% | −76% | 1.44 | REJECT |

XRP edge is **not** the AVAX VAL vacuum story — open/VAL funnels are ruinous.

### Cell autopsy (F3 rej-only)

- **Pays:** `SELL|va_rejection|bull_trend|vacuum` (+$51 / 8t)
- **Bleeds:** BUY bull vacuum / bull_chop vacuum; SELL weak_bear + bear vacuum rej

### One-change vs F3

| Change | Full | OOS | Note |
|--------|-----:|----:|------|
| Deny BUY bull_trend vacuum | **+0.7%** | **+0.7%** | first OOS>0; Calmar~0; 24–25 −38% |
| Deny BUY bull_chop vacuum | −1% | **+6%** | OOS better, full still flat |
| Deny SELL weak_bear vacuum | −4% | −0.3% | weak |

## Round 2 — cell stack on rej-only (DB + funding)

**Artifact:** `.vp-freq-xrp-optimize-r2.json`

| ID | Full | Calmar | OOS | tw | Note |
|----|-----:|-------:|----:|---:|------|
| H0 rej | −20% | −0.08 | −8% | 0.33 | baseline |
| H1 deny BUY bull vac | +1% | 0 | +1% | 0.31 | first OOS>0 |
| H2 + BUY chop vac | +25% | 0.09 | +16% | 0.29 | |
| H3 + BUY chop all | +52% | 0.18 | +33% | 0.24 | 24–25 −36% |
| H4 + deny SELL bear/weak vac | +100% | 0.50 | +62% | 0.13 | 24–25 −25% |
| H5 sell-rej (deny all BUY) | +53% | 0.23 | +17% | 0.20 | years OK-ish |
| **H6 H5+deny SELL bear/weak vac** | **+101%** | **0.96** | **+43%** | **0.09** | near Calmar1; **N=24 only** |

H6 clears year table but fails frequency doctrine and OOS N≥30 (12 OOS trades). **Not a lock.**

## Round 3 — quality overlays on H5/H6

| ID | Full | Calmar | OOS | tw | Verdict |
|----|-----:|-------:|----:|---:|---------|
| H5 | +53% | 0.23 | +17% | 0.20 | baseline |
| H5 wick35/40 | negative | <0 | neg | ↓ | **REJECT** (kills paying SELL bull vac) |
| H5 HTF0.20 | +33% | 0.19 | +17% | 0.16 | REJECT vs H5 |
| H5 volTarget | +16% | 0.11 | +8% | 0.20 | REJECT (return crush) |
| H5 + deny weak_bear vac | +83% | 0.43 | +27% | 0.15 | progress, still Calmar≪1 |
| H5 + deny bear vac | +68% | 0.36 | +32% | 0.14 | weaker than weak_bear-only |
| H6 | +101% | **0.96** | +43% | **0.09** | checkpoint only (N=24) |
| H6 wick35 | +14% | 0.14 | +14% | 0.06 | REJECT |

## Honest status (XRP)

- Coin-native edge exists only in **SELL va_rejection**, mainly bull_trend vacuum.
- Path to Calmar≈1 requires denying BUY rej + bear/weak SELL vac → **ultra-low N** (rulebook: not a deliverable).
- Wick/HTF/vol-target do **not** replace cell abstention.
- **No preset lock / no certification** yet.

## Next (if continuing XRP)

1. Autopsy H5 residual losers (esp. 2024–25) for a **relative** rule that lifts Calmar without H6’s N crush.
2. Else park XRP as **REJECT / low priority** and move on — do not certify thin H6.

