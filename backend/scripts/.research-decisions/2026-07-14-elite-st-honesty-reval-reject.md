# Decision — SUPERTREND_ELITE honesty re-validation under locked trail

Date: 2026-07-14  
Exit contract: `2026-07-14-elite-st-exit-contract.md` (`ELITE_ST_EXIT_CONTRACT`)  
Window: 2025-01-01 → 2026-06-01 · TF 15m · uniform `m3 / ADX≥20 rising / 4H+1H EMA / vol+ATR`  
Costs: taker slip 5bp + funding · `RISK_AT_SL`

## Verdict: **REJECT** (not certified / do not promote)

Locked trail is now the correct research exit. Under it, the stream is **not**
gate-passing as a deployable multi-coin strategy. Do not soft-promote on portfolio
R-replay alone.

## Evidence

### Portfolio R-replay (shared account, uniform cfg)

| risk% | totRet% | CAGR% | maxDD% | Calmar |
|------:|--------:|------:|-------:|-------:|
| 5 | 70.6 | 46.0 | 18.2 | 2.52 |
| 10 | 166.3 | 100.0 | 36.5 | 2.74 |

Per-coin expectancy R: BTC **−0.053**, ETH +0.377, BNB +0.135, LINK +0.310, XRP +0.421  
(N=69 total · log: `.phase1-honesty-portfolio.log`)

### Phase 3A holdout (last 25%, risk 5%)

Portfolio holdout sum **+9.4%** (`holdout_positive`) but **every coin failed individual gates**
(thin holdout sample / MC). Log: `.phase1-honesty-phase3a.log`

### Uniform cfg — full-window WF + MC + 4 gates (the certification bar)

| Symbol | Full net% | Gates | Blockers |
|--------|----------:|-------|----------|
| ETHUSDT | +31.9 | **ACCEPTED** | — |
| XRPUSDT | +15.0 | **ACCEPTED** | — |
| BNBUSDT | +13.3 | REJECTED | WF degradation 75.5% |
| LINKUSDT | +8.0 | REJECTED | Calmar / WF / N=5 |
| BTCUSDT | **−8.1** | REJECTED | MC p5&lt;0, Calmar&lt;0 |

Log: `.phase1-honesty-uniform-gates.log`

### Per-coin param sweep (exploratory only — not the uniform stream)

ETH best sweep ACCEPTED; BTC/BNB best sweep fail WF degradation.
(`.phase1-honesty-validate.log`) — **do not** use per-coin tuning as a promote path.

## Why REJECT despite strong portfolio R-replay

1. **Uniform stream must survive coin-level gates.** BTC is negative on the full
   window; BNB fails WF; LINK is under-sampled.
2. Portfolio R-replay compounds optimistic R when per-coin equity paths disagree
   (BTC drag + one catastrophic trade — see autopsy).
3. Acceptance rule: all of OOS&gt;0, MC p5&gt;0, Calmar&gt;1, WF deg&lt;35%, sane N —
   **not met for the multi-coin certificate.**

## Autopsy (BTC losers) — named failure mode

Uniform cfg BTC: winners 9 / +$178 vs losers 14 / −$259.

- **Dominant failure:** one `exitReason=liq` trade (2025-02-12) **−$182** ≈ all
  winner PnL. Trail-only + leverage exposes ruinous MAE without a disaster stop.
- Losers: higher MAE (~0.67% vs ~0.16%), longer holds (~6 vs ~1 bar) — dead money
  until trail gives up; little MFE.
- Most other exits still `trail` (contract working; problem is risk of wipeout /
  failed trend, not fixed-bracket contamination).

## Next (Phase 2)

See `2026-07-14-phase2-hypothesis-after-st-reject.md`.  
**Do not** certify. **Do not** reopen funding/LIQ dead ends.
