/**
 * Strategy-specific TA levels and position-pattern helpers for backtest trade charts.
 */
import type { LineStyle, LineWidth, LineData, UTCTimestamp } from "lightweight-charts";
import type { BacktestRunSummary, BacktestTrade } from "../../types/backtest";
import { profileChartMarkup } from "../../lib/strategyConfigProfile.ts";
import {
  chartTimeForEntryFill,
  chartTimeForExitFill,
  chartTimeForTrade,
  activeBracketPrice,
  type OhlcCandle,
  type TradeChartTiming,
} from "./backtestChartTime";

export type BacktestSmcMeta = {
  sweepLevel?: number | null;
  sweepExtensionPct?: number | null;
  sweepStartIdx?: number | null;
  sweepStartTs?: number | null;
  sweepWickIdx?: number | null;
  sweepWickTs?: number | null;
  sweepReclaimIdx?: number | null;
  sweepReclaimTs?: number | null;
  chochIdx?: number | null;
  chochTs?: number | null;
  chochLevel?: number | null;
  chochType?: string | null;
  bosLevel?: number | null;
  bosType?: string | null;
  mssIdx?: number | null;
  mssTs?: number | null;
  entryIdx?: number | null;
  fvgTop?: number | null;
  fvgBottom?: number | null;
  fvgFormedIdx?: number | null;
  fvgFormedTs?: number | null;
  obTop?: number | null;
  obBottom?: number | null;
  obIdx?: number | null;
  obTs?: number | null;
  obDisplacementIdx?: number | null;
  obDispTs?: number | null;
  levelType?: string | null;
  killzone?: string | null;
  ictProfile?: string | null;
};

export type BacktestTokyoMeta = {
  sessionStartTs?: number;
  sessionEndTs?: number;
  sessionHigh?: number;
  sessionLow?: number;
  first2High?: number;
  first2Low?: number;
  dirMode?: string;
  slMode?: string;
  tpRr?: number;
};

export type BacktestLiqContext = {
  levelType?: string;
  level?: number;
  sweepWick?: number;
  opposingLevel?: number;
  liqQuality?: number;
  rr?: number;
  partialTp?: boolean;
  tp1Price?: number | null;
  smcMeta?: BacktestSmcMeta | null;
  techniques?: string[] | null;
  tokyoMeta?: BacktestTokyoMeta | null;
};

export type ChartPriceLineSpec = {
  price: number;
  color: string;
  title: string;
  lineStyle?: LineStyle;
  lineWidth?: LineWidth;
  /** Default true — trail tiers use false and show labels on the chart left instead. */
  axisLabelVisible?: boolean;
};

export type StrategyTaOverlay = {
  strategyKey: string;
  lines: ChartPriceLineSpec[];
  legend: string[];
};

export function botFromRun(run: BacktestRunSummary | null): Record<string, unknown> {
  if (!run) return {};
  const cfg = (run.configSnapshot ?? {}) as Record<string, unknown>;
  if (cfg.bot && typeof cfg.bot === "object" && !Array.isArray(cfg.bot)) {
    return cfg.bot as Record<string, unknown>;
  }
  return cfg;
}

export function manualStrategyFromRun(run: BacktestRunSummary | null): string {
  const bot = botFromRun(run);
  const cfg = (run?.configSnapshot ?? {}) as Record<string, unknown>;
  return String(bot.manualStrategy ?? cfg.manualStrategy ?? "").toUpperCase();
}

export function isSmcIctRun(run: BacktestRunSummary | null): boolean {
  const manual = manualStrategyFromRun(run);
  if (profileChartMarkup(manual) !== "smc_ict") return false;
  const bot = botFromRun(run);
  return bot.intradayGateSmcIct === true || bot.intradaySmcIctMode === true;
}

/** True when this trade has persisted SMC/ICT context (works even if run gate flag is off). */
export function hasSmcTradeContext(run: BacktestRunSummary | null, trade: BacktestTrade | null): boolean {
  if (!trade) return false;
  const liq = trade.liqContext as BacktestLiqContext | null | undefined;
  if (liq?.smcMeta && Object.keys(liq.smcMeta).length > 0) return true;
  if (Array.isArray(liq?.techniques) && liq.techniques.some((t) => String(t).startsWith("smc_"))) return true;
  const reason = String(trade.entryReason ?? "");
  if (reason.includes("smc_ict") || reason.includes("smc+")) return true;
  const manual = manualStrategyFromRun(run);
  if (profileChartMarkup(manual) === "smc_ict") return isSmcIctRun(run);
  return false;
}

