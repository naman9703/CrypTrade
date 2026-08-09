# ST BNB — RSI/EMA stretch skip (one change on ATR-stop set)

**Date:** 2026-08-04  
**Base:** ATR×3 stop (prior experiment), BNBUSDT 15m, 2025-01-01 → 2026-08-02  
**Ask:** one RSI / EMA-stretch skip on the ATR-stop trade set.

## What shipped

- Gate module: `backend/src/strategy/supertrendStretchSkip.js`
- Runner wiring + `metrics.stretchSkipReplay`
- Cfg: `supertrendStretchSkipEnabled`, `supertrendStretchEma20Pct`, `supertrendStretchRsiHigh/Low`

## Experiment A — “no-chase” (skip stretched WITH flip)

`BUY: dist>0.4% OR rsi>65` · `SELL: dist<-0.4% OR rsi<35`

| | ATR×3 | + no-chase skip |
|--|--|--|
| Trades | 752 | **124** |
| WR | 48.4% | 33.1% |
| PF | 0.659 | **0.542** |
| Return | −78% | −24.5% |
| Replay veto | — | 744 (mostly ema stretch) |

**Autopsy:** stretched bucket WR **52.8%** / mean net **−7** vs kept WR **36.5%** / mean **−19**.  
Rule removed the *better* trades → **REJECT**.

## Experiment B — “require WITH-trend / skip weak”

Inverted thresholds. Distributions of winners vs losers on `signed dist_ema20` and RSI **heavily overlap**. Wrong-side-of-EMA20 at the **signal bar** almost never fires (ST flips already sit on the trend side) → **veto ≈ 0**, identical to ATR-only.

## Verdict

**RSI/EMA-stretch skip does not make this setup profitable** on the ATR-stop BNB set.

- No-chase hurts expectancy (N-crush of better trades).
- Confirmation-style stretch does not separate winners enough to clear PF ≥ 1.

Gate remains available for research; **do not enable by default**.

## Next (one change)

**Enable trail** (`trailingStopLossAuto=true`) with ATR×3 initial SL — exit contract, not another entry filter.
