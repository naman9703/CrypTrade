# 2026-07-17 — BTC prepared-regime doctrine + bleed-cell lock

## The problem you named

Even if we optimize 2021–22, live will invent **new** regimes. Year-by-year
patching never ends. The setup must know when it is **unprepared** and abstain.

## How this is done (doctrine)

```
Layer 1 — Known unprepared cells → ABSTAIN (locked now)
Layer 2 — Known prepared cells → TRADE
Layer 3 — Unknown / thin cells → default cautious (still tradeable until classified;
          future: allowlist-only or size-down)
Layer 4 — Live novelty kill-switch → if a prepared cell's rolling live expectancy
          turns negative, disable that cell until re-autopsied
```

Cells are **measurable at bar time** (setup × macro × path), never calendar years.

## Matrix evidence (`research-vp-freq-btc-prepared-regime-matrix.mjs`)

Unprepared bleed (multi-year):

| Cell | N | Net | Years |
|------|--:|----:|-------|
| `SELL\|val_breakdown\|bear_trend\|vacuum` | 26 | −$35.4 | 0+/4− |
| `BUY\|vah_breakout\|bull_trend\|vacuum` | 16 | −$10.7 | 1+/4− |

Prepared (enough N, positive):

| Cell | N | Net |
|------|--:|----:|
| `BUY\|vah_breakout\|bull_trend\|structured` | 6 | +$6.2 |
| `SELL\|val_breakdown\|bear_trend\|structured` | 15 | +$7.4 |

## Locked change (`vpPreparedRegimeOnly`)

- Block **vacuum VAH** (any macro)
- Block **vacuum VAL in bear_trend**
- Keep structured VAH/VAL + va_rejection / other non-bleed paths

## Full-sim A/B

| Window | Locked before | Prepared block |
|--------|--------------:|---------------:|
| OOS 2021–22 | 40t / **−34.3%** DD40% | 21t / **−3.9%** DD20% |
| Lock 2022–26 | 56t / **+90.5%** DD24% | 32t / **+115.5%** DD9% (all years ≥0) |
| Full 2021–26 | 99t / **+12.6%** DD40% | 54t / **+83.7%** DD20% |

## Verdict

**LOCK Layer-1 prepared bleed blocks into `VOLUME_PROFILE_FREQ_BTC_15M`.**

Not “perfect for every future regime” — that is impossible by definition — but this is
the correct architecture: **novel/unprepared → refuse**, expand prepared set only with
evidence. Residual 2021–22 bleed is mostly SELL `va_rejection` (next cell to classify).

Frequency still below ≥2/wk; robustness improved without year hardcoding.
Not WF+MC certified / not deploy claim.

## Live implication

When a brand-new regime appears that does not match a prepared cell pattern:

1. If it looks like a known unprepared pattern (e.g. vacuum expansion) → already blocked
2. If it is truly novel → may still trade until classified (Layer 3 gap) or until
   rolling kill-switch (Layer 4, not built yet) trips
3. Autopsy → either add prepared authorization or add unprepared block
