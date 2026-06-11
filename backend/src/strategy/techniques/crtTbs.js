/**
 * CRT + TBS — Candle Range Theory with Turtle Body Soup entry (ICT/SMC).
 *
 * ICT flow (operational):
 *  1. HTF reference candle → CRT high / low / EQ
 *  2. LTF sweep of CRT extreme during session (killzone on TBS bar)
 *  3. Turtle Body Soup confirms manipulation
 *  4. CHoCH / MSS within N bars AFTER TBS → entry (not same-bar only)
 *  5. TP1 @ EQ, TP2 @ opposite CRT extreme
 */

import { rejectionWickRatio, sweepReclaim, utcDayId } from "./liquidity.js";
import { inSmcKillzone } from "./sessionKillzones.js";
import { detectChochInRange, detectMssInRange, detectMarketBos } from "./bosChoch.js";
import { precomputeIntraday } from "../intradayPro.js";

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/** Bars skipped at series start; worker pads lookback so short windows still work. */
export const CRT_TBS_WARMUP = 48;
/** Minimum candle lookback when loading backtest data (~5 days on 15m). */
export const CRT_TBS_PAD_BARS = 480;

export const CRT_TBS_DEFAULTS = Object.freeze({
  crtHtfMs: FOUR_HOURS_MS,
  sweepPct: 0.0006,
  slBufferPct: 0.0015,
  minTbsWick: 0.32,
  minBodyRatio: 0.25,
  minCrtRangeAtr: 0.4,
  minCrtRangePct: 0.0025,
  requireChoch: true,
  requireMss: false,
  chochMaxBars: 8,
  mssMaxBars: 6,
  maxTradesPerDay: 2,
  minBarGap: 4,
  partialFrac: 0.5,
  tp1AtEq: true,
  tp2AtOpposite: true,
  intradaySmcKillzoneEnabled: true,
  intradaySmcKillzoneMode: "LONDON_NY",
  /** Require killzone on TBS (manipulation) bar, not necessarily on entry bar. */
  killzoneOnTbsBar: true,
  intradaySmcChochRequireTrend: false,
  intradaySmcPreferFirstStructure: true,
  intradaySmcMssRequireDisplacement: true,
  tradeSides: "BOTH",
  premiumDiscountFilter: true,
  /** choch | bos | choch_or_bos | none — structure confirm after TBS */
  structureMode: "choch",
  /** Long entries must close at/below CRT EQ; shorts at/above EQ */
  requireEntryBelowEq: false,
  /** Minimum R:R to TP2 (opposite CRT extreme); 0 = disabled */
  minRrToTp2: 0,
});

