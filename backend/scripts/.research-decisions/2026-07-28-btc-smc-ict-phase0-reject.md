# BTC SR_INTRADAY SMC/ICT — Phase 0 + H1–H5 reject (2026-07-28)

## Stream

`SR_INTRADAY` + `intradayGateSmcIct` / `evaluateSmcIctSetup.js` (ICT 2022
orchestrator). Presets (`INTRADAY_PRO_ICT_*`) are **BNB-tuned**; this is the
first **BTC-native** multi-year honesty screen.

## Window / costs

- BTCUSDT 15m futures · `2023-01-01 → 2026-05-31` · OOS split `2024-06-01`
- Risk 2.5% · lev 12 · fees 4+4 bps · slip 5 bps · funding on

## Phase 0

| Profile | n | tw/wk | WR | FULL | OOS |
|---------|---|-------|-----|------|-----|
| sweep_default | 393 | **2.21** | 28.8% | **−142%** | **−47%** |
| London+NY | 173 | 0.97 | 24.3% | −107% | −45% |

Frequency OK; edge dead. All year buckets red.

## Autopsy

- SL n=179 / −19.2k vs TP2 n=50 / +3.6k
- Losers avg MFE **+0.51%** then reverse; 68 never-green; session_low worst
- ~45% entries shallow session soft-pass (&lt;0.3% ext)
- 109/393 with HTF EMA↔structure disagreement

## Hypothesis ladder (all REJECT — no OOS>0 & FULL>0)

| H | Change | Result |
|---|--------|--------|
| H1 | Session minExt knobs | **No-op** (soft-pass) |
| H1b | `HardMinExt` (new flag) | Shallow→0; OOS **worse** (−75%) |
| H2 | RequireMss / retrace (2025 smoke) | Less red, still negative; N crush; multi-year hung |
| H3 | `NO_ASIA` / `NO_ASIA_WIDE` / deny HTF disagree / SL=sweep | All red; least-bad still `maxHold16` (−37% OOS) |
| H4 | Prem/disc, internal TP, PDH-only, side postfilter | All red; SELL less bad but −20% OOS |
| H5 | Confirm, SELL-only (wired), 1h research, SMC body gate | All red; `LiqMinReclaimBody` was **no-op on SMC** until `intradaySmcMinReclaimBodyRatio` wired; body50–70 still OOS≤−49% |

Least-bad full-sim OOS among freq-viable: **`maxHold16` (−123% / −37% @ 2.29/wk)** — still deep red.

## Code added (research opt-ins; defaults preserve prior behaviour)

- `intradayLiqSessionExtremeHardMinExt`
- Killzone modes `NO_ASIA`, `NO_ASIA_WIDE`
- `intradaySmcDenyHtfDisagreement`
- `intradaySmcAllowedSides` (`BUY`/`SELL`/`BOTH`)
- `intradaySmcMinReclaimBodyRatio` (explicit; does **not** inherit LIQ 0.35)

## Decision

**`REJECT_STREAM_BTC_SMC_SWEEP`** — reclaim-bar SMC sweep on BTC has negative
expectancy that **filters do not repair**. Do not paper-size. Do not lock a BTC
SMC preset. BNB Jan–May SMC numbers are not BTC truth.

## Next (only reopen paths)

1. **Structure-scan perf fix** so full-history MSS/CHoCH/balanced/full can run
   without 45min hangs — then retest ICT structure entry (not reclaim-only).
2. If structure still red on BTC → park SMC for BTC; try other coin or different
   SR_INTRADAY setup (LIQ BUYBD path already has a BNB sleeve).
3. No WF/MC until FULL>0 **and** OOS>0 with n≥30 OOS.

Scripts: `research-smc-btc-phase0-baseline.mjs`,
`research-smc-btc-autopsy-optimize.mjs`, `research-smc-btc-h1-session-ext.mjs`,
`research-smc-btc-h2-require-mss.mjs`, `research-smc-btc-h3-asia-htf-sl.mjs`,
`research-smc-btc-h4-side-pd-tp.mjs`, `research-smc-btc-h5-reclaim-confirm.mjs`.
