# Safe Intraday Crypto Setup (`SAFE_INTRADAY`)

> **Reality check:** **1% per day** (~30%/month compounded) is **not achievable** safely or repeatably on crypto perps with honest costs. This setup targets **~1% per month** (~0.03–0.05% average per calendar day) with controlled drawdowns — the same honest band as validated `SUPERTREND_ELITE` research.

## What it is

**`SAFE_INTRADAY`** = validated **Supertrend Elite 5-gate** trend follower + **safety overlays**:

| Layer | Setting |
|-------|---------|
| Signal | ST flip + ADX≥20 rising + vol≥1.5× + 1H EMA + 4H ST + ATR expansion |
| Exit | Trailing Supertrend / flip (no fixed TP) |
| Session | **London + NY only** (07–10 & 12–16 UTC) |
| Trade cap | **Max 2 new entries / UTC day** |
| Risk/trade | **1%** at stop (`RISK_AT_SL`) |
| Leverage | **10×** (not 25×) |
| Daily loss cap | **1.5%** — no new entries |
| Account kill switch | **8%** drawdown from peak |
| Consecutive losses | Pause after **2** losses (rest of UTC day) |
| Weekly cap | **4%** rolling loss → halt entries |

## Deploy config (copy to bot / backtest)

```json
{
  "manualStrategy": "SAFE_INTRADAY",
  "strategyMode": "MANUAL",
  "supertrendPeriod": 10,
  "supertrendMultiplier": 3.0,
  "supertrendWilderAtr": true,
  "eliteStMinAdx": 20,
  "eliteStRequireAdxRising": true,
  "eliteStMinVolumeVsAvg": 1.5,
  "eliteStRequireHtf1hEmaAlign": true,
  "eliteStRequireHtf4hAlign": true,
  "eliteStRequireAtrExpansion": true,
  "safeIntradayMaxTradesPerDay": 2,
  "safeIntradayKillzoneMode": "LONDON_NY",
  "intradaySmcKillzoneEnabled": true,
  "trailingStopLossAuto": true,
  "futuresTrailingStopMode": "SUPERTREND",
  "supertrendFuturesExitOnFlip": true,
  "supertrendFuturesFixedSlPct": 0,
  "supertrendFuturesFixedTpPct": 0,
  "backtestPositionSizing": "RISK_AT_SL",
  "riskPerTrade": 1,
  "riskPerTradeUnit": "PCT",
  "futuresLeverage": 10,
  "maxDailyLoss": 1.5,
  "maxDailyLossUnit": "PCT",
  "riskKillSwitchDdPct": 8,
  "riskConsecutiveLossLimit": 2,
  "riskWeeklyMaxLossPct": 4
}
```

Or in code: `SAFE_INTRADAY_ACTIVATION_PATCH` from `backend/src/strategy/safeIntraday.js`.

## Recommended portfolio

Run on **multiple majors** so low frequency per coin still deploys capital:

- BTCUSDT, ETHUSDT, BNBUSDT, LINKUSDT, XRPUSDT — **15m**

## Validate

```bash
cd backend
FROM=2025-01-01 TO=2026-06-01 SYMBOLS=BTCUSDT,BNBUSDT,ETHUSDT node scripts/backtest-validate-safe-intraday.mjs
```

Full OOS gates (same as Elite):

```bash
ONLY=SAFE_INTRADAY SYMBOLS=BTCUSDT FROM=2025-01-01 node scripts/backtest-validate-supertrend.mjs
```

(Use validate-supertrend with SAFE_INTRADAY if wired; else compare script above.)

## Before live

1. **Paper trade** 2–4 weeks with this exact config.
2. **Docker DB** running (`localhost:54333`).
3. **Never** raise risk to chase “1% today” — that is how accounts blow up.
4. If you need more return, add **coins**, not **risk%** or **leverage**.

## Files

| File | Role |
|------|------|
| `backend/src/strategy/safeIntraday.js` | Strategy + adapter + activation patch |
| `backend/src/strategy/strategies.js` | Registry |
| `backend/src/backtest/engine/signals/baselines.js` | Backtest adapter |
| `backend/scripts/backtest-validate-safe-intraday.mjs` | Quick compare vs Elite |
| `docs/TRADING_GLOSSARY.md` | Term reference |

## Related

- `STRATEGY_RESEARCH_HANDOFF.md` — validated research verdict
- `AGENTS.md` — infra and honesty rules