export function isLiquidityRun(run: BacktestRunSummary | null): boolean {
  const bot = botFromRun(run);
  return bot.intradayGateLiquidity === true || bot.intradayGateSession === true;
}

export function isFibRun(run: BacktestRunSummary | null): boolean {
  const bot = botFromRun(run);
  return bot.intradayGateFib === true;
}

export function isTokyoSessionRun(run: BacktestRunSummary | null): boolean {
  return manualStrategyFromRun(run) === "TOKYO_SESSION";
}

function utcSessionBoundsMs(entryTsIso: string, startUtc: number, endUtc: number) {
  const entryMs = new Date(entryTsIso).getTime();
  const d = new Date(entryMs);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0);
  return {
    startMs: dayStart + startUtc * 3_600_000,
    endMs: dayStart + endUtc * 3_600_000,
  };
}

/** Horizontal segment between two bar open times (chart UTC seconds). */
export function priceSegmentForTimeWindow(
  startMs: number,
  endMs: number,
  price: number,
  candles: OhlcCandle[],
  chartTimesSec: number[],
  indexByTs: Map<number, number>,
): LineData[] {
  if (!Number.isFinite(price)) return [];
  let startIdx = -1;
  let endIdx = -1;
  for (let i = 0; i < candles.length; i++) {
    const ts = candles[i].ts;
    if (ts >= startMs && ts < endMs) {
      if (startIdx < 0) startIdx = i;
      endIdx = i;
    }
  }
  if (startIdx < 0 || endIdx < 0) return [];
  const t0 = chartTimesSec[startIdx] as UTCTimestamp;
  const t1 = chartTimesSec[endIdx] as UTCTimestamp;
  if (t0 === t1) return [{ time: t0, value: price }];
  return [
    { time: t0, value: price },
    { time: t1, value: price },
  ];
}

