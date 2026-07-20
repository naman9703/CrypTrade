# Experiment — VP frequency funnel reopen

Date: 2026-07-14  
Window: **2025-01-01 → 2026-06-01**  
Script: `npm run backtest:vp-freq-funnel`  
Artifact: `backend/scripts/.vp-freq-funnel-results.json`

## Hypothesis

Tier-A stack (ADX≥24, HTF hard align, regime immunity, Tier-A-only setups, vol 1.6×, RR≥2, score≥12) crushed frequency **without** being necessary for auction edge. Reopen real VP setups; drop N-only gates; cap **1 pick/day**.

## Funnel changes (what stays vs what was dropped)

| Kept (defines a real VP event) | Dropped / softened (N-only or autopsy losers) |
|--------------------------------|-----------------------------------------------|
| Named setups: LVN, VA break, rejection, POC bounce, naked POC | Tier-A-only ban on B-tier setups |
| Mild body / path / RR so not random bars | ADX≥24 → off (`vpMinAdx: 0`) |
| `vpMaxTradesPerDay: 1` (user target) | HTF hard align → off (BNB) / soft 0.15% (ETH) |
| Structure brackets | Regime immunity stack → off |
| | Session 07–22 → **00–24** |
| | Vol ratio 1.6 → ~1.05; score 12→8; RR 2→1.2 |

## Results (honesty window)

### Open FREQ (all auction setups, no coin filter)

| Symbol | Cand | Trades | t/day | t/wk | Ret% | PF |
|--------|-----:|-------:|------:|-----:|-----:|---:|
| BNB Tier-A | 3 | 3 | 0.006 | 0.04 | +12.2 | 4.93 |
| BNB open FREQ | 186 | 122 | 0.24 | 1.66 | **−40.1** | 0.66 |
| ETH Tier-A | 14 | 13 | 0.03 | 0.18 | +16.9 | 1.31 |
| ETH open FREQ | 284 | 174 | 0.34 | 2.36 | **+96.1** | 1.18 |
| ETH + soft HTF | 105 | 81 | 0.16 | 1.10 | **+100.1** | **1.61** |

BNB autopsy: `va_rejection` −26, `val_breakdown` −23, `poc_bounce` −7.

### Coin-resolved FREQ (current presets)

| Symbol | Preset bias | Cand | Trades | t/day | t/wk | Ret% | PF | DD% |
|--------|-------------|-----:|-------:|------:|-----:|-----:|---:|----:|
| **BNB** | no `val_breakdown` / `va_rejection` / `poc_bounce` | 79 | **49** | 0.10 | **0.66** | **+7.5** | **1.04** | 18.6 |
| **ETH** | soft HTF 0.15% | 194 | **125** | 0.24 | **1.70** | **+189.7** | **1.57** | 31.2 |

## Verdict

| Target | Status |
|--------|--------|
| ≫3–13 trades/17mo | **PASS** — 49 BNB / 125 ETH |
| ~1 trade/day | **MISS** — peak ~0.24–0.34/day before coin filters; auction patterns do not fire daily |
| Return > 0, PF ≥ 1 | **PASS ETH**; **marginal PASS BNB** (+7.5% / PF 1.04) |
| Rulebook ≥2/wk | ETH **1.7/wk** near; BNB **0.66/wk** short |

**Promote language:** research-only. ETH FREQ is the strongest VP stream yet (large N + positive PF). Not certified (no WF/MC gates yet; BNB DD path and short-side still weak).

### Why 1/day is hard with *this* definition

The picker cap (`vpMaxTradesPerDay: 1`) is **not** binding. Candidates over 516 days top out ~200–280 even with full-day session and soft patterns. A clean VA break / LVN vacuum / rejection is an **event**, not a daily clock. Forcing 1/day requires a different product (e.g. daily best value-touch / POC magnet without pattern quality) — that is a **new hypothesis**, not another knob on Tier-A.

## Next experiments (one at a time)

1. **ETH FREQ validation** — walk-forward + Monte Carlo on `VOLUME_PROFILE_FREQ_ETH_15M` (only promote path with N).
2. **BNB short rewrite** — `val_breakdown` bled; try VAL rejection long-only or session-extreme fade, not open short breakouts.
3. **Value-touch daily pick** — experimental setup: one best POC/VA proximity reclaim per day (explicitly aiming at 1/day) vs FREQ pattern stream.
4. **Portfolio ETH+BNB FREQ** — shared account sim.

## Code

- Presets: `VOLUME_PROFILE_FREQ_*`, `resolveVolumeProfileFreqPreset()`
- Engine: configurable ADX/ATR/vol bar gates; `nearTolPct` / rejection soft knobs
- UI: “BNB VP FREQ ~1/day (research)”
- Script: `npm run backtest:vp-freq-funnel`
