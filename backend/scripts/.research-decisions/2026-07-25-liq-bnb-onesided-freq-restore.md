# BNB LIQ one-sided toxic → freq restore (2026-07-25)

Coin: **BNBUSDT** 15m. Base path: prepared physics (disp≥1.2 ATR, MinSl 1%, mitigation).

Artifacts: `.liq-bnb-prepared-mit-residual.json`, `.liq-bnb-onesided-toxic-ab.json`, `.liq-bnb-onesided-nudge.json`.

## Hypothesis

Full `DaySituationBias` (both toxic sides) on mit+h020 keeps HOLD green but crushes tw (~1.2–1.5/wk).  
HI_FREQ without toxic hits tw≥2 but HOLD red (~−9%).

**Residual soft:** abstain only `BUY|breakdown` *or* only `SELL|breakout` on HI_FREQ → EG both windows with HOLD tw≥2 and Y1 tw≈1.76–1.98.

**One change in engine:** `intradayLiqDaySituationBias` accepts `true|"both"|"buy_breakdown"|"sell_breakout"`.

## Hard results (fees + slip)

### Primary `INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M` (= buy_bd_mit030)

| Window | n | tw | ret | PF |
|--------|---|----|-----|----|
| Y1 | 105 | **2.01** | **+22.5%** | **1.16** |
| HOLD | 120 | **2.30** | **+7.1%** | **1.05** |
| FULL | 352 | **2.25** | **+31.3%** | **1.07** |

Config: `buy_breakdown` + mitFrac **0.30** / wait 8 / hours 0–20 / disp 1.2 / MinSl 1%.

### Cousin `INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_SELLBO_15M` (= sell_bo_disp11)

| Window | tw | ret | PF |
|--------|----|-----|----|
| Y1 | 2.03 | +6.9% | 1.05 |
| HOLD | 2.19 | +27.1% | 1.18 |
| FULL | 2.13 | **+44.4%** | **1.09** |

Config: `sell_breakout` + mitFrac 0.35 / wait 8 / hours 0–20 / disp **1.1**.

Other PASS (same gate): `buy_bd_disp11`, `buy_bd_h021`, `buy_bd_disp11_side3`, `sell_bo_disp11_side3` — archived in nudge JSON; primary keeps stronger Y1.

## Verdict

> **SUPERSEDED 2026-07-25 — see `2026-07-25-liq-bnb-ui-backtest-smc-not-buybd.md` (Round 2).**
> Y1 was split and the gain is regime-concentrated: 2025 H2 = **+40%** @ tw 2.51, but
> 2026-01→07 = **−9.6%** @ tw 1.41 PF 0.78. The forward slice fails both return and
> frequency gates, so the Y1 "PASS" below is a window artifact. **Not deployable; do not
> start WF/MC.** Autopsy 2026 H1 losers first.

**RESEARCH_SLEEVE — freq floor cleared** (Y1+HOLD+FULL tw≥2 and expectancy green).  
**Not live / not promote** until WF + Monte Carlo + 4-gate harness.

Beats prior PREPARED_MIT (~1.5/wk) on frequency without returning to CORE bleed.

## Rejected along the way

- Full toxic + any hour widen: stays below tw≥2 or loses a window.
- HI_FREQ without one-sided: HOLD red.
- `buy_bd_disp10` / open hours past 20: reopens HOLD bleed.

## Next

1. ~~WF + MC + 4-gates on BUYBD~~ — blocked: 2026 H1 is −9.6%. Autopsy that slice first.  
2. Coin-native ETH/BTC — do not copy BNB one-sided matrix.  
3. Re-check whether SELLBO shares the same 2026 H1 collapse before treating it as a fallback.