function aggregateToHtf(candles, bucketMs) {
  if (!candles.length) return [];
  const out = [];
  let cur = null;
  for (const c of candles) {
    const bts = Math.floor(c.ts / bucketMs) * bucketMs;
    if (!cur || cur.ts !== bts) {
      if (cur) out.push(cur);
      cur = {
        ts: bts,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: Number(c.volume) || 0,
      };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += Number(c.volume) || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function htfIdxFor(htfCandles, barTs) {
  let lo = 0;
  let hi = htfCandles.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (htfCandles[mid].ts <= barTs) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export function isTurtleBodySoup(bar, level, side, opts = {}) {
  if (!Number.isFinite(level) || level <= 0) return false;
  const sweepPct = Number(opts.sweepPct ?? CRT_TBS_DEFAULTS.sweepPct);
  if (!sweepReclaim(bar, level, side, sweepPct)) return false;

  const minWick = Number(opts.minTbsWick ?? CRT_TBS_DEFAULTS.minTbsWick);
  if (rejectionWickRatio(bar, side) < minWick) return false;

  const range = Math.max(1e-12, bar.high - bar.low);
  const body = Math.abs(bar.close - bar.open);
  if (body / range < Number(opts.minBodyRatio ?? CRT_TBS_DEFAULTS.minBodyRatio)) return false;

  if (side === "BUY") return bar.close > level;
  return bar.close < level;
}

export function isTurtleWickSoup(bar, level, side, opts = {}) {
  const sweepPct = Number(opts.sweepPct ?? CRT_TBS_DEFAULTS.sweepPct);
  if (!Number.isFinite(level) || level <= 0) return false;
  const swept =
    side === "BUY"
      ? bar.low < level * (1 - sweepPct)
      : bar.high > level * (1 + sweepPct);
  if (!swept) return false;
  const bodyTop = Math.max(bar.open, bar.close);
  const bodyBot = Math.min(bar.open, bar.close);
  if (side === "BUY") return bodyBot > level;
  return bodyTop < level;
}

export function buildCrtBrackets(side, entry, sweepWick, crtHigh, crtLow, opts = {}) {
  const fill = Number(entry);
  const wick = Number(sweepWick);
  const hi = Number(crtHigh);
  const lo = Number(crtLow);
  if (!(fill > 0) || !(hi > lo) || !Number.isFinite(wick)) return null;

  const buf = Number(opts.slBufferPct ?? CRT_TBS_DEFAULTS.slBufferPct);
  const eq = (hi + lo) / 2;
  const tradeSide = side === "BUY" ? "BUY" : "SELL";

  let slPrice;
  let tp1Price = eq;
  let tp2Price = tradeSide === "BUY" ? hi : lo;

  if (tradeSide === "BUY") {
    slPrice = wick * (1 - buf);
    if (!(slPrice < fill)) return null;
  } else {
    slPrice = wick * (1 + buf);
    if (!(slPrice > fill)) return null;
  }

  const risk = Math.abs(fill - slPrice);
  if (!(risk > 0)) return null;

  if (tradeSide === "BUY") {
    if (tp1Price <= fill) tp1Price = fill + risk * 0.5;
    if (!(tp1Price > fill) || !(tp2Price > fill)) return null;
  } else {
    if (tp1Price >= fill) tp1Price = fill - risk * 0.5;
    if (!(tp1Price < fill) || !(tp2Price < fill)) return null;
  }

  return {
    slPct: risk / fill,
    tpPct: Math.abs(tp2Price - fill) / fill,
    tp1Pct: Math.abs(tp1Price - fill) / fill,
    slPrice,
    tpPrice: tp2Price,
    tp1Price,
    tp2Price,
    partialTp: opts.tp1AtEq !== false,
    tp2Enabled: opts.tp2AtOpposite !== false,
    partialFrac: Number(opts.partialFrac ?? CRT_TBS_DEFAULTS.partialFrac),
    rr: Math.abs(tp2Price - fill) / risk,
    tpMode: "crt_structure",
    levelType: "crt_range",
    level: tradeSide === "BUY" ? lo : hi,
    sweepWick: wick,
    opposingLevel: tradeSide === "BUY" ? hi : lo,
    crtHigh: hi,
    crtLow: lo,
    crtEq: eq,
  };
}

export function buildCrtContext(candles, opts = {}) {
  const o = { ...CRT_TBS_DEFAULTS, ...opts };
  const bucketMs = Number(o.crtHtfMs) || FOUR_HOURS_MS;
  const htf = aggregateToHtf(candles, bucketMs);
  const n = candles.length;
  const crtHigh = new Array(n).fill(NaN);
  const crtLow = new Array(n).fill(NaN);
  const crtEq = new Array(n).fill(NaN);
  const crtTs = new Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    const raw = htfIdxFor(htf, candles[i].ts);
    const refIdx = raw - 1;
    if (refIdx >= 0 && htf[refIdx]) {
      crtHigh[i] = htf[refIdx].high;
      crtLow[i] = htf[refIdx].low;
      crtEq[i] = (htf[refIdx].high + htf[refIdx].low) / 2;
      crtTs[i] = htf[refIdx].ts;
    }
  }

  return { crtHigh, crtLow, crtEq, crtTs, htf, opts: o };
}

function crtRangeOk(crtHigh, crtLow, atr, close, opts) {
  const range = crtHigh - crtLow;
  if (!(range > 0)) return false;
  const minPct = Number(opts.minCrtRangePct ?? CRT_TBS_DEFAULTS.minCrtRangePct);
  if (range / close < minPct) return false;
  if (Number.isFinite(atr) && atr > 0) {
    const minAtr = Number(opts.minCrtRangeAtr ?? CRT_TBS_DEFAULTS.minCrtRangeAtr);
    if (range < minAtr * atr) return false;
  }
  return true;
}

function firstBosInRange(candles, fromIdx, toIdx, side, opts) {
  const lo = Math.max(0, Math.floor(fromIdx));
  const hi = Math.min(candles.length - 1, Math.floor(toIdx));
  for (let m = lo; m <= hi; m++) {
    const r = detectMarketBos(candles, m, side, opts);
    if (r.ok) {
      return { ok: true, bosIdx: m, bosLevel: r.bosLevel, type: r.type };
    }
  }
  return { ok: false, bosIdx: -1, bosLevel: 0, type: null };
}

export function resolveCrtStructureMode(opts = {}) {
  // Legacy boolean flags win over default structureMode from CRT_TBS_DEFAULTS spread.
  if (opts.requireChoch === false && opts.requireMss !== true) return "none";
  if (opts.requireMss === true && opts.requireChoch === false) return "mss";
  if (opts.structureMode) return String(opts.structureMode).toLowerCase();
  return "choch";
}

function structureConfirm(candles, tbsIdx, entryIdx, side, pre, opts) {
  const mode = resolveCrtStructureMode(opts);
  const requireMss = opts.requireMss === true;
  let structOk = mode === "none";

  if (mode === "choch") {
    structOk = detectChochInRange(candles, tbsIdx, entryIdx, side, opts).ok;
  } else if (mode === "bos") {
    structOk = firstBosInRange(candles, tbsIdx, entryIdx, side, opts).ok;
  } else if (mode === "choch_or_bos") {
    structOk =
      detectChochInRange(candles, tbsIdx, entryIdx, side, opts).ok
      || firstBosInRange(candles, tbsIdx, entryIdx, side, opts).ok;
  } else if (mode === "mss") {
    structOk = detectMssInRange(candles, tbsIdx, entryIdx, side, opts, pre).ok;
  }

  if (requireMss && mode !== "mss") {
    structOk = structOk && detectMssInRange(candles, tbsIdx, entryIdx, side, opts, pre).ok;
  }
  return structOk;
}

function entryQualityOk(side, entryClose, eq, br, opts) {
  if (opts.requireEntryBelowEq === true) {
    if (side === "BUY" && entryClose > eq) return false;
    if (side === "SELL" && entryClose < eq) return false;
  }
  const minRr = Number(opts.minRrToTp2 ?? 0);
  if (minRr > 0 && Number(br?.rr) < minRr) return false;
  return true;
}

function killzoneOk(barTs, opts, forTbsBar) {
  if (opts.intradaySmcKillzoneEnabled === false) return true;
  if (forTbsBar && opts.killzoneOnTbsBar === false) return true;
  if (!forTbsBar && opts.killzoneOnTbsBar === true) return true;
  return inSmcKillzone(barTs, opts);
}

function pdOk(side, close, eq, opts) {
  if (opts.premiumDiscountFilter === false) return true;
  if (side === "BUY") return close <= eq;
  return close >= eq;
}

function makeSignal(setup) {
  return {
    action: setup.action,
    reason: `crt_tbs_${setup.trigger}`,
    trigger: setup.trigger,
    playbook: "crt_reversal",
    crtSide: setup.crtSide,
    liqBrackets: setup.liqBrackets,
    score: setup.score,
    tbsIdx: setup.tbsIdx,
  };
}

/** Per-day state: pending TBS setups awaiting CHoCH within N bars. */
export class CrtTbsDayState {
  constructor(opts = {}) {
    this.opts = opts;
    this.reset();
  }

  reset() {
    this.dayId = null;
    this.trades = 0;
    this.lastIdx = -Infinity;
    /** @type {Array<{side, tbsIdx, sweepWick, hi, lo, level, crtSide}>} */
    this.pending = [];
  }

  ensureDay(dayId) {
    if (dayId !== this.dayId) {
      this.reset();
      this.dayId = dayId;
    }
  }

  canTrade(opts = {}) {
    const max = Math.max(1, Number(opts.maxTradesPerDay ?? this.opts.maxTradesPerDay ?? 2));
    return this.trades < max;
  }

  record(idx) {
    this.trades += 1;
    this.lastIdx = idx;
  }

  addPending(p) {
    const maxPending = 4;
    this.pending.push(p);
    if (this.pending.length > maxPending) this.pending.shift();
  }

  expirePending(idx, maxBars) {
    this.pending = this.pending.filter((p) => idx - p.tbsIdx <= maxBars);
  }
}

/**
 * Register new TBS at CRT extreme (manipulation phase).
 */
export function detectPendingTbs(candles, idx, pre, ctx, dayState, opts = {}) {
  const o = { ...CRT_TBS_DEFAULTS, ...opts };
  if (idx < CRT_TBS_WARMUP || !dayState.canTrade(o)) return;

  const bar = candles[idx];
  const hi = ctx.crtHigh[idx];
  const lo = ctx.crtLow[idx];
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return;

  const atr = pre?.atrSeries?.[idx];
  if (!crtRangeOk(hi, lo, atr, bar.close, o)) return;

  const kzOnTbs = o.intradaySmcKillzoneEnabled === false || inSmcKillzone(bar.ts, o);
  if (o.killzoneOnTbsBar !== false && !kzOnTbs) return;

  const eq = (hi + lo) / 2;
  const tradeSides = String(o.tradeSides ?? "BOTH").toUpperCase();
  const chochMax = Math.max(1, Number(o.chochMaxBars ?? 8));

  const trySide = (side, level, crtSide) => {
    if (!isTurtleBodySoup(bar, level, side, o)) return;
    if (!pdOk(side, bar.close, eq, o)) return;
    const dup = dayState.pending.some((p) => p.side === side && idx - p.tbsIdx < chochMax);
    if (dup) return;
    dayState.addPending({
      side,
      tbsIdx: idx,
      sweepWick: side === "BUY" ? bar.low : bar.high,
      hi,
      lo,
      level,
      crtSide,
    });
  };

  if (tradeSides !== "SHORT") trySide("BUY", lo, "low");
  if (tradeSides !== "LONG") trySide("SELL", hi, "high");
}

/**
 * Enter when CHoCH/MSS confirms within window after a pending TBS.
 */
export function tryPendingCrtEntry(candles, idx, pre, dayState, opts = {}) {
  const o = { ...CRT_TBS_DEFAULTS, ...opts };
  if (!dayState.canTrade(o)) return null;

  const bar = candles[idx];
  const chochMax = Math.max(1, Number(o.chochMaxBars ?? 8));
  const gap = Number(o.minBarGap ?? 4);
  if (idx - dayState.lastIdx < gap && dayState.lastIdx >= 0) return null;

  let best = null;

  for (const p of dayState.pending) {
    if (idx < p.tbsIdx) continue;
    if (idx - p.tbsIdx > chochMax) continue;
    if (!structureConfirm(candles, p.tbsIdx, idx, p.side, pre, o)) continue;

    const br = buildCrtBrackets(p.side, bar.close, p.sweepWick, p.hi, p.lo, o);
    if (!br) continue;
    const eq = (p.hi + p.lo) / 2;
    if (!entryQualityOk(p.side, bar.close, eq, br, o)) continue;

    const immediate = idx === p.tbsIdx;
    const trigger =
      p.crtSide === "low"
        ? immediate
          ? "tbs_crt_low"
          : "tbs_crt_low_choch"
        : immediate
          ? "tbs_crt_high"
          : "tbs_crt_high_choch";

    const score = 8 + (immediate ? 1 : 0) + (idx - p.tbsIdx <= 3 ? 1 : 0);
    const cand = {
      action: p.side,
      trigger,
      crtSide: p.crtSide,
      liqBrackets: br,
      score,
      tbsIdx: p.tbsIdx,
    };
    if (!best || cand.score > best.score) best = cand;
  }

  if (!best) return null;
  dayState.pending = dayState.pending.filter((p) => p.tbsIdx !== best.tbsIdx || p.crtSide !== best.crtSide);
  return makeSignal(best);
}

/** @deprecated Use detectPendingTbs + tryPendingCrtEntry */
export function evaluateCrtTbsBar(candles, idx, pre, ctx, dayState, opts = {}) {
  detectPendingTbs(candles, idx, pre, ctx, dayState, opts);
  return tryPendingCrtEntry(candles, idx, pre, dayState, opts);
}

export function buildCrtTbsSeries(candles, cfg = {}) {
  const opts = { ...CRT_TBS_DEFAULTS, ...cfg };
  const pre = cfg.pre || precomputeIntraday(candles);
  const ctx = buildCrtContext(candles, opts);
  const n = candles.length;
  const series = new Array(n).fill(null);
  const dayStates = new Map();
  const chochMax = Math.max(1, Number(opts.chochMaxBars ?? 8));

  for (let i = CRT_TBS_WARMUP; i < n; i++) {
    const bar = candles[i];
    const day = utcDayId(bar.ts);
    if (!dayStates.has(day)) dayStates.set(day, new CrtTbsDayState(opts));
    const dayState = dayStates.get(day);
    dayState.ensureDay(day);
    dayState.expirePending(i, chochMax);

    detectPendingTbs(candles, i, pre, ctx, dayState, opts);
    const entry = tryPendingCrtEntry(candles, i, pre, dayState, opts);
    if (!entry) continue;

    series[i] = entry;
    dayState.record(i);
  }

  return { series, ctx, pre };
}
