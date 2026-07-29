/**
 * Completed 1H structure narrative + dealing-range POI for SMC 1H→15m.
 *
 * Design (frequency-preserving): 1H is active *context*, not one-shot gate.
 * While bias/POI is valid, multiple 15m entries may fire.
 *
 * Lookahead: only completed 1H buckets (forming hour excluded), same discipline
 * as buildCompleted4hBars.
 */

import { detectMarketBos, detectMarketChoch } from "./bosChoch.js";
import { passesDisplacementAt } from "./displacement.js";
import { passesPremiumDiscount } from "./dealingRange.js";

const H1_MS = 60 * 60 * 1000;

/** @typedef {'BULLISH'|'BEARISH'|'NEUTRAL'|'UNKNOWN'} H1StructureState */

/**
 * Completed 1H OHLC from chart candles (forming bucket excluded).
 * @param {object[]} candles
 */
export function buildCompleted1hBars(candles) {
  const out = [];
  if (!candles?.length) return out;

  let curBucket = null;
  /** @type {{ ts: number, open: number, high: number, low: number, close: number, closeChartIdx: number } | null} */
  let cur = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const bucket = Math.floor(c.ts / H1_MS) * H1_MS;
    if (curBucket == null) {
      curBucket = bucket;
      cur = {
        ts: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        closeChartIdx: i,
      };
    } else if (bucket !== curBucket) {
      out.push({ ...cur, closeChartIdx: i - 1 });
      curBucket = bucket;
      cur = {
        ts: bucket,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        closeChartIdx: i,
      };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.closeChartIdx = i;
    }
  }
  // Do not push forming bucket — incomplete hour excluded.
  return out;
}

/**
 * Per-chart-bar 1H narrative: structure bias + dealing range from completed 1H.
 * @param {object[]} candles
 * @param {object} [opts]
 */
export function buildHtf1hNarrativeSeries(candles, opts = {}) {
  const n = candles?.length ?? 0;
  const h1StructureUp = new Array(n).fill(false);
  const h1StructureDown = new Array(n).fill(false);
  /** @type {H1StructureState[]} */
  const h1StructureState = new Array(n).fill("UNKNOWN");
  const h1DrHigh = new Array(n).fill(null);
  const h1DrLow = new Array(n).fill(null);
  const h1DrEq = new Array(n).fill(null);
  /** @type {(string|null)[]} */
  const h1LastEvent = new Array(n).fill(null);

  if (!n) {
    return {
      h1StructureUp,
      h1StructureDown,
      h1StructureState,
      h1DrHigh,
      h1DrLow,
      h1DrEq,
      h1LastEvent,
    };
  }

  const completed = buildCompleted1hBars(candles);
  if (!completed.length) {
    return {
      h1StructureUp,
      h1StructureDown,
      h1StructureState,
      h1DrHigh,
      h1DrLow,
      h1DrEq,
      h1LastEvent,
    };
  }

  const swingOpts = {
    intradaySmcSwingLeft: Math.max(2, Number(opts.intradaySmcH1SwingLeft ?? 2)),
    intradaySmcSwingRight: Math.max(2, Number(opts.intradaySmcH1SwingRight ?? 2)),
    intradaySmcSwingConfirmBars: 1,
  };
  const neutralBars = Math.max(0, Math.min(4, Number(opts.intradaySmcH1StructureNeutralBars ?? 1)));
  const requireDisp = opts.intradaySmcH1ChochRequireDisplacement !== false;
  const drLookback = Math.max(6, Number(opts.intradaySmcH1DealingRangeLookback ?? 24));

  /** @type {H1StructureState} */
  let state = "UNKNOWN";
  let neutralUntil = -1;
  let lastEvent = null;

  const h1Rows = completed.map((b) => ({
    ts: b.ts,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: 0,
  }));

  /** @type {{ from: number, to: number, state: H1StructureState, event: string|null, drHigh: number, drLow: number, drEq: number }[]} */
  const segments = [];

  for (let h1Idx = 0; h1Idx < completed.length; h1Idx++) {
    const slice = h1Rows.slice(0, h1Idx + 1);
    const idx = h1Idx;
    let flipped = false;
    let event = lastEvent;

    const bearChoch = detectMarketChoch(slice, idx, "SELL", {
      ...opts,
      ...swingOpts,
      intradaySmcChochRequireTrend: false,
    });
    const bullChoch = detectMarketChoch(slice, idx, "BUY", {
      ...opts,
      ...swingOpts,
      intradaySmcChochRequireTrend: false,
    });

    if (bearChoch.ok && (!requireDisp || passesDisplacementAt(slice, idx, "SELL", opts))) {
      state = "BEARISH";
      neutralUntil = h1Idx + neutralBars;
      flipped = true;
      event = "choch_bear";
    } else if (bullChoch.ok && (!requireDisp || passesDisplacementAt(slice, idx, "BUY", opts))) {
      state = "BULLISH";
      neutralUntil = h1Idx + neutralBars;
      flipped = true;
      event = "choch_bull";
    }

    if (!flipped) {
      const bullBos = detectMarketBos(slice, idx, "BUY", swingOpts);
      const bearBos = detectMarketBos(slice, idx, "SELL", swingOpts);
      if (bullBos.ok) {
        state = "BULLISH";
        event = "bos_bull";
      } else if (bearBos.ok) {
        state = "BEARISH";
        event = "bos_bear";
      }
    }
    lastEvent = event;

    let effectiveState = state;
    if (flipped && h1Idx <= neutralUntil) effectiveState = "NEUTRAL";

    const drStart = Math.max(0, h1Idx - drLookback + 1);
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = drStart; j <= h1Idx; j++) {
      hi = Math.max(hi, completed[j].high);
      lo = Math.min(lo, completed[j].low);
    }
    const drHigh = Number.isFinite(hi) ? hi : completed[h1Idx].high;
    const drLow = Number.isFinite(lo) ? lo : completed[h1Idx].low;
    const drEq = (drHigh + drLow) / 2;

    const from = completed[h1Idx].closeChartIdx;
    const to =
      h1Idx + 1 < completed.length ? completed[h1Idx + 1].closeChartIdx - 1 : n - 1;
    segments.push({
      from,
      to,
      state: effectiveState,
      event,
      drHigh,
      drLow,
      drEq,
    });
  }

  for (const seg of segments) {
    for (let i = seg.from; i <= seg.to && i < n; i++) {
      h1StructureState[i] = seg.state;
      h1StructureUp[i] = seg.state === "BULLISH";
      h1StructureDown[i] = seg.state === "BEARISH";
      h1DrHigh[i] = seg.drHigh;
      h1DrLow[i] = seg.drLow;
      h1DrEq[i] = seg.drEq;
      h1LastEvent[i] = seg.event;
    }
  }

  return {
    h1StructureUp,
    h1StructureDown,
    h1StructureState,
    h1DrHigh,
    h1DrLow,
    h1DrEq,
    h1LastEvent,
  };
}

