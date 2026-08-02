# LIQ_CASCADE prod 5m — churn fix + OI off + tp 5× (2026-07-31)

**Hypothesis:** 7/29 ETH −$4.98 was re-entry churn (flip + 3 SLs on same cascade), not lack of filters. Fix: one-shot per cascade (12×5m cooldown), OI off, tp 5× ATR.

**Changes (one bundle — all address named failure modes):**
1. `liqCascadeEventCooldownLiqBars: 12` — one trade per cascade cluster
2. `liqCascadeOiGateMode: off` — OI was blocking ~77% of bars, ~15% winner pass rate
3. `liqCascadeTpAtrMult: 5`, `tpRr: 0`, `minRr: 0` — beat friction vs 1R TP

**Window:** ~59h force_orders — checkpoint only.

| Metric | Prior (1R, OI on, no cooldown) | After fix |
|--------|--------------------------------|-----------|
| Trades | 8 | **17** |
| Net P&L | −$4.98 | **−$2.40** |
| Win rate | 25% | **53%** |
| PF | 0.15 | **0.73** |
| ETH 7/29 cluster signals | 5+ (flip churn) | **1** |

**Verdict:** Material improvement — churn fixed, WR sane, still **not profitable** on 59h / 17 trades. BTC slightly green (+$0.27); ETH still drag (−$1.75). Next: autopsy 7/30 13:45 triple-SL (BTC+ETH+BNB same minute) — correlated cascade / portfolio heat, not bracket geometry.

**Artifact:** `.liq-cascade-prod-fix-rerun.json`
