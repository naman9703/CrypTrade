/**
 * Per-UTC-day state machine — bias lock, displacement tracker, loss-streak pause.
 */

import { utcDayId } from "../techniques/liquidity.js";

export class SituationDayState {
  constructor(opts = {}) {
    this.opts = opts;
    this.resetDay(null);
  }

  resetDay(dayId) {
    this.dayId = dayId;
    this.bearBias = false;
    this.bullBias = false;
    this.dispBarIdx = -1;
    this.bullDispBarIdx = -1;
    this.breakLevel = null;
    this.bullBreakLevel = null;
    this.shortLossStreak = 0;
    this.longLossStreak = 0;
    this.dayHigh = -Infinity;
    this.dayLow = Infinity;
    this.dayOpen = null;
    this.exhaustionLongUsed = 0;
    this.exhaustionShortUsed = 0;
    this.tradesToday = 0;
    this.lastTradeBar = -999;
  }

  ensureDay(bar, idx) {
    const d = utcDayId(bar.ts);
    if (d !== this.dayId) this.resetDay(d);
    if (this.dayOpen == null) this.dayOpen = bar.open;
    this.dayHigh = Math.max(this.dayHigh, bar.high);
    this.dayLow = Math.min(this.dayLow, bar.low);
    return d;
  }

  dayRangePct() {
    if (!(this.dayOpen > 0)) return 0;
    return (this.dayHigh - this.dayLow) / this.dayOpen;
  }

  updateBias(candles, idx, pre, bar, opts = {}) {
    const pdl = pre.prevDayLow?.[idx];
    const pdh = pre.prevDayHigh?.[idx];
    const atr = pre.atrSeries?.[idx] ?? 0;
    const volAvg = avgVol(pre.volumes, idx);
    const rvol = volAvg > 0 ? Number(bar.volume) / volAvg : 1;
    const body = Math.abs(bar.close - bar.open);
    const bearDisp = bar.close < bar.open && atr > 0 && body >= (opts.minDispAtr ?? 0.42) * atr;
    const bullDisp = bar.close > bar.open && atr > 0 && body >= (opts.minDispAtr ?? 0.42) * atr;
    const biasRvol = opts.biasRvol ?? 2.5;
    const dispRvol = opts.dispResetRvol ?? 2.0;

    if (pdl > 0 && bar.close < pdl && (bearDisp || rvol >= biasRvol)) {
      this.bearBias = true;
      this.dispBarIdx = idx;
      this.breakLevel = Math.min(this.breakLevel ?? pdl, bar.close);
    }
    if (bearDisp && bar.close < bar.open && rvol >= dispRvol) {
      this.dispBarIdx = idx;
      this.breakLevel = Math.min(this.breakLevel ?? pdl ?? bar.close, bar.close);
      this.shortLossStreak = 0;
    }

    if (pdh > 0 && bar.close > pdh && (bullDisp || rvol >= biasRvol)) {
      this.bullBias = true;
      this.bullDispBarIdx = idx;
      this.bullBreakLevel = Math.max(this.bullBreakLevel ?? pdh, bar.close);
    }
    if (bullDisp && bar.close > bar.open && rvol >= dispRvol) {
      this.bullDispBarIdx = idx;
      this.bullBreakLevel = Math.max(this.bullBreakLevel ?? pdh ?? bar.close, bar.close);
      this.longLossStreak = 0;
    }
  }

  barsSinceDispIdx(idx, side) {
    const ref = side === "SELL" ? this.dispBarIdx : this.bullDispBarIdx;
    return ref >= 0 ? idx - ref : 999;
  }

  canShort(trigger, idx, opts = {}) {
    if (this.shortLossStreak >= (opts.maxLossStreak ?? 2)) {
      if (trigger === "displacement_short" || trigger === "retest_short") return false;
      if (trigger === "lh_fade_short" || trigger === "fail_short") return false;
    }
    if (trigger === "displacement_short" && this.dayRangePct() > (opts.maxDispDayRangePct ?? 0.03)) {
      return false;
    }
    if (idx - this.lastTradeBar < (opts.minBarGap ?? 4)) return false;
    return true;
  }

  canLong(trigger, idx, opts = {}) {
    if (this.longLossStreak >= (opts.maxLossStreak ?? 2)) {
      if (trigger === "displacement_long" || trigger === "retest_long") return false;
    }
    if (trigger === "exhaustion_long" && this.exhaustionLongUsed >= (opts.maxExhaustionPerDay ?? 1)) {
      return false;
    }
    if (trigger === "exhaustion_short" && this.exhaustionShortUsed >= (opts.maxExhaustionPerDay ?? 1)) {
      return false;
    }
    if (idx - this.lastTradeBar < (opts.minBarGap ?? 4)) return false;
    return true;
  }

  recordTrade(idx, side, trigger, won) {
    this.lastTradeBar = idx;
    this.tradesToday += 1;
    if (trigger === "exhaustion_long") this.exhaustionLongUsed += 1;
    if (trigger === "exhaustion_short") this.exhaustionShortUsed += 1;
    if (side === "SELL") {
      this.shortLossStreak = won ? 0 : this.shortLossStreak + 1;
    } else {
      this.longLossStreak = won ? 0 : this.longLossStreak + 1;
    }
  }
}

function avgVol(volumes, idx, lookback = 20) {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, idx - lookback); j < idx; j++) {
    const v = Number(volumes[j]);
    if (Number.isFinite(v) && v > 0) {
      sum += v;
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}
