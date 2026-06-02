/**
 * Build chart markup for a single backtest trade (SMC/ICT anatomy).
 * Used by the trade chart to show swings, sweep, BOS/MSS, FVG, OB.
 */

import { getConfirmedSwings } from "./techniques/marketStructure.js";
import { detectFvgAt } from "./techniques/fairValueGap.js";

function barIndexForTs(candles, iso) {
  const tms = new Date(iso).getTime();
  let idx = candles.findIndex((c) => c.ts === tms);
  if (idx >= 0) return idx;
  let best = 0;
  let bestD = Math.abs(candles[0].ts - tms);
  for (let i = 1; i < candles.length; i++) {
    const d = Math.abs(candles[i].ts - tms);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function barIndexForMs(candles, tsMs) {
  if (tsMs == null || !Number.isFinite(Number(tsMs))) return -1;
  const tms = Number(tsMs);
  let idx = candles.findIndex((c) => c.ts === tms);
  if (idx >= 0) return idx;
  let best = 0;
  let bestD = Math.abs(candles[0].ts - tms);
  for (let i = 1; i < candles.length; i++) {
    const d = Math.abs(candles[i].ts - tms);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function sec(candles, idx) {
  if (idx < 0 || idx >= candles.length) return null;
  return Math.floor(candles[idx].ts / 1000);
}

/**
 * @param {object[]} candles OHLC rows with ts ms
 * @param {object} trade backtest trade row (direction, entryTs, exitTs, liqContext)
 * @param {object} [opts] SMC swing opts from bot snapshot
 */
export function buildSmcTradeMarkup(candles, trade, opts = {}) {
  if (!candles?.length || !trade) return null;

  const entryIdx = barIndexForTs(candles, trade.entryTs);
  const exitIdx = barIndexForTs(candles, trade.exitTs);
  const lo = Math.min(entryIdx, exitIdx);
  const hi = Math.max(entryIdx, exitIdx);
  const pad = Math.max(20, Number(opts.markupPadBars ?? 40));
  const windowStart = Math.max(0, lo - pad);
  const windowEnd = Math.min(candles.length - 1, hi + pad);

  const liq = trade.liqContext && typeof trade.liqContext === "object" ? trade.liqContext : {};
  const meta = liq.smcMeta && typeof liq.smcMeta === "object" ? liq.smcMeta : {};
  const side = trade.direction === "SELL" ? "SELL" : "BUY";

  const swings = [];
  const swingEnd = Math.max(entryIdx, meta.entryIdx ?? entryIdx);
  const { highs, lows } = getConfirmedSwings(candles, swingEnd, opts);
  const recentHighs = highs.filter((s) => s.pivotIdx >= windowStart && s.pivotIdx <= windowEnd).slice(-6);
  const recentLows = lows.filter((s) => s.pivotIdx >= windowStart && s.pivotIdx <= windowEnd).slice(-6);
  for (const s of recentHighs) {
    swings.push({
      kind: "swing_high",
      pivotIdx: s.pivotIdx,
      timeSec: sec(candles, s.pivotIdx),
      price: s.price,
      label: "SH",
    });
  }
  for (const s of recentLows) {
    swings.push({
      kind: "swing_low",
      pivotIdx: s.pivotIdx,
      timeSec: sec(candles, s.pivotIdx),
      price: s.price,
      label: "SL",
    });
  }

  const sweepReclaimIdx =
    meta.sweepReclaimTs != null
      ? barIndexForMs(candles, meta.sweepReclaimTs)
      : meta.sweepReclaimIdx != null
        ? Number(meta.sweepReclaimIdx)
        : entryIdx;
  const sweepStartIdx =
    meta.sweepStartTs != null
      ? barIndexForMs(candles, meta.sweepStartTs)
      : meta.sweepStartIdx != null
        ? Number(meta.sweepStartIdx)
        : Math.max(0, sweepReclaimIdx - 8);
  const sweepLevel = Number(meta.sweepLevel ?? liq.level ?? 0);
  const sweepWick = Number(liq.sweepWick ?? meta.sweepWick ?? 0);
  const opposing = Number(liq.opposingLevel ?? 0);

  let sweepWickIdx = sweepStartIdx;
  if (side === "BUY") {
    for (let j = sweepStartIdx; j <= sweepReclaimIdx; j++) {
      if (candles[j].low <= sweepWick) sweepWickIdx = j;
    }
  } else {
    for (let j = sweepStartIdx; j <= sweepReclaimIdx; j++) {
      if (candles[j].high >= sweepWick) sweepWickIdx = j;
    }
  }

  const chochIdx =
    meta.chochTs != null
      ? barIndexForMs(candles, meta.chochTs)
      : meta.chochIdx != null
        ? Number(meta.chochIdx)
        : null;
  const chochLevel = Number(meta.chochLevel ?? 0);

  const mssIdx =
    meta.mssTs != null
      ? barIndexForMs(candles, meta.mssTs)
      : meta.mssIdx != null
        ? Number(meta.mssIdx)
        : null;
  const bosLevel = Number(meta.bosLevel ?? 0);

  let fvg = null;
  const fvgTop = Number(meta.fvgTop ?? 0);
  const fvgBottom = Number(meta.fvgBottom ?? 0);
  if (fvgTop > 0 && fvgBottom > 0) {
    const formedIdx =
      meta.fvgFormedTs != null
        ? barIndexForMs(candles, meta.fvgFormedTs)
        : meta.fvgFormedIdx != null
          ? Number(meta.fvgFormedIdx)
          : mssIdx ?? sweepReclaimIdx;
    const top = Math.max(fvgTop, fvgBottom);
    const bottom = Math.min(fvgTop, fvgBottom);
    fvg = {
      top,
      bottom,
      fromIdx: Math.max(0, formedIdx - 1),
      toIdx: Math.min(candles.length - 1, entryIdx + 5),
      fromTimeSec: sec(candles, Math.max(0, formedIdx - 1)),
      toTimeSec: sec(candles, Math.min(candles.length - 1, entryIdx + 5)),
      label: "FVG",
    };
  } else if (mssIdx != null) {
    const detected = detectFvgAt(candles, mssIdx, side, opts);
    if (detected) {
      fvg = {
        top: Math.max(detected.top, detected.bottom),
        bottom: Math.min(detected.top, detected.bottom),
        fromIdx: Math.max(0, detected.formedIdx - 1),
        toIdx: Math.min(candles.length - 1, entryIdx + 5),
        fromTimeSec: sec(candles, Math.max(0, detected.formedIdx - 1)),
        toTimeSec: sec(candles, Math.min(candles.length - 1, entryIdx + 5)),
        label: "FVG",
      };
    }
  }

  let ob = null;
  const obTop = Number(meta.obTop ?? 0);
  const obBottom = Number(meta.obBottom ?? 0);
  if (obTop > 0 && obBottom > 0) {
    const obIdx =
      meta.obTs != null
        ? barIndexForMs(candles, meta.obTs)
        : meta.obIdx != null
          ? Number(meta.obIdx)
          : Math.max(0, (mssIdx ?? entryIdx) - 1);
    const obEndIdx =
      meta.obDispTs != null
        ? barIndexForMs(candles, meta.obDispTs)
        : meta.obDisplacementIdx != null
          ? Number(meta.obDisplacementIdx)
          : mssIdx ?? entryIdx;
    ob = {
      top: Math.max(obTop, obBottom),
      bottom: Math.min(obTop, obBottom),
      fromIdx: obIdx,
      toIdx: Math.min(candles.length - 1, obEndIdx),
      fromTimeSec: sec(candles, obIdx),
      toTimeSec: sec(candles, Math.min(candles.length - 1, meta.obDisplacementIdx ?? mssIdx ?? entryIdx)),
      label: "OB",
    };
  }

  const hlines = [];
  if (sweepLevel > 0) {
    hlines.push({
      price: sweepLevel,
      fromIdx: sweepStartIdx,
      toIdx: sweepReclaimIdx,
      color: "#f472b6",
      label: `Sweep ${meta.levelType ?? liq.levelType ?? "liq"}`,
      style: "dotted",
    });
  }
  if (sweepWick > 0) {
    hlines.push({
      price: sweepWick,
      fromIdx: sweepWickIdx,
      toIdx: entryIdx,
      color: "#fb7185",
      label: "Sweep wick (SL ref)",
      style: "dashed",
    });
  }
  if (opposing > 0) {
    hlines.push({
      price: opposing,
      fromIdx: sweepReclaimIdx,
      toIdx: exitIdx,
      color: "#c084fc",
      label: "Opposing liquidity",
      style: "dotted",
    });
  }
  if (chochLevel > 0 && chochIdx != null && chochIdx >= 0) {
    hlines.push({
      price: chochLevel,
      fromIdx: Math.max(0, chochIdx - 2),
      toIdx: Math.min(candles.length - 1, chochIdx + 8),
      color: "#e879f9",
      label: meta.chochType ? String(meta.chochType).replace(/_/g, " ").toUpperCase() : "CHoCH",
      style: "dashed",
    });
  }
  if (bosLevel > 0 && mssIdx != null) {
    hlines.push({
      price: bosLevel,
      fromIdx: Math.max(0, mssIdx - 3),
      toIdx: Math.min(candles.length - 1, mssIdx + 12),
      color: "#38bdf8",
      label: meta.bosType ? String(meta.bosType).replace(/_/g, " ").toUpperCase() : "BOS/MSS",
      style: "solid",
    });
  }

  const events = [];
  if (sweepWickIdx >= 0) {
    events.push({
      kind: "sweep",
      idx: sweepWickIdx,
      timeSec: sec(candles, sweepWickIdx),
      price: side === "BUY" ? candles[sweepWickIdx].low : candles[sweepWickIdx].high,
      label: "Sweep",
    });
  }
  if (sweepReclaimIdx >= 0) {
    events.push({
      kind: "reclaim",
      idx: sweepReclaimIdx,
      timeSec: sec(candles, sweepReclaimIdx),
      price: candles[sweepReclaimIdx].close,
      label: "Reclaim",
    });
  }
  if (chochIdx != null && chochIdx >= 0) {
    events.push({
      kind: "choch",
      idx: chochIdx,
      timeSec: sec(candles, chochIdx),
      price: chochLevel > 0 ? chochLevel : candles[chochIdx].close,
      label: "CHoCH",
    });
  }
  if (mssIdx != null && mssIdx >= 0) {
    events.push({
      kind: "bos",
      idx: mssIdx,
      timeSec: sec(candles, mssIdx),
      price: bosLevel > 0 ? bosLevel : candles[mssIdx].close,
      label: "MSS/BOS",
    });
  }
  events.push({
    kind: "entry",
    idx: entryIdx,
    timeSec: sec(candles, entryIdx),
    price: Number(trade.entryPrice),
    label: "Entry",
  });

  return {
    side,
    entryIdx,
    exitIdx,
    focusFromIdx: windowStart,
    focusToIdx: windowEnd,
    focusFromTimeSec: sec(candles, windowStart),
    focusToTimeSec: sec(candles, windowEnd),
    swings,
    sweep: {
      level: sweepLevel,
      wick: sweepWick,
      levelType: meta.levelType ?? liq.levelType ?? null,
      sweepStartIdx,
      sweepWickIdx,
      reclaimIdx: sweepReclaimIdx,
      levelTimeSec: sec(candles, sweepStartIdx),
      wickTimeSec: sec(candles, sweepWickIdx),
      reclaimTimeSec: sec(candles, sweepReclaimIdx),
    },
    bos:
      mssIdx != null && bosLevel > 0
        ? { idx: mssIdx, price: bosLevel, type: meta.bosType ?? null, timeSec: sec(candles, mssIdx) }
        : null,
    fvg,
    ob,
    hlines,
    events,
    legend: [
      "SH/SL = confirmed swing high/low",
      "Pink = liquidity sweep level",
      "Rose = sweep wick",
      "Sky = BOS / market structure shift",
      "Violet band = FVG",
      "Amber band = order block",
      "Purple = opposing liquidity (TP pool)",
    ],
  };
}
