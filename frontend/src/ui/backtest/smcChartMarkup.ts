/**
 * SMC/ICT trade chart markup — swings, sweep, BOS, FVG, OB (time-aligned to stored candles).
 */
import { LineStyle, type LineData, type SeriesMarker, type UTCTimestamp } from "lightweight-charts";
import type { BacktestTrade } from "../../types/backtest";
import { barIndexForMs, type OhlcCandle } from "./backtestChartTime";
import type { BacktestLiqContext } from "./backtestChartOverlays";
import type { ChartOverlayLayerId } from "./backtestChartOverlayLayers";

export type SmcSwingPoint = {
  kind: "swing_high" | "swing_low";
  pivotIdx: number;
  timeSec: number | null;
  price: number;
  label: string;
};

export type SmcChartMarkup = {
  side: "BUY" | "SELL";
  entryIdx: number;
  exitIdx: number;
  focusFromIdx: number;
  focusToIdx: number;
  swings: SmcSwingPoint[];
  sweep: {
    level: number;
    wick: number;
    levelType: string | null;
    sweepStartIdx: number;
    sweepWickIdx: number;
    reclaimIdx: number;
  };
  bos: { idx: number; price: number; type: string | null; timeSec: number | null } | null;
  fvg: { top: number; bottom: number; fromIdx: number; toIdx: number } | null;
  ob: { top: number; bottom: number; fromIdx: number; toIdx: number } | null;
  hlines: Array<{
    price: number;
    fromIdx: number;
    toIdx: number;
    color: string;
    label: string;
    lineStyle: "solid" | "dashed" | "dotted";
    layer?: ChartOverlayLayerId;
  }>;
  events: Array<{ kind: string; idx: number; timeSec: number | null; price: number; label: string }>;
  legend: string[];
};

type SwingOpts = { left: number; right: number; confirmBars: number };

function resolveSwingOpts(bot: Record<string, unknown>): SwingOpts {
  const left = Math.max(1, Math.floor(Number(bot.intradaySmcSwingLeft ?? 2)));
  const right = Math.max(1, Math.floor(Number(bot.intradaySmcSwingRight ?? 2)));
  const confirmBars = Math.max(1, Math.floor(Number(bot.intradaySmcSwingConfirmBars ?? 2)));
  return { left, right, confirmBars };
}

function isPivotHighAt(candles: OhlcCandle[], p: number, { left, right }: SwingOpts): boolean {
  if (p < left || p + right >= candles.length) return false;
  const h = candles[p].high;
  for (let j = p - left; j <= p + right; j++) {
    if (j === p) continue;
    if (candles[j].high >= h) return false;
  }
  return true;
}

function isPivotLowAt(candles: OhlcCandle[], p: number, { left, right }: SwingOpts): boolean {
  if (p < left || p + right >= candles.length) return false;
  const l = candles[p].low;
  for (let j = p - left; j <= p + right; j++) {
    if (j === p) continue;
    if (candles[j].low <= l) return false;
  }
  return true;
}

function getConfirmedSwings(
  candles: OhlcCandle[],
  fromIdx: number,
  toIdx: number,
  swingOpts: SwingOpts,
) {
  const highs: SmcSwingPoint[] = [];
  const lows: SmcSwingPoint[] = [];
  const lo = Math.max(swingOpts.left, fromIdx);
  const hi = Math.min(toIdx, candles.length - 1);
  const maxPivot = hi - swingOpts.confirmBars;
  for (let p = lo; p <= maxPivot; p++) {
    if (isPivotHighAt(candles, p, swingOpts)) {
      highs.push({
        kind: "swing_high",
        pivotIdx: p,
        timeSec: Math.floor(candles[p].ts / 1000),
        price: candles[p].high,
        label: "SH",
      });
    }
    if (isPivotLowAt(candles, p, swingOpts)) {
      lows.push({
        kind: "swing_low",
        pivotIdx: p,
        timeSec: Math.floor(candles[p].ts / 1000),
        price: candles[p].low,
        label: "SL",
      });
    }
  }
  return { highs, lows };
}