export function resolveRequireHtfNarrative(opts = {}) {
  return opts.intradaySmcRequireHtfNarrative === true;
}

export function resolveHtfPoiMode(opts = {}) {
  const m = String(opts.intradaySmcHtfPoiMode ?? "none").toLowerCase();
  if (m === "dealing_range" || m === "last_fvg_ob") return m;
  return "none";
}

/**
 * Soft narrative allow: block only hard opposite bias.
 * NEUTRAL/UNKNOWN do not block (keeps multi-entry frequency).
 */
export function h1StructureAllowsSide(side, narr, idx) {
  const state = narr?.h1StructureState?.[idx] ?? "UNKNOWN";
  if (state === "NEUTRAL" || state === "UNKNOWN") return true;
  if (side === "BUY") return state !== "BEARISH";
  return state !== "BULLISH";
}

/**
 * Strict: BUY only in BULLISH 1H, SELL only in BEARISH (NEUTRAL/UNKNOWN deny).
 * Use for narrative-aligned raid when soft still fights continuation.
 */
export function h1StructureAllowsSideStrict(side, narr, idx) {
  const state = narr?.h1StructureState?.[idx] ?? "UNKNOWN";
  if (side === "BUY") return state === "BULLISH";
  return state === "BEARISH";
}

export function resolveHtfNarrativeStrictness(opts = {}) {
  const s = String(opts.intradaySmcHtfNarrativeStrictness ?? "soft").toLowerCase();
  return s === "strict" ? "strict" : "soft";
}

/**
 * @param {'BUY'|'SELL'} side
 * @param {object} pre
 * @param {number} idx
 * @param {number} price
 * @param {object} [opts]
 */
export function passesHtf1hNarrative(side, pre, idx, price, opts = {}) {
  if (!resolveRequireHtfNarrative(opts)) return true;
  const narr = pre._smcH1Narr ?? pre._smcHtf;
  if (!narr?.h1StructureState) return true;

  const strictness = resolveHtfNarrativeStrictness(opts);
  const sideOk =
    strictness === "strict"
      ? h1StructureAllowsSideStrict(side, narr, idx)
      : h1StructureAllowsSide(side, narr, idx);
  if (!sideOk) return false;

  const poi = resolveHtfPoiMode(opts);
  if (poi === "dealing_range") {
    const high = narr.h1DrHigh?.[idx];
    const low = narr.h1DrLow?.[idx];
    const equilibrium = narr.h1DrEq?.[idx];
    if (!(high > low) || !Number.isFinite(equilibrium)) return true;
    const dr = { high, low, equilibrium, range: high - low };
    return passesPremiumDiscount(side, price, dr, {
      ...opts,
      intradaySmcPremiumDiscountOte: false,
      intradaySmcPremiumDiscountTolPct: Number(opts.intradaySmcH1PoiTolPct ?? 0.02),
    });
  }
  return true;
}

export function getHtf1hNarrativeMeta(pre, idx) {
  const narr = pre._smcH1Narr ?? pre._smcHtf;
  if (!narr?.h1StructureState) {
    return {
      h1StructureState: null,
      h1LastEvent: null,
      h1DrHigh: null,
      h1DrLow: null,
      h1DrEq: null,
    };
  }
  return {
    h1StructureState: narr.h1StructureState[idx] ?? null,
    h1LastEvent: narr.h1LastEvent?.[idx] ?? null,
    h1DrHigh: narr.h1DrHigh?.[idx] ?? null,
    h1DrLow: narr.h1DrLow?.[idx] ?? null,
    h1DrEq: narr.h1DrEq?.[idx] ?? null,
  };
}

/** Attach 1H narrative onto pre (alongside 4H bias). */
export function attachHtf1hNarrativeToPre(candles, pre, opts = {}) {
  const series = buildHtf1hNarrativeSeries(candles, opts);
  pre._smcH1Narr = series;
  if (pre._smcHtf) {
    Object.assign(pre._smcHtf, series);
  }
  return pre;
}
