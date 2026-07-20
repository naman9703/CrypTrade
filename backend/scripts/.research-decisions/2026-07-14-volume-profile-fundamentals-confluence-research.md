# Research — Volume Profile fundamentals & confluence architecture

Date: 2026-07-14  
Status: **Research doctrine** (informs experiments; not a deploy claim)

## What VP is (AMT)

Volume Profile maps **volume at price** — where the auction found fair value.

| Level | Role |
|-------|------|
| POC | Fair-value magnet |
| VAH / VAL | Acceptance boundary (~70% volume) |
| HVN | Shelf — react / slow |
| LVN | Air pocket — fast travel |
| Naked POC | Prior POC not yet revisited — magnet |

**Auction cycle:** balance inside VA → break → discovery through LVN → new balance.

VP alone answers **where** price is structurally interesting. It does **not** authorize entry.

## Textbook entry stack (what pros club together)

```
1. CONTEXT   — balance vs discovery day; HTF trend
2. LOCATION  — VP edge (VAH/VAL/POC/HVN/LVN/naked POC)
3. CONFLUENCE — liquidity (PDH/PDL sweep), structure (OB/FVG), session
4. TRIGGER   — signal candle (wick rejection / strong close)
5. RISK      — stop beyond structure; target next HVN/POC (edge-to-edge)
```

**Highest-probability combos cited in literature:**

- VP edge + **PDH/PDL/session liquidity** sweep + reclaim  
- VP HVN + **order block** (double institutional footprint)  
- VA break + **volume spike** + HTF alignment  
- LVN entry + **delta/CVD** confirmation at level  

## Repo mapping

| Layer | Module | Status |
|-------|--------|--------|
| VP levels | `techniques/volumeProfile.js` | Implemented (session/composite/rolling) |
| VP solo | `volumeProfileStrategy.js` | Low N, marginal edge under Tier-A |
| VP as gate | `intradayPro.js` + `INTRADAY_PRO_VP_15M` | Score layer on composite bar |
| LIQ trigger | `liquidity.js` + `INTRADAY_PRO_LIQ_*` | ~1/wk BNB, near breakeven |
| **LIQ+VP confluence** | `INTRADAY_PRO_LIQ_VP_CONFLUENCE_*` | **Experiment 2026-07-14** |

## Why VP solo failed frequency/return targets

- Waited for rare VP Tier-A bar in isolation (3–16 trades/17mo)  
- Missing **liquidity trigger** (sweep → reclaim at VP level)  
- Missing **order-flow confirm** at level (taker data available, unused)  
- Correct brackets; wrong **trigger architecture**

## Chosen experiment architecture

**Hypothesis:** Liquidity sweep provides **frequency**; VP at same bar provides **location quality**; dual-gate composite requires **both** technique tags (`minTechniqueCount=2`).

| Leg | Preset knob |
|-----|-------------|
| Trigger | `intradayGateLiquidity` + `intradayLiqStrictMode` |
| Location | `intradayGateVp` + rolling 384 close-weighted |
| Both required | `intradayMinTechniqueCount: 2`, `intradayRequireLiqOrSession`, `intradayRequireFibOrVp` |
| Exits BNB | LIQ partial @1R (`INTRADAY_PRO_LIQ_15M` base) |
| Exits ETH | Trail (`INTRADAY_PRO_LIQ_ETH_15M` base) |

**Script:** `backtest-liq-vp-confluence.mjs`  
**Compare:** LIQ solo | VP gate | VP standalone | confluence | confluence strict (`requireVpSetup`)

## Success criteria (rulebook)

- **Frequency:** ≥2 trades/week/coin OR portfolio ≥4/week on BNB+ETH  
- **Edge:** OOS return > 0, PF ≥ 1  
- **vs baselines:** Beat LIQ solo on return without losing >50% frequency vs LIQ solo

## If confluence fails

Next single changes (in order):

1. **Flow confirm** — require taker delta alignment at VP level (ETH/BTC 15m data exists)  
2. **Proximity gate** — LIQ level within X bp of VP POC/VAH/VAL/HVN  
3. **Exit-only** on best-frequency leg (BNB LIQ partial runner)  
4. **5m trigger** on 15m VP map (raise N without loosening location)

Do **not** revert to VP Tier-A solo or sub-1 trade/month “profit.”
