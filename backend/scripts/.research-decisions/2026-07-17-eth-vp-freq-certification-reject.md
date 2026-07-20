# 2026-07-17 — ETH VP FREQ certification = REJECT (OOS not sustained)

## Experiment

- **Baseline:** locked `VOLUME_PROFILE_FREQ_ETH_15M`
- **Window:** ETHUSDT futures 15m, **2020-01-01 → 2026-05-31**
- **Script:** `backtest-validate-vp-freq-eth.mjs`
- **Single change:** none — frozen-lock validation only

## Parity vs BTC adaptive work

ETH received **coin-specific** rule tuning (ABC adaptive stack, weak-bear short,
vacuum prior5d gate, buy-chase filter, chop MFE trail) but **not** the BTC
prepared-regime matrix / deny-known-bleed doctrine. All ETH locks were validated
primarily on **2022–2026**, not full 2020–2026 OOS.

## Validation result

- Full window: **318 trades / +178.7% / CAGR 17.3% / Calmar 0.29 / DD 58.9% / PF 1.33**
- Jun→May year buckets:
  - 2019-20 **−11.1%** (22t)
  - 2020-21 **−26.0%** (74t)
  - 2021-22 **−27.5%** (56t)
  - 2022-23 +23.9% (38t)
  - 2023-24 +43.3% (23t)
  - 2024-25 +38.9% (52t)
  - 2025-26 +137.2% (53t)
- Monte Carlo (1% risk): **p5 −7.0%**, ruin 0.3%
- Expanding purged WF: OOS sum +231.8% on 256 OOS trades, but fold 0 = **−25.2%**
- Core gates: **FAIL**
  - OOS > 0 ✓
  - MC p5 > 0 ✗
  - Calmar > 1 ✗
  - WF degradation < 35% ✓
- Extra gates: **FAIL** frequency (<2/wk), **FAIL** catastrophic years (3 years ≤ −25%)

## Cost stress

| Scenario | Return | DD |
|---|---:|---:|
| slip×2 | **−37.7%** | 77.5% |
| slip×4 | **−92.0%** | 95.2% |
| liquidity crunch | **−99.8%** | 99.8% |

Edge is fragile under realistic cost widening (BTC stayed positive through slip×4).

## OOS parity test (BTC prepared-regime on ETH)

Script: `backtest-vp-freq-eth-oos-audit.mjs`

| Window | ETH locked | + BTC prepared | Read |
|---|---:|---:|---|
| 2021–22 | −32.4% | **−8.3%** | prepared helps early bleed |
| 2022–23 | +23.9% | **+48.0%** | prepared improves |
| 2023–24 | +43.3% | +8.6% | prepared cuts good trades |
| 2025–26 | **+151.1%** | +22.2% | prepared destroys recent leg |

Blind BTC deny-list is **not** the ETH answer — it reduces DD (58.9% → 22.6%) but
sacrifices too much return and frequency. ETH needs its **own** prepared matrix.

## Verdict

**REJECT_CERTIFICATION** — do not cite as deployable or research-sleeve-ready.

The 2022–2026 tuning is **not** sustained OOS on 2020–2022. Next work:

1. Run ETH-specific prepared-regime cell matrix (2020–2026), same doctrine as BTC
2. Autopsy 2020–2022 bleed cells (74+56 trades in bad years)
3. Re-test only after ETH-native deny rules are isolated one-change at a time
4. Do **not** port BTC prepared keys wholesale — they over-prune ETH's 2025–26 edge
