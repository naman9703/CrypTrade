/**
 * 4H market-structure bias (BOS/CHoCH) from chart candles — ICT-aligned HTF direction.
 */

import { detectMarketBos, detectMarketChoch } from "./bosChoch.js";
import { passesDisplacementAt } from "./displacement.js";

const H4_MS = 4 * 60 * 60 * 1000;

/** @typedef {'BULLISH'|'BEARISH'|'NEUTRAL'|'UNKNOWN'} H4StructureState */

/**
 * Completed 4H OHLC bars from intraday candles (forming bucket excluded).
 * @param {object[]} candles
 */
export function buildCompleted4hBars(candles) {
  const out = [];
  if (!candles?.length) return out;

  let curBucket = null;
  /** @type {{ ts: number, open: number, high: number, low: number, close: number, closeChartIdx: number } | null} */
  let cur = null;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const bucket = Math.floor(c.ts / H4_MS) * H4_MS;
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
  return out;
}

/**
 * Per-chart-bar 4H structure bias from completed 4H BOS/CHoCH state machine.
 * @param {object[]} candles
 * @param {object} [opts]
 */
export function buildHtfStructureBiasSeries(candles, opts = {}) {
  const n = candles?.length ?? 0;
  const h4StructureUp = new Array(n).fill(false);
  const h4StructureDown = new Array(n).fill(false);
  /** @type {H4StructureState[]} */
  const h4StructureState = new Array(n).fill("UNKNOWN");
  const h4StructureNeutral = new Array(n).fill(false);

  if (!n) {
    return { h4StructureUp, h4StructureDown, h4StructureState, h4StructureNeutral };
  }

  const completed = buildCompleted4hBars(candles);
  if (!completed.length) {
    return { h4StructureUp, h4StructureDown, h4StructureState, h4StructureNeutral };
  }

  const swingOpts = {
    intradaySmcSwingLeft: Math.max(3, Number(opts.intradaySmcHtfSwingLeft ?? 3)),
    intradaySmcSwingRight: Math.max(3, Number(opts.intradaySmcHtfSwingRight ?? 3)),
    intradaySmcSwingConfirmBars: 1,
  };
  const neutralBars = Math.max(1, Math.min(5, Number(opts.intradaySmcHtfStructureNeutralBars ?? 2)));
  const requireDisp = opts.intradaySmcHtfChochRequireDisplacement !== false;

  /** @type {H4StructureState} */
  let state = "UNKNOWN";
  let neutralUntilH4Idx = -1;

  const h4Rows = completed.map((b) => ({
    ts: b.ts,
    open: b.open,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: 0,
  }));

  /** @type {{ from: number, to: number, state: H4StructureState }[]} */
  const segments = [];

  for (let h4Idx = 0; h4Idx < completed.length; h4Idx++) {
    const slice = h4Rows.slice(0, h4Idx + 1);
    const idx = h4Idx;
    let flipped = false;

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

    if (
      bearChoch.ok &&
      (!requireDisp || passesDisplacementAt(slice, idx, "SELL", opts))
    ) {
      state = "BEARISH";
      neutralUntilH4Idx = h4Idx + neutralBars;
      flipped = true;
    } else if (
      bullChoch.ok &&
      (!requireDisp || passesDisplacementAt(slice, idx, "BUY", opts))
    ) {
      state = "BULLISH";
      neutralUntilH4Idx = h4Idx + neutralBars;
      flipped = true;
    }

    if (!flipped) {
      const bullBos = detectMarketBos(slice, idx, "BUY", swingOpts);
      const bearBos = detectMarketBos(slice, idx, "SELL", swingOpts);
      if (bullBos.ok) state = "BULLISH";
      else if (bearBos.ok) state = "BEARISH";
    }

    let effectiveState = state;
    if (flipped && h4Idx <= neutralUntilH4Idx) effectiveState = "NEUTRAL";

    const from = completed[h4Idx].closeChartIdx;
    const to =
      h4Idx + 1 < completed.length
        ? completed[h4Idx + 1].closeChartIdx - 1
        : n - 1;
    segments.push({ from, to, state: effectiveState });
  }

  for (const seg of segments) {
    for (let i = seg.from; i <= seg.to && i < n; i++) {
      h4StructureState[i] = seg.state;
      h4StructureNeutral[i] = seg.state === "NEUTRAL";
      h4StructureUp[i] = seg.state === "BULLISH";
      h4StructureDown[i] = seg.state === "BEARISH";
    }
  }

  return { h4StructureUp, h4StructureDown, h4StructureState, h4StructureNeutral };
}

/**
 * @param {'BUY'|'SELL'} side
 * @param {object} structureSeries
 * @param {number} idx
 */
export function structureBiasAllowsSide(side, structureSeries, idx) {
  const state = structureSeries.h4StructureState?.[idx] ?? "UNKNOWN";
  if (state === "NEUTRAL" || state === "UNKNOWN") return true;
  if (side === "BUY") return state !== "BEARISH";
  return state !== "BULLISH";
}

/**
 * @param {object} smcHtf
 * @param {number} idx
 */
export function htfBiasDisagreement(smcHtf, idx) {
  const emaUp = smcHtf.h4Up?.[idx] === true;
  const emaDown = smcHtf.h4Down?.[idx] === true;
  const stUp = smcHtf.h4StructureUp?.[idx] === true;
  const stDown = smcHtf.h4StructureDown?.[idx] === true;
  if (emaUp && stDown) return true;
  if (emaDown && stUp) return true;
  return false;
}