function barIndexForIso(candles: OhlcCandle[], iso: string): number {
  const tms = new Date(iso).getTime();
  return barIndexForMs(candles, tms);
}

function sec(candles: OhlcCandle[], idx: number): number | null {
  if (idx < 0 || idx >= candles.length) return null;
  return Math.floor(candles[idx].ts / 1000);
}

export function buildSmcChartMarkup(
  candles: OhlcCandle[],
  trade: BacktestTrade,
  botOpts: Record<string, unknown> = {},
): SmcChartMarkup | null {
  if (!candles.length || !trade) return null;

  const entryIdx = barIndexForIso(candles, trade.entryTs);
  const exitIdx = barIndexForIso(candles, trade.exitTs);
  const lo = Math.min(entryIdx, exitIdx);
  const hi = Math.max(entryIdx, exitIdx);
  const pad = 40;
  const windowStart = Math.max(0, lo - pad);
  const windowEnd = Math.min(candles.length - 1, hi + pad);

  const liq = (trade.liqContext ?? null) as BacktestLiqContext | null;
  const meta = liq?.smcMeta ?? {};
  const side = trade.direction === "SELL" ? "SELL" : "BUY";

  const swingOpts = resolveSwingOpts(botOpts);
  const swingEnd = Math.min(
    candles.length - 1,
    Math.max(entryIdx, meta.entryIdx != null ? Number(meta.entryIdx) : entryIdx),
  );
  const { highs, lows } = getConfirmedSwings(candles, windowStart, swingEnd, swingOpts);
  const swings = [
    ...highs.filter((s) => s.pivotIdx >= windowStart && s.pivotIdx <= windowEnd).slice(-6),
    ...lows.filter((s) => s.pivotIdx >= windowStart && s.pivotIdx <= windowEnd).slice(-6),
  ];

  const sweepReclaimIdx =
    meta.sweepReclaimTs != null
      ? barIndexForMs(candles, Number(meta.sweepReclaimTs))
      : meta.sweepReclaimIdx != null
        ? Number(meta.sweepReclaimIdx)
        : entryIdx;
  const sweepStartIdx =
    meta.sweepStartTs != null
      ? barIndexForMs(candles, Number(meta.sweepStartTs))
      : meta.sweepStartIdx != null
        ? Number(meta.sweepStartIdx)
        : Math.max(0, sweepReclaimIdx - 8);

  const sweepLevel = Number(meta.sweepLevel ?? liq?.level ?? 0);
  const sweepWick = Number(liq?.sweepWick ?? 0);
  const opposing = Number(liq?.opposingLevel ?? 0);

  let sweepWickIdx =
    meta.sweepWickIdx != null && Number(meta.sweepWickIdx) >= 0
      ? Number(meta.sweepWickIdx)
      : sweepStartIdx;
  if (meta.sweepWickIdx == null && sweepWick > 0) {
    if (side === "BUY") {
      for (let j = sweepStartIdx; j <= sweepReclaimIdx; j++) {
        if (candles[j].low <= sweepWick) sweepWickIdx = j;
      }
    } else {
      for (let j = sweepStartIdx; j <= sweepReclaimIdx; j++) {
        if (candles[j].high >= sweepWick) sweepWickIdx = j;
      }
    }
  }

  const chochIdx =
    meta.chochTs != null
      ? barIndexForMs(candles, Number(meta.chochTs))
      : meta.chochIdx != null
        ? Number(meta.chochIdx)
        : null;
  const chochLevel = Number(meta.chochLevel ?? 0);

  const mssIdx =
    meta.mssTs != null
      ? barIndexForMs(candles, Number(meta.mssTs))
      : meta.mssIdx != null
        ? Number(meta.mssIdx)
        : null;
  const bosLevel = Number(meta.bosLevel ?? 0);

  let fvg: SmcChartMarkup["fvg"] = null;
  const fvgTop = Number(meta.fvgTop ?? 0);
  const fvgBottom = Number(meta.fvgBottom ?? 0);
  if (fvgTop > 0 && fvgBottom > 0) {
    const formedIdx =
      meta.fvgFormedTs != null
        ? barIndexForMs(candles, Number(meta.fvgFormedTs))
        : meta.fvgFormedIdx != null
          ? Number(meta.fvgFormedIdx)
          : mssIdx ?? sweepReclaimIdx;
    fvg = {
      top: Math.max(fvgTop, fvgBottom),
      bottom: Math.min(fvgTop, fvgBottom),
      fromIdx: Math.max(0, formedIdx - 1),
      toIdx: Math.min(candles.length - 1, entryIdx + 5),
    };
  }

  let ob: SmcChartMarkup["ob"] = null;
  const obTop = Number(meta.obTop ?? 0);
  const obBottom = Number(meta.obBottom ?? 0);
  if (obTop > 0 && obBottom > 0) {
    const obIdx =
      meta.obTs != null
        ? barIndexForMs(candles, Number(meta.obTs))
        : meta.obIdx != null
          ? Number(meta.obIdx)
          : Math.max(0, (mssIdx ?? entryIdx) - 1);
    const obEndIdx =
      meta.obDispTs != null
        ? barIndexForMs(candles, Number(meta.obDispTs))
        : meta.obDisplacementIdx != null
          ? Number(meta.obDisplacementIdx)
          : mssIdx ?? entryIdx;
    ob = {
      top: Math.max(obTop, obBottom),
      bottom: Math.min(obTop, obBottom),
      fromIdx: obIdx,
      toIdx: Math.min(candles.length - 1, obEndIdx),
    };
  }

  const hlines: SmcChartMarkup["hlines"] = [];
  if (sweepLevel > 0) {
    hlines.push({
      price: sweepLevel,
      fromIdx: sweepStartIdx,
      toIdx: sweepReclaimIdx,
      color: "#f472b6",
      label: `Sweep ${meta.levelType ?? liq?.levelType ?? "liq"}`,
      lineStyle: "dotted",
      layer: "sweep_level",
    });
  }
  if (sweepWick > 0) {
    hlines.push({
      price: sweepWick,
      fromIdx: sweepWickIdx,
      toIdx: entryIdx,
      color: "#fb7185",
      label: "Sweep wick (SL ref)",
      lineStyle: "dashed",
      layer: "liq_sweep_wick",
    });
  }
  if (opposing > 0) {
    hlines.push({
      price: opposing,
      fromIdx: sweepReclaimIdx,
      toIdx: exitIdx,
      color: "#c084fc",
      label: "Opposing liquidity",
      lineStyle: "dotted",
      layer: "liq_opposing",
    });
  }
  if (chochLevel > 0 && chochIdx != null && chochIdx >= 0) {
    hlines.push({
      price: chochLevel,
      fromIdx: Math.max(0, chochIdx - 2),
      toIdx: Math.min(candles.length - 1, chochIdx + 8),
      color: "#e879f9",
      label: meta.chochType ? String(meta.chochType).replace(/_/g, " ").toUpperCase() : "CHoCH",
      lineStyle: "dashed",
      layer: "smc_choch",
    });
  }
  if (bosLevel > 0 && mssIdx != null && mssIdx >= 0) {
    hlines.push({
      price: bosLevel,
      fromIdx: Math.max(0, mssIdx - 3),
      toIdx: Math.min(candles.length - 1, mssIdx + 12),
      color: "#38bdf8",
      label: meta.bosType ? String(meta.bosType).replace(/_/g, " ").toUpperCase() : "BOS/MSS",
      lineStyle: "solid",
      layer: "smc_bos",
    });
  }

  const entryPrice = Number(trade.entryPrice);
  if (entryPrice > 0) {
    hlines.push({
      price: entryPrice,
      fromIdx: entryIdx,
      toIdx: exitIdx,
      color: "#0ea5e9",
      label: "Entry fill",
      lineStyle: "dashed",
      layer: "strategy_entry",
    });
  }
  const tp1 = Number(liq?.tp1Price ?? 0);
  if (tp1 > 0) {
    hlines.push({
      price: tp1,
      fromIdx: entryIdx,
      toIdx: exitIdx,
      color: "#c084fc",
      label: "TP1 partial",
      lineStyle: "dotted",
      layer: "strategy_tp1",
    });
  }
  if (trade.slPrice != null && Number.isFinite(trade.slPrice)) {
    hlines.push({
      price: trade.slPrice,
      fromIdx: entryIdx,
      toIdx: exitIdx,
      color: "#f87171",
      label: "Stop loss",
      lineStyle: "dashed",
      layer: "strategy_sl",
    });
  }
  if (trade.tpPrice != null && Number.isFinite(trade.tpPrice)) {
    hlines.push({
      price: trade.tpPrice,
      fromIdx: entryIdx,
      toIdx: exitIdx,
      color: "#a855f7",
      label: "Take profit",
      lineStyle: "dotted",
      layer: "strategy_tp",
    });
  }

  const events: SmcChartMarkup["events"] = [];
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
  if (entryIdx >= 0) {
    events.push({
      kind: "entry",
      idx: entryIdx,
      timeSec: sec(candles, entryIdx),
      price: entryPrice > 0 ? entryPrice : candles[entryIdx].close,
      label: "Entry",
    });
  }

  return {
    side,
    entryIdx,
    exitIdx,
    focusFromIdx: windowStart,
    focusToIdx: windowEnd,
    swings,
    sweep: {
      level: sweepLevel,
      wick: sweepWick,
      levelType: (meta.levelType ?? liq?.levelType ?? null) as string | null,
      sweepStartIdx,
      sweepWickIdx,
      reclaimIdx: sweepReclaimIdx,
    },
    bos:
      mssIdx != null && mssIdx >= 0 && bosLevel > 0
        ? { idx: mssIdx, price: bosLevel, type: meta.bosType != null ? String(meta.bosType) : null, timeSec: sec(candles, mssIdx) }
        : null,
    fvg,
    ob,
    hlines,
    events,
    legend: [
      "SH/SL = swing high/low",
      "Pink = liquidity sweep",
      "Rose = sweep wick (SL ref)",
      "Fuchsia = CHoCH",
      "Sky = BOS / MSS",
      "Violet = FVG zone",
      "Amber = order block",
      "Purple = opposing liquidity",
      "Cyan = entry · Red = SL · Violet = TP",
    ],
  };
}