/** Tokyo session box: full session high/low over 00:00–04:00 UTC (configurable). */
export function buildTokyoSessionBoxSeries(
  trade: BacktestTrade,
  candles: OhlcCandle[],
  chartTimesSec: number[],
  indexByTs: Map<number, number>,
  bot: Record<string, unknown> = {},
): { top: LineData[]; bottom: LineData[]; high: number; low: number } | null {
  const startUtc = Number(bot.tokyoSessionStartUtc ?? 0);
  const endUtc = Number(bot.tokyoSessionEndUtc ?? 4);
  const { startMs, endMs } = utcSessionBoundsMs(trade.entryTs, startUtc, endUtc);
  let hi = -Infinity;
  let lo = Infinity;
  for (const c of candles) {
    if (c.ts >= startMs && c.ts < endMs) {
      hi = Math.max(hi, c.high);
      lo = Math.min(lo, c.low);
    }
  }
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return {
    high: hi,
    low: lo,
    top: priceSegmentForTimeWindow(startMs, endMs, hi, candles, chartTimesSec, indexByTs),
    bottom: priceSegmentForTimeWindow(startMs, endMs, lo, candles, chartTimesSec, indexByTs),
  };
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Horizontal segment from entry bar through exit bar (two endpoints — fast on long charts). */
export function priceSegmentForTrade(
  trade: BacktestTrade,
  candles: OhlcCandle[],
  chartTimesSec: number[],
  indexByTs: Map<number, number>,
  price: number,
  timing?: TradeChartTiming,
): LineData[] {
  if (!Number.isFinite(price)) return [];
  const tEntry = timing
    ? Number(chartTimeForEntryFill(trade, candles, chartTimesSec, timing))
    : Number(chartTimeForTrade(trade.entryTs, candles, chartTimesSec, indexByTs));
  const tExit = timing
    ? Number(chartTimeForExitFill(trade, candles, chartTimesSec, timing))
    : Number(chartTimeForTrade(trade.exitTs, candles, chartTimesSec, indexByTs));
  if (!Number.isFinite(tEntry)) return [];
  const lo = Math.min(tEntry, Number.isFinite(tExit) ? tExit : tEntry);
  const hi = Math.max(tEntry, Number.isFinite(tExit) ? tExit : tEntry);
  if (lo === hi) return [{ time: lo as UTCTimestamp, value: price }];
  return [
    { time: lo as UTCTimestamp, value: price },
    { time: hi as UTCTimestamp, value: price },
  ];
}

export type TradeChartZoneSeries = {
  riskTop: LineData[];
  riskBottom: LineData[];
  rewardTop: LineData[];
  rewardBottom: LineData[];
  tokyoBoxTop: LineData[];
  tokyoBoxBottom: LineData[];
  taLines: Array<{ data: LineData[]; color: string; lineStyle?: LineStyle; lineWidth?: number }>;
};

export function buildTradeChartZoneSeries(
  run: BacktestRunSummary | null,
  trade: BacktestTrade,
  candles: OhlcCandle[],
  chartTimesSec: number[],
  indexByTs: Map<number, number>,
  opts: { showTa: boolean; showPattern: boolean; chartTf?: string },
): TradeChartZoneSeries {
  const empty = {
    riskTop: [],
    riskBottom: [],
    rewardTop: [],
    rewardBottom: [],
    tokyoBoxTop: [],
    tokyoBoxBottom: [],
    taLines: [],
  };
  if (!trade) return empty;

  const timing: TradeChartTiming | undefined =
    opts.chartTf && run?.timeframe
      ? { chartTf: opts.chartTf, runTimeframe: run.timeframe, engineType: run.engineType }
      : undefined;
  const seg = (price: number) =>
    priceSegmentForTrade(trade, candles, chartTimesSec, indexByTs, price, timing);

  const isLong = trade.direction === "BUY";
  const entry = num(trade.entryPrice);
  const sl = activeBracketPrice(trade.slPrice);
  const tp = activeBracketPrice(trade.tpPrice);
  const liq = trade.liqContext as BacktestLiqContext | null | undefined;
  const tp1 = activeBracketPrice(liq?.tp1Price);

  let riskTop: LineData[] = [];
  let riskBottom: LineData[] = [];
  let rewardTop: LineData[] = [];
  let rewardBottom: LineData[] = [];

  if (opts.showPattern) {
    if (entry != null && sl != null) {
      const top = isLong ? entry : sl;
      const bottom = isLong ? sl : entry;
      riskTop = seg(top);
      riskBottom = seg(bottom);
    }
    if (entry != null && tp != null) {
      const top = isLong ? tp : entry;
      const bottom = isLong ? entry : tp;
      rewardTop = seg(top);
      rewardBottom = seg(bottom);
    }
    if (tp1 != null && entry != null) {
      // tp1 shown as extra TA-style line
    }
  }

  let tokyoBoxTop: LineData[] = [];
  let tokyoBoxBottom: LineData[] = [];
  if (run && isTokyoSessionRun(run)) {
    const box = buildTokyoSessionBoxSeries(trade, candles, chartTimesSec, indexByTs, botFromRun(run));
    if (box) {
      tokyoBoxTop = box.top;
      tokyoBoxBottom = box.bottom;
    }
  }

  const taLines: TradeChartZoneSeries["taLines"] = [];
  if (opts.showTa && run) {
    const ta = buildStrategyTaOverlay(run, trade);
    if (ta?.lines.length) {
      for (const spec of ta.lines) {
        taLines.push({
          data: seg(spec.price),
          color: spec.color,
          lineStyle: spec.lineStyle,
          lineWidth: spec.lineWidth ?? 2,
        });
      }
    }
    if (opts.showPattern && tp1 != null) {
      taLines.push({
        data: seg(tp1),
        color: "#fde047",
        lineWidth: 2,
        lineStyle: 0,
      });
    }
  }

  return { riskTop, riskBottom, rewardTop, rewardBottom, tokyoBoxTop, tokyoBoxBottom, taLines };
}

function bandLines(
  top: number,
  bottom: number,
  label: string,
  color: string,
): ChartPriceLineSpec[] {
  const hi = Math.max(top, bottom);
  const lo = Math.min(top, bottom);
  return [
    { price: hi, color, title: `${label} top`, lineStyle: 2, lineWidth: 1 },
    { price: lo, color, title: `${label} bottom`, lineStyle: 2, lineWidth: 1 },
  ];
}

/** ICT / SMC: sweep wick, liquidity pool, FVG/OB, structure break. */
export function buildSmcIctTaOverlay(
  trade: BacktestTrade,
  liq: BacktestLiqContext | null | undefined,
): StrategyTaOverlay {
  const lines: ChartPriceLineSpec[] = [];
  const legend: string[] = [];
  const meta = liq?.smcMeta ?? null;

  const sweepLevel = num(liq?.level ?? meta?.sweepLevel);
  const sweepWick = num(liq?.sweepWick);
  const opposing = num(liq?.opposingLevel);
  const bos = num(meta?.bosLevel);

  if (sweepLevel != null) {
    lines.push({
      price: sweepLevel,
      color: "#f472b6",
      title: `Sweep ${liq?.levelType ?? "level"}`,
      lineStyle: 3,
      lineWidth: 2,
    });
    legend.push("Pink dotted — swept liquidity");
  }
  if (sweepWick != null && (sweepLevel == null || Math.abs(sweepWick - sweepLevel) / sweepLevel > 0.0001)) {
    lines.push({
      price: sweepWick,
      color: "#fb7185",
      title: "Sweep wick (SL ref)",
      lineStyle: 2,
      lineWidth: 1,
    });
    legend.push("Rose dashed — sweep wick / SL anchor");
  }
  if (opposing != null) {
    lines.push({
      price: opposing,
      color: "#c084fc",
      title: "Opposing liquidity (TP)",
      lineStyle: 3,
      lineWidth: 2,
    });
    legend.push("Purple dotted — draw on liquidity / TP pool");
  }
  if (bos != null) {
    lines.push({
      price: bos,
      color: "#38bdf8",
      title: "Structure break (MSS/BOS)",
      lineStyle: 0,
      lineWidth: 1,
    });
    legend.push("Sky — MSS/BOS level");
  }

  const fvgTop = num(meta?.fvgTop);
  const fvgBottom = num(meta?.fvgBottom);
  if (fvgTop != null && fvgBottom != null) {
    lines.push(...bandLines(fvgTop, fvgBottom, "FVG", "#a78bfa"));
    legend.push("Violet band — fair value gap");
  }

  const obTop = num(meta?.obTop);
  const obBottom = num(meta?.obBottom);
  if (obTop != null && obBottom != null) {
    lines.push(...bandLines(obTop, obBottom, "OB", "#fbbf24"));
    legend.push("Amber band — order block");
  }

  if (meta?.killzone) {
    legend.push(`Kill-zone: ${meta.killzone}`);
  }

  return { strategyKey: "SMC_ICT", lines, legend };
}

/** Liquidity sweep preset: PDH/PDL + wick + opposing pool. */
export function buildLiquidityTaOverlay(
  trade: BacktestTrade,
  liq: BacktestLiqContext | null | undefined,
): StrategyTaOverlay {
  const lines: ChartPriceLineSpec[] = [];
  const legend: string[] = [];

  const level = num(liq?.level);
  const wick = num(liq?.sweepWick);
  const opposing = num(liq?.opposingLevel);

  if (level != null) {
    lines.push({
      price: level,
      color: "#f472b6",
      title: `${liq?.levelType ?? "Liq"} sweep`,
      lineStyle: 3,
      lineWidth: 2,
    });
    legend.push("Pink — session liquidity swept");
  }
  if (wick != null) {
    lines.push({
      price: wick,
      color: "#fb7185",
      title: "Sweep wick",
      lineStyle: 2,
      lineWidth: 1,
    });
  }
  if (opposing != null) {
    lines.push({
      price: opposing,
      color: "#c084fc",
      title: "Opposing liq TP",
      lineStyle: 3,
      lineWidth: 2,
    });
    legend.push("Purple — opposing liquidity target");
  }

  return { strategyKey: "LIQUIDITY", lines, legend };
}

export function buildTokyoSessionTaOverlay(
  trade: BacktestTrade,
  liq: BacktestLiqContext | null | undefined,
): StrategyTaOverlay {
  const lines: ChartPriceLineSpec[] = [];
  const legend: string[] = ["Tokyo session box — full Asia range (00:00–04:00 UTC)"];
  const meta = liq?.tokyoMeta;
  const f2Hi = num(meta?.first2High);
  const f2Lo = num(meta?.first2Low);
  if (f2Hi != null) {
    lines.push({
      price: f2Hi,
      color: "#38bdf8",
      title: "First-2 high",
      lineStyle: 2,
      lineWidth: 1,
    });
  }
  if (f2Lo != null) {
    lines.push({
      price: f2Lo,
      color: "#38bdf8",
      title: "First-2 low",
      lineStyle: 2,
      lineWidth: 1,
    });
    legend.push("Cyan — first two candle range (entry bias)");
  }
  return { strategyKey: "TOKYO_SESSION", lines, legend };
}

export function buildStrategyTaOverlay(
  run: BacktestRunSummary | null,
  trade: BacktestTrade,
): StrategyTaOverlay | null {
  const liq = trade.liqContext as BacktestLiqContext | null | undefined;
  const reason = String(trade.entryReason ?? "");

  if (isTokyoSessionRun(run) || reason.startsWith("tokyo_")) {
    return buildTokyoSessionTaOverlay(trade, liq);
  }

  if (isSmcIctRun(run) || reason.startsWith("smc_")) {
    return buildSmcIctTaOverlay(trade, liq);
  }
  if (isLiquidityRun(run) || String(trade.entryReason ?? "").includes("liq")) {
    return buildLiquidityTaOverlay(trade, liq);
  }
  if (isFibRun(run) || String(trade.entryReason ?? "").includes("fib")) {
    return {
      strategyKey: "FIB",
      lines: [],
      legend: ["Fibonacci — swing SL/TP shown via entry/SL/TP lines"],
    };
  }
  if (liq) return buildLiquidityTaOverlay(trade, liq);

  // Fallback: bracket levels as TA guides when signal_context.liq is missing (older runs).
  const lines: ChartPriceLineSpec[] = [];
  const legend: string[] = ["TA from entry / SL / TP (re-run backtest for full SMC levels)"];
  const sl = activeBracketPrice(trade.slPrice);
  const tp = activeBracketPrice(trade.tpPrice);
  if (sl != null) {
    lines.push({ price: sl, color: "#fb7185", title: "Stop", lineStyle: 2, lineWidth: 2 });
  }
  if (tp != null) {
    lines.push({ price: tp, color: "#c084fc", title: "Target", lineStyle: 3, lineWidth: 2 });
  }
  return lines.length ? { strategyKey: "BRACKET", lines, legend } : null;
}

/** Position pattern: bracket levels (entry, SL, TP, partial TP, risk/reward zones). */
export function buildPositionPatternOverlay(trade: BacktestTrade): {
  lines: ChartPriceLineSpec[];
  legend: string[];
} {
  const lines: ChartPriceLineSpec[] = [];
  const legend: string[] = [];
  const isLong = trade.direction === "BUY";
  const entry = num(trade.entryPrice);
  const sl = activeBracketPrice(trade.slPrice);
  const tp = activeBracketPrice(trade.tpPrice);
  const liq = trade.liqContext as BacktestLiqContext | null | undefined;
  const tp1 = activeBracketPrice(liq?.tp1Price);

  if (entry != null && sl != null) {
    const riskTop = isLong ? entry : sl;
    const riskBottom = isLong ? sl : entry;
    lines.push(
      ...bandLines(riskTop, riskBottom, "Risk zone", "rgba(239,68,68,0.9)").map((l) => ({
        ...l,
        color: "#fca5a5",
      })),
    );
    legend.push("Red band — risk (entry → stop)");
  }

  if (entry != null && tp != null) {
    const rewTop = isLong ? tp : entry;
    const rewBottom = isLong ? entry : tp;
    lines.push(
      ...bandLines(rewTop, rewBottom, "Reward zone", "rgba(34,197,94,0.9)").map((l) => ({
        ...l,
        color: "#86efac",
      })),
    );
    legend.push("Green band — reward (entry → target)");
  }

  if (tp1 != null && entry != null) {
    lines.push({
      price: tp1,
      color: "#fde047",
      title: "TP1 (1R partial)",
      lineStyle: 0,
      lineWidth: 2,
    });
    legend.push("Yellow — partial take-profit @ 1R");
  }

  if (trade.maePct != null || trade.mfePct != null) {
    legend.push(
      `MAE ${trade.maePct != null ? `${trade.maePct.toFixed(2)}%` : "—"} · MFE ${trade.mfePct != null ? `${trade.mfePct.toFixed(2)}%` : "—"}`,
    );
  }

  return { lines, legend };
}
