# LIQ_CASCADE — one-shot detection + confirm ladder (2026-07-31)

## Hypothesis

Jul 30 ETH loss was a **late chase**: displacement passed **after** the liq bar closed (13:40 → 13:43), not a gate failure. Re-arming cascade on every candle let post-close continuation inflate disp and enter into the wrong side of the move.

## One change

1. **One-shot detection** at liq bar close only — `computeInBarDisplacement()` (open→close of liq bar span); `detectionAttempted` Set prevents retries.
2. **Two-tier confirm ladder**:
   - **Tier A:** in-bar disp ≥ 2.0 ATR → enter bar close or +1 bar
   - **Tier B:** disp 1.0–2.0 ATR → stall/reclaim OR liq exhaustion within confirm window

Presets: `liqCascadeConfirmMode: ladder`, `liqCascadeStrongDispAtr: 2.0`.

## Expected effect

- Block Jul 30 ETH $395k event (in-bar disp ~0.22 ATR at close).
- Keep Jul 29 cascade-eligible cluster (strong in-bar disp → Tier A immediate).
- No N-crush — same liq/OI gates; only fixes timing correctness.

## Validation (partial tick data ~1.6–2d)

```bash
node --test src/strategy/techniques/liqCascade.test.mjs  # PASS
DAYS=30 LIQ_SOURCE=force_orders node scripts/research-liq-cascade-30d-event-autopsy.mjs
DAYS=30 LIQ_SOURCE=force_orders node scripts/research-liq-cascade-last10h-signals.mjs
```

### Results

| Check | Before (either confirm) | After (ladder + one-shot) |
|-------|-------------------------|---------------------------|
| Jul 30 ETH 13:40 $395k | **1 signal** (late chase, SL −0.28%) | **0 signals** (in-bar disp 0.22 ATR, dispPass false) |
| Raw signals (30d window) | 1 | **0** |
| Cascade-eligible events | 6 | 6 |
| Strategy trades | 1 LOSS | 0 |

Jul 29 Tier-A eligible events (e.g. ETH 04:05 disp 2.52) still show `eligible_no_confirm` — likely **minRr bracket** or stale-cascade queue during fast clusters; next hypothesis (not this change).

Data quality: **partial** (~6% of 30d window, ~1.8d ticks) — no promote language until ≥8 weeks force_orders per coin.

## Status

**CHECKPOINT** — timing bug fixed (Jul 30 blocked). Tier-A cluster entry + bracket pass rate = next iteration.
