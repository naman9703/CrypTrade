# Decision — Volume Profile profitability test (honesty)

Date: 2026-07-14  
Window: **2025-01-01 → 2026-06-01** (~17 months)  
Preset: `VOLUME_PROFILE_15M` Tier-A (LVN + VA breakouts)  
Costs: slip 5bp + funding · RISK_AT_SL 2.5% · lev 12×  
Artifact: `backend/scripts/.vp-profit-final.json`

## What was tested

1. Accurate profile engines (`session_utc`, `composite_utc`, `rolling` + close-weighted bins)
2. Prior-session VAH breakouts under session/composite
3. Production Tier-A gates unchanged (ADX/HTF/vol/regime)

## Solo results (production = rolling + close_weighted)

| Symbol | Trades | WR% | Return% | PF | MaxDD% | Calmar |
|--------|-------:|----:|--------:|---:|-------:|-------:|
| BNBUSDT | 3 | 66.7 | **+11.91** | **4.67** | 3.04 | 2.72 |
| ETHUSDT | 13 | 30.8 | **+6.88** | **1.26** | 11.9 | 0.40 |
| BTCUSDT | 2 | 0 | −5.87 | 0 | 5.87 | −0.71 |

## Portfolio R-replay (BNB + ETH only — drop BTC)

| Risk/trade | Trades | Return% | CAGR% | MaxDD% | Calmar |
|-----------:|-------:|--------:|------:|-------:|-------:|
| 2.5% | 16 | **+19.61** | 13.5 | 11.9 | **1.13** |
| 5% | 16 | **+36.22** | 24.4 | 23.1 | **1.05** |

## Modes that failed honesty (do not promote)

- `session_utc` Tier-A: ~0 trades after full gates  
- `composite_utc` Tier-A: net-negative (e.g. ETH −28%)  
→ Kept as research modes; **production default stays `rolling`**.

## Validation gates (ETH, largest + sample)

MC p5 **negative**, Calmar **&lt; 1** → **REJECTED** for certify/deploy.  
OOS fold sum return positive; WF deg OK — not enough for all 4 gates.

## Verdict

- **Profitable outcome (research):** Yes, on **BNB+ETH** under rolling Tier-A with realistic costs. Portfolio R-replay Calmar &gt; 1 at 2.5–5% risk.
- **Certified / live:** **No** — BTC loses; trade count thin on BNB; ETH fails MC p5 + Calmar gates.
- **Production preset:** `vpProfileMode: "rolling"` + `vpVolumeDistribute: "close_weighted"` locked to the config that produced the positive results.

## Next

1. Do not chase composite until a new hypothesis beats rolling OOS.  
2. Optional: BTC exclude from VP portfolio; autopsy ETH losers for one gate change.  
3. Continue intraday series (liquidity sweep) without claiming VP is deployable.
