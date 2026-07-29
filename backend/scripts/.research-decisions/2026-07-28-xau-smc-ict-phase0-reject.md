# XAUUSDT SR_INTRADAY SMC/ICT — Phase 0 reject (2026-07-28)

## Stream

Same ICT profiles as BTC practical path (`evaluateSmcIctSetup.js`), coin-native
on **XAUUSDT** 15m futures. User-requested transfer test after BTC reject.

## Window / costs

- XAUUSDT 15m · `2025-12-15 → 2026-07-20` · OOS split `2026-04-01`
- Risk 2.5% · lev 12 · fees 4+4 bps · slip 5 bps · funding on
- History: futures onboard ~**2025-12-11** (~7mo / 21k bars) — **multi-year cert impossible**

## Phase 0 results

| Profile | n | tw/wk | WR | FULL | OOS | Verdict |
|---------|---|-------|-----|------|-----|---------|
| sweep_default | 38 | 1.23 | 21% | **−43%** | **−21%** | RED |
| practical_ict | 27 | 0.87 | 22% | **−34%** | **−8%** | RED |
| practical_inducement | 13 | 0.42 | 23% | −15% | −2% | RED / thin |
| research_preset | 13 | 0.42 | 23% | −17% | −3% | RED / thin |
| guide_mss_kz | **5** | 0.16 | 40% | +6.1% | +3.6% | **THIN** (oosN=2) |

Script: `research-smc-xau-phase0.mjs` → `.smc-xau-phase0.json`

## Decision

**`REJECT_PHASE0`** — same pattern as BTC: reclaim/sweep and practical ICT bleed
with usable N; guide stack only “green” on **n=5 / oosN=2** (anecdote, not edge).

Do **not** paper-size. Do **not** treat short-window guide green as live readiness.
Do **not** chase XAU SMC optimization on ~7mo history.

## Why (same failure mode)

Negative expectancy at deployable-ish frequency (WR ~21–23%, PF ~0.11–0.18).
Tightening (MSS+KZ+PD) starves to n&lt;10. Same structural miss as BTC — not a
gold-specific bug to knob-fix.

## Next

Park XAU SMC with XAU VP (`2026-07-27-xau-vp-freq-reject.md`). Reopen only if
(1) multi-year XAU history exists, or (2) a new **named** failure-mode hypothesis
with one change — not another preset grid on this window.