/**
 * Liquidity + S/R (institutional A+) markup for trades WITHOUT smcMeta. Reconstructs
 * the anatomy from the persisted liqContext (level, sweep wick, opposing pool) + the
 * trade brackets, and marks the support/resistance zone the sweep happened at.
 */
export function buildLiquidityChartMarkup(
  candles: OhlcCandle[],
  trade: BacktestTrade,
  botOpts: Record<string, unknown> = {},
): SmcChartMarkup | null {
  if (!candles.length || !trade) return null;

  const entryIdx = barIndexForIso(candles, trade.entryTs);
  const exitIdx = barIndexForIso(candles, trade.exitTs);
  const lo = Math.min(entryIdx, exitIdx);
  const hi = Math.max(entryIdx, exitIdx);
  const pad = 40;
  const windowStart = Math.max(0, lo - pad);
  const windowEnd = Math.min(candles.length - 1, hi + pad);

  const liq = (trade.liqContext ?? null) as BacktestLiqContext | null;
  const side = trade.direction === "SELL" ? "SELL" : "BUY";
  const level = Number(liq?.level ?? 0);
  const wick = Number(liq?.sweepWick ?? 0);
  const opposing = Number(liq?.opposingLevel ?? 0);
  const isSupport = side === "BUY"; // longs fade a sweep of support; shorts fade resistance
  const zoneWidthPct = Math.max(0.0005, Number(botOpts.intradaySrZoneWidthPct ?? 0.002));

  // Reconstruct sweep wick bar + sweep start by scanning the window before entry.
  const lookback = 48;
  const scanFrom = Math.max(0, entryIdx - lookback);
  let sweepWickIdx = entryIdx;
  let sweepStartIdx = entryIdx;
  if (wick > 0) {
    for (let j = scanFrom; j <= entryIdx; j++) {
      if (side === "BUY" ? candles[j].low <= wick : candles[j].high >= wick) sweepWickIdx = j;
    }
  }
  if (level > 0) {
    for (let j = scanFrom; j <= entryIdx; j++) {
      const pierced = side === "BUY" ? candles[j].low < level : candles[j].high > level;
      if (pierced) {
        sweepStartIdx = j;
        break;
      }
    }
  }
  const reclaimIdx = entryIdx;

  const swingOpts = resolveSwingOpts(botOpts);
  const { highs, lows } = getConfirmedSwings(candles, windowStart, Math.min(candles.length - 1, entryIdx), swingOpts);
  const swings = [
    ...highs.filter((s) => s.pivotIdx >= windowStart && s.pivotIdx <= windowEnd).slice(-6),
    ...lows.filter((s) => s.pivotIdx >= windowStart && s.pivotIdx <= windowEnd).slice(-6),
  ];

  const hlines: SmcChartMarkup["hlines"] = [];
  const srColor = isSupport ? "#2dd4bf" : "#fb923c";
  if (level > 0) {
    const band = level * zoneWidthPct;
    hlines.push({
      price: level,
      fromIdx: windowStart,
      toIdx: windowEnd,
      color: srColor,
      label: `${isSupport ? "SUPPORT" : "RESISTANCE"} ${(liq?.levelType ?? "").toUpperCase()}`,
      lineStyle: "solid",
      layer: "liq_sr_zone",
    });
    hlines.push({
      price: level + band,
      fromIdx: windowStart,
      toIdx: windowEnd,
      color: srColor,
      label: "",
      lineStyle: "dotted",
      layer: "liq_sr_zone",
    });
    hlines.push({
      price: level - band,
      fromIdx: windowStart,
      toIdx: windowEnd,
      color: srColor,
      label: "",
      lineStyle: "dotted",
      layer: "liq_sr_zone",
    });
  }
  if (wick > 0) {
    hlines.push({
      price: wick,
      fromIdx: sweepWickIdx,
      toIdx: entryIdx,
      color: "#fb7185",
      label: "Sweep wick (SL ref)",
      lineStyle: "dashed",
      layer: "liq_sweep_wick",
    });
  }
  if (opposing > 0) {
    hlines.push({
      price: opposing,
      fromIdx: reclaimIdx,
      toIdx: exitIdx,
      color: "#c084fc",
      label: `Opposing liquidity (${isSupport ? "resistance" : "support"} TP pool)`,
      lineStyle: "dotted",
      layer: "liq_opposing",
    });
  }
  const entryPrice = Number(trade.entryPrice);
  if (entryPrice > 0) {
    hlines.push({
      price: entryPrice,
      fromIdx: entryIdx,
      toIdx: exitIdx,
      color: "#0ea5e9",
      label: "Entry fill",
      lineStyle: "dashed",
      layer: "strategy_entry",
    });
  }
  const tp1 = Number(liq?.tp1Price ?? 0);
  if (tp1 > 0) {
    hlines.push({
      price: tp1,
      fromIdx: entryIdx,
      toIdx: exitIdx,
      color: "#a3e635",
      label: "TP1 (1R partial)",
      lineStyle: "dotted",
      layer: "strategy_tp1",
    });
  }
  if (trade.slPrice != null && Number.isFinite(trade.slPrice)) {
    hlines.push({
      price: trade.slPrice,
      fromIdx: entryIdx,
      toIdx: exitIdx,
      color: "#f87171",
      label: "Stop loss",
      lineStyle: "dashed",
      layer: "strategy_sl",
    });
  }
  if (trade.tpPrice != null && Number.isFinite(trade.tpPrice)) {
    hlines.push({
      price: trade.tpPrice,
      fromIdx: entryIdx,
      toIdx: exitIdx,
      color: "#a855f7",
      label: "Take profit",
      lineStyle: "dotted",
      layer: "strategy_tp",
    });
  }

  const events: SmcChartMarkup["events"] = [];
  if (wick > 0 && sweepWickIdx >= 0) {
    events.push({
      kind: "sweep",
      idx: sweepWickIdx,
      timeSec: sec(candles, sweepWickIdx),
      price: side === "BUY" ? candles[sweepWickIdx].low : candles[sweepWickIdx].high,
      label: "Sweep",
    });
  }
  events.push({ kind: "reclaim", idx: reclaimIdx, timeSec: sec(candles, reclaimIdx), price: candles[reclaimIdx]?.close ?? entryPrice, label: "Reclaim" });
  events.push({ kind: "entry", idx: entryIdx, timeSec: sec(candles, entryIdx), price: entryPrice > 0 ? entryPrice : candles[entryIdx]?.close ?? 0, label: "Entry" });

  return {
    side,
    entryIdx,
    exitIdx,
    focusFromIdx: windowStart,
    focusToIdx: windowEnd,
    swings,
    sweep: {
      level,
      wick,
      levelType: (liq?.levelType ?? null) as string | null,
      sweepStartIdx,
      sweepWickIdx,
      reclaimIdx,
    },
    bos: null,
    fvg: null,
    ob: null,
    hlines,
    events,
    legend: [
      isSupport ? "Teal — support zone (swept)" : "Orange — resistance zone (swept)",
      "Rose — sweep wick (SL ref)",
      "Purple — opposing liquidity (TP pool)",
      "Cyan — entry · Red — SL · Violet — TP · Lime — TP1",
      "SH/SL — confirmed swings",
    ],
  };
}

