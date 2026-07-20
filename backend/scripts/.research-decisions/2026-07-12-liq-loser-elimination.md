# Experiment: LIQ loser elimination (structural confirmations, not parameter tightening)

- **Baseline:** `INTRADAY_PRO_LIQ_15M`, 2025-01-01→2026-01-01, 2% risk
- **Hypothesis:** Losers fail because we fade liquidity on **breakdown/breakout days** (continuation) and **weak displacement** sweeps; structural vetoes should remove bad trades without threshold sweeps
- **Method:** Trade autopsy (failure modes, MAE/MFE) + counterfactual + live cfg patches (`intradayLiqBreakdownDayBias`, `intradayLiqVetoCounterTrend`, displacement gate)

## Coin prerequisite (hard)

| Coin | Trades | Return | PF | Use? |
|------|--------|--------|-----|------|
| **BTCUSDT** | 22 | **+7.9%** | 0.78 | **YES — only positive coin** |
| ETHUSDT | 5 | -2.7% | 0.00 | NO — insufficient edge |
| BNBUSDT | 59 | -8.6% | 0.47 | NO — overtrades, fee bleed |
| XRPUSDT | 38 | -15.3% | 0.31 | NO |
| LINKUSDT | — | no data | — | NO |

**Do not run this preset on BNB/ETH/XRP portfolio** — destroys shared-account returns.

## Why BTC losers lose (13 losses / 22 trades)

| Failure mode | Count | Mechanism |
|--------------|-------|-----------|
| `never_green` | 3 | Sweep reclaim failed — price never moved in favor (fade into continuation) |
| `sl_no_follow` | 3 | Immediate stop — same root cause |
| `sl_after_profit` | 2 | Had MFE then reversed through SL |
| `time_stop_gave_back` | 2 | Partial path then drifted to time stop |

**Entry feature divergence (winners vs losers):**
- Impulse (sweep→entry ATR): **winners 1.16** vs **losers 0.86** — displacement matters
- Entry score: **no separation** (~61 both) — score gate alone doesn't eliminate bad trades
- **12/13 losers** occurred on breakdown-day long-PDL or breakout-day short-PDH fades

## Structural confirmations tested

| Variant | BTC trades | Return | PF | Verdict |
|---------|------------|--------|-----|---------|
| Baseline | 22 | +7.9% | 0.78 | Best absolute return |
| `intradayLiqBreakdownDayBias: true` | 3 | +4.1% | 1.55 | Higher quality, too few trades |
| `intradayLiqVetoCounterTrend: true` | 2 | +2.8% | 2.94 | Too few trades |
| Displacement ≥1.25 ATR | 22 | +8.4% | 0.80 | No filtering (all pass) |
| Full bundle | 0 | 0% | — | REJECT — kills all trades |

## Promoted setup (research-grade, not validation-gate approved)

```
Strategy: SR_INTRADAY
Preset:   INTRADAY_PRO_LIQ_15M
Symbol:   BTCUSDT only
TF:       15m
Risk:     2% at SL
```

Optional quality upgrade (trades 22→3, PF↑): `intradayLiqBreakdownDayBias: true`

- **Gates:** NOT RUN — ~22 trades/year insufficient for MC/WF gates
- **Verdict:** **BTC-only baseline** is the only working LIQ sweep+reclaim path found; does not beat SUPERTREND_ELITE validated portfolio
