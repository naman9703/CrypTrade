# LIQ_CASCADE smoke 1m — selective ablation vs baseline (max backdata)

**Date:** 2026-07-31  
**Hypothesis:** Smoke loses because it fires on low-quality cascades; one change = raise min liq $ + require displacement ≥0.8 ATR (keep smoke OI off, tp 5×, z 1.2).  
**Window:** Max `force_orders` archive — 2026-07-29 02:20 → 2026-07-31 05:26 UTC (~51h / 2.1d)  
**Costs:** 0.05% slip + 0.04% fee/side, 10×, $100 equal 3-coin portfolio

## Change (single concept)

| Param | Smoke baseline | Selective ablation |
|-------|----------------|-------------------|
| minLiqUsdBar | $5k all | **$15k BTC / $12k ETH / $8k BNB** |
| minDispAtr | 0 (off) | **≥0.8 ATR** |
| Other | z 1.2, tp 5×, OI off | unchanged |

Preset: `LIQ_CASCADE_PORTFOLIO_1M_SMOKE_1MIN_SELECTIVE`

## Results

| Metric | Smoke | Selective | Δ |
|--------|-------|-----------|---|
| Trades | 81 (38/d) | **26 (12/d)** | −55 |
| Net P&L | **−$23.90** (−23.9%) | **−$2.70** (−2.7%) | **+$21.20** |
| Win rate | 37% | **50%** | +13pp |
| Profit factor | 0.43 | **0.77** | |
| Max DD | 25.1% | **6.7%** | |
| TP net | +$17.58 | +$9.03 | |
| SL net | −$39.85 | **−$10.73** | |

## Verdict

**Improvement confirmed** — selective filters cut churn and SL damage by ~90% of the loss, but **still not profitable** on 2.1d / 26 trades (below ≥30 OOS rule, archive too short).

**Do not deploy.** Keep selective preset for research + paper; next single-change candidates: `minRr ≥0.8` or higher z (1.5+) on selective base.

Artifacts:
- `scripts/.liq-cascade-max-backdata-selective-ablation.json`
- `scripts/.liq-cascade-max-backdata-smoke-1m.json`