function segmentByIdx(
  fromIdx: number,
  toIdx: number,
  chartTimesSec: number[],
  price: number,
): LineData[] {
  const lo = Math.max(0, Math.min(fromIdx, toIdx));
  const hi = Math.min(chartTimesSec.length - 1, Math.max(fromIdx, toIdx));
  const pts: LineData[] = [];
  for (let i = lo; i <= hi; i++) {
    const t = chartTimesSec[i];
    if (t == null) continue;
    pts.push({ time: t as UTCTimestamp, value: price });
  }
  return pts;
}

const lineStyleMap = {
  solid: LineStyle.Solid,
  dashed: LineStyle.Dashed,
  dotted: LineStyle.Dotted,
} as const;

export type SmcChartLayers = {
  taLines: Array<{
    data: LineData[];
    color: string;
    lineStyle?: LineStyle;
    lineWidth?: number;
    layer?: ChartOverlayLayerId;
  }>;
  markers: SeriesMarker<UTCTimestamp>[];
  legend: string[];
};

export function smcMarkupToChartLayers(
  markup: SmcChartMarkup,
  chartTimesSec: number[],
): SmcChartLayers {
  const taLines: SmcChartLayers["taLines"] = [];

  for (const hl of markup.hlines) {
    taLines.push({
      data: segmentByIdx(hl.fromIdx, hl.toIdx, chartTimesSec, hl.price),
      color: hl.color,
      lineStyle: lineStyleMap[hl.lineStyle],
      lineWidth: hl.lineStyle === "solid" ? 2 : 1,
      layer: hl.layer,
    });
  }

  if (markup.fvg) {
    taLines.push({
      data: segmentByIdx(markup.fvg.fromIdx, markup.fvg.toIdx, chartTimesSec, markup.fvg.top),
      color: "#a78bfa",
      lineWidth: 2,
      layer: "smc_fvg",
    });
    taLines.push({
      data: segmentByIdx(markup.fvg.fromIdx, markup.fvg.toIdx, chartTimesSec, markup.fvg.bottom),
      color: "#a78bfa",
      lineStyle: LineStyle.Dotted,
      lineWidth: 1,
      layer: "smc_fvg",
    });
  }

  if (markup.ob) {
    taLines.push({
      data: segmentByIdx(markup.ob.fromIdx, markup.ob.toIdx, chartTimesSec, markup.ob.top),
      color: "#fbbf24",
      lineWidth: 2,
      layer: "smc_ob",
    });
    taLines.push({
      data: segmentByIdx(markup.ob.fromIdx, markup.ob.toIdx, chartTimesSec, markup.ob.bottom),
      color: "#fbbf24",
      lineStyle: LineStyle.Dotted,
      lineWidth: 1,
      layer: "smc_ob",
    });
  }

  const markers: SeriesMarker<UTCTimestamp>[] = [];
  let lastSec = 0;

  for (const s of markup.swings) {
    if (s.timeSec == null) continue;
    const time = (s.timeSec <= lastSec ? lastSec + 1 : s.timeSec) as UTCTimestamp;
    lastSec = time as number;
    markers.push({
      time,
      position: s.kind === "swing_high" ? "aboveBar" : "belowBar",
      shape: s.kind === "swing_high" ? "arrowDown" : "arrowUp",
      color: s.kind === "swing_high" ? "#94a3b8" : "#64748b",
      text: s.label,
    });
  }

  for (const ev of markup.events) {
    if (ev.timeSec == null) continue;
    const time = (ev.timeSec <= lastSec ? lastSec + 1 : ev.timeSec) as UTCTimestamp;
    lastSec = time as number;
    const color =
      ev.kind === "sweep"
        ? "#f472b6"
        : ev.kind === "reclaim"
          ? "#34d399"
          : ev.kind === "choch"
            ? "#e879f9"
            : ev.kind === "bos"
              ? "#38bdf8"
              : ev.kind === "entry"
                ? "#0ea5e9"
                : "#f59e0b";
    markers.push({
      time,
      position: ev.kind === "bos" || ev.kind === "entry" ? "aboveBar" : "belowBar",
      shape: ev.kind === "bos" ? "square" : ev.kind === "entry" ? "arrowUp" : "circle",
      color,
      text: ev.label,
    });
  }

  return { taLines, markers, legend: markup.legend };
}

export function mergeTradeAndSmcMarkers(
  tradeMarkers: SeriesMarker<UTCTimestamp>[],
  smcMarkers: SeriesMarker<UTCTimestamp>[],
): SeriesMarker<UTCTimestamp>[] {
  return [...tradeMarkers, ...smcMarkers].sort((a, b) => Number(a.time) - Number(b.time));
}

export function focusLogicalRangeForTrade(
  trade: BacktestTrade,
  candles: OhlcCandle[],
  indexByTs: Map<number, number>,
  padBars = 35,
): { from: number; to: number } | null {
  if (!candles.length) return null;
  const entryIdx = barIndexForIso(candles, trade.entryTs);
  const exitIdx = barIndexForIso(candles, trade.exitTs);
  const lo = Math.min(entryIdx, exitIdx);
  const hi = Math.max(entryIdx, exitIdx);
  void indexByTs;
  return {
    from: Math.max(0, lo - padBars),
    to: Math.min(candles.length - 1, hi + padBars),
  };
}
