# LIQ BNB freq restore + noSess promote (2026-07-23)

## Year-wise baseline (BNB 15m, fees+slip, risk 2.5%, 2023-07→2026-07)

### CORE (concept-only, high N) — EDGE FAIL

| Window | n | PF | Return | tw/wk |
|--------|---|----|--------|-------|
| 2023 H2 | 167 | 0.65 | **−59%** | — |
| 2024 | 377 | 0.65 | **−37%** | — |
| 2025 | 343 | 0.75 | **−3%** | — |
| 2026 H1 | 147 | 0.48 | **−1%** | — |
| FULL | 1034 | 0.65 | **−100%** | **6.6** |

### AST_vol15 (Asia-only + vol≥1.5 stack) — prior sleeve

| Window | n | PF | Return |
|--------|---|----|--------|
| 2023 H2 | 4 | 0.78 | −1.4% |
| 2024 | 10–11 | ~2.2 | **+11–15%** |
| 2025 | 14 | 1.55 | **+11%** |
| 2026 H1 | 4 | 1.19 | **+1.4%** |
| H12 | 13 | 1.55 | **+11%** |
| FULL | 33 | 1.56 | **+26%** @ **0.21/wk** |

## Frequency restore A/B (hypothesis)

Widening sessions / dropping same-bar / all-sessions **without** quality gate → expectancy dies (F2 FULL −50%).  
**Necessary** cut = session EQH/EQL noise under Asia stack; **useful** restore = add London + keep vol/same-bar/tox/maxSl/loc.

| Variant | FULL | tw | Y23 | Y25 | Y26 | Verdict |
|---------|------|----|----|-----|-----|---------|
| AST | +26% / 1.56 | 0.21 | −1.4 | +11 | +1.4 | prior |
| A_noSess (Asia, PDH/PDL only) | **+33% / 1.85** | 0.19 | **+1.7** | +11 | +1.5 | best expectancy; slight N cut |
| F1 Asia+London | +4% / 1.04 | 0.35 | −10 | +0.5 | +5 | freq↑ edge↓ |
| **F1_noSess** | **+28% / 1.44** | **0.27** | −1.0 | +6.4 | +6.5 | **promote** — better FULL + higher N vs AST |
| All sessions / no same-bar | crash | — | — | — | — | REJECT |

## Promote

Update `INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M` → **Asia+London + sessionExtreme false** (+ existing vol15 gates).

Still **`RESEARCH_SLEEVE_LOW_FREQ`** (~0.27/wk ≪ 2/wk). Not live until WF+MC+≥30 OOS.  
Stricter alternate: Asia-only + noSess (FULL +33, all years green, lower N).

## Live readiness gaps remaining

1. WF + MC + 4-gate harness  
2. Frequency path: multi-coin breadth with same relative rules (not veto crush)  
3. Y23H2 residual on F1_noSess (~−1%) — monitor, do not calendar-exclude  

Artifacts: `.liq-bnb-yearwise-freq-ab.json`, `.liq-bnb-ast-improve-ab.json`
