# LIQ_CASCADE selective ladder — minRr 0.8 vs z 1.5 (max backdata)

**Date:** 2026-07-31  
**Base:** `LIQ_CASCADE_PORTFOLIO_1M_SMOKE_1MIN_SELECTIVE` (min liq $15k/12k/8k, disp≥0.8, tp 5×, z 1.2)  
**Window:** 2026-07-29 02:20 → 2026-07-31 05:28 UTC (~51h)  
**Costs:** 0.05% slip + 0.04% fee/side, $100 portfolio

## Experiment A — + minRr 0.8 (one change)

| Metric | Selective base | + minRr 0.8 | Δ |
|--------|----------------|-------------|---|
| Trades | 26 | 26 | 0 |
| Net P&L | −$2.60 | −$2.60 | **0** |
| PF | 0.78 | 0.78 | — |

**Result: NO-OP.** All 26 selective trades already met R:R ≥ 0.8 at bracket build. minRr gate does not help on this archive — problem is entry quality / SL hits, not sub-0.8 geometry skips.

## Experiment B — + z 1.5 (one change)

| Metric | Selective base | + z 1.5 | Δ |
|--------|----------------|---------|---|
| Trades | 26 | 24 | −2 |
| Net P&L | −$2.60 | **+$1.18** | **+$3.78** |
| Return | −2.6% | **+1.18%** | |
| Win rate | 50% | **58%** | |
| PF | 0.78 | **1.13** | |
| Max DD | 6.7% | **3.1%** | |
| SL net | −$10.73 | **−$8.38** | |

**Result: CHECKPOINT POSITIVE** on 51h / 24 trades — **not certified** (N<30, 0.3wk ticks, no holdout/WF/MC).

Preset added: `LIQ_CASCADE_PORTFOLIO_1M_SMOKE_1MIN_SELECTIVE_Z15`

## Disposition

- **Reject minRr 0.8** as next lever on selective base (no effect).
- **Keep z 1.5 on selective** as research/paper candidate; accumulate ≥8wk ticks → re-run unchanged harness.
- Do **not** cite as deployable until OOS gates pass with ≥30 trades.

Artifact: `scripts/.liq-cascade-max-backdata-selective-ladder.json`
