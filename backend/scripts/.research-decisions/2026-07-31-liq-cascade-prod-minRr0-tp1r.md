# LIQ_CASCADE production — minRr=0 + TP 1R rerun

**Date:** 2026-07-31  
**Hypothesis:** 0-trade root cause was `buildBrackets` rejecting wide sweep SL vs small ATR-based TP under minRr 0.8. Setting minRr=0 and TP at 1× SL distance (1R) should unblock confirms without starving frequency.

**One change:** Added `liqCascadeTpRr` / `tpRr` (TP = slPct × tpRr). Production preset: `minRr=0`, `tpRr=1`.

**Window:** ~59h force_orders archive (2.46 days) — checkpoint only, not certified.

**Costs:** 0.05% slip + 0.04% fee/side, 10× lev, $100 portfolio BTC+ETH+BNB equal split.

| Setup | Trades | Net P&L | WR | PF | vs prior (0 trades) |
|-------|--------|---------|----|----|----------------------|
| Prod 5m | 8 | −$4.98 (−4.98%) | 25% | 0.15 | **Unblocked** — ETH cascade cluster 7/29 |
| Prod 1m | 3 | +$0.53 (+0.53%) | 67% | 2.53 | **Unblocked** — tiny N |

**Verdict:** Bracket geometry fix works (orders fire). 5m prod still deep red on short window; 1m slightly green on 3 trades — insufficient N for promote language. OI/window gates still dominant filter; next iteration should autopsy 5m ETH SL cluster, not re-tighten brackets.

**Artifact:** `.liq-cascade-prod-1rr-rerun.json`
