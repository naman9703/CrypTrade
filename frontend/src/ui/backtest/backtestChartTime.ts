import type { UTCTimestamp } from "lightweight-charts";
import type { BacktestTrade } from "../../types/backtest";

export type OhlcCandle = { ts: number; open: number; high: number; low: number; close: number };

const TF_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export function chartTfToMs(tf: string): number {
  const ms = TF_MS[String(tf || "1h").toLowerCase()];
  return ms ?? 60 * 60_000;
}

/** Format ISO/ms timestamp in IST (matches chart axis). */
export function formatTsIST(isoOrMs: string | number): string {
  const ms = typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime();
  if (!Number.isFinite(ms)) return String(isoOrMs);
  return new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

/** Chart uses real UTC bar times; axis labels format in IST to match the trade table. */
export function formatChartTimeIST(time: UTCTimestamp): string {
  const d = new Date((time as number) * 1000);
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Build chart times aligned 1:1 with candle rows (only bump duplicates). */
export function buildCandleChartSeries(candles: OhlcCandle[]): {
  chartTimesSec: number[];
  indexByTs: Map<number, number>;
} {
  const chartTimesSec: number[] = [];
  const indexByTs = new Map<number, number>();
  let last = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c) continue;
    let t = Math.floor(Number(c.ts) / 1000);
    if (!Number.isFinite(t)) continue;
    if (t <= last) t = last + 1;
    last = t;
    chartTimesSec.push(t);
    indexByTs.set(c.ts, i);
  }
  return { chartTimesSec, indexByTs };
}

function isoToMs(iso: string | null | undefined): number | null {
  if (iso == null || iso === "") return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function inferEntrySameBar(
  trade: Pick<BacktestTrade, "entrySameBar">,
  engineType?: string | null,
): boolean {
  if (trade.entrySameBar === true) return true;
  if (trade.entrySameBar === false) return false;
  const et = String(engineType ?? "").toUpperCase();
  return et === "SUPERTREND_ELITE" || et === "UNIFIED_ELITE";
}

/** Exact entry fill instant (ms). Legacy runs: infer from bar open + run TF. */
export function resolveTradeEntryFillMs(
  trade: Pick<BacktestTrade, "entryTs" | "entryBarTs" | "entryFillTs" | "entrySameBar">,
  runTimeframe: string,
  engineType?: string | null,
): number {
  const fill = isoToMs(trade.entryFillTs);
  if (fill != null) return fill;
  const barMs = isoToMs(trade.entryBarTs ?? trade.entryTs);
  if (barMs == null) return NaN;
  const runTfMs = chartTfToMs(runTimeframe);
  if (inferEntrySameBar(trade, engineType)) return barMs + runTfMs - 1;
  return barMs + runTfMs;
}

/** Exit fill instant for chart placement on lower TFs. */
export function resolveTradeExitFillMs(
  trade: Pick<BacktestTrade, "exitTs" | "exitFillTs" | "exitReason">,
  runTimeframe: string,
): number {
  const fill = isoToMs(trade.exitFillTs);
  if (fill != null) return fill;
  const barMs = isoToMs(trade.exitTs);
  if (barMs == null) return NaN;
  const tfMs = chartTfToMs(runTimeframe);
  const reason = String(trade.exitReason ?? "").toLowerCase();
  if (reason === "flip" || reason === "signal_exit" || reason === "of_exit") {
    return barMs + tfMs;
  }
  // Bracket exits (trail/sl/tp/be) fire during the exit bar — bar open is the legacy default.
  return barMs;
}

/** Index of the chart bar whose period contains `ms`. */
export function barIndexContainingMs(candles: OhlcCandle[], ms: number, chartTfMs: number): number {
  if (!candles.length || !Number.isFinite(ms)) return 0;
  let lo = 0;
  let hi = candles.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const midBar = candles[mid];
    if (!midBar || !Number.isFinite(Number(midBar.ts))) {
      hi = mid - 1;
      continue;
    }
    if (midBar.ts <= ms) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const bar = candles[best];
  if (!bar || !Number.isFinite(Number(bar.ts))) return 0;
  if (ms >= bar.ts + chartTfMs && best + 1 < candles.length) return best + 1;
  return best;
}

function chartTimeAtIndex(candles: OhlcCandle[], chartTimesSec: number[], idx: number): UTCTimestamp {
  const clamped = Math.max(0, Math.min(chartTimesSec.length - 1, idx));
  const chartSec = chartTimesSec[clamped];
  if (Number.isFinite(chartSec)) return chartSec as UTCTimestamp;
  const candle = candles[Math.max(0, Math.min(candles.length - 1, idx))];
  const sec = candle ? Math.floor(Number(candle.ts) / 1000) : Math.floor(Date.now() / 1000);
  return (Number.isFinite(sec) ? sec : Math.floor(Date.now() / 1000)) as UTCTimestamp;
}

export type TradeChartTiming = {
  chartTf: string;
  runTimeframe: string;
  engineType?: string | null;
};

/** Map fill instant to chart bar time for the selected chart TF. */
export function chartTimeForEntryFill(
  trade: BacktestTrade,
  candles: OhlcCandle[],
  chartTimesSec: number[],
  timing: TradeChartTiming,
): UTCTimestamp {
  const fillMs = resolveTradeEntryFillMs(trade, timing.runTimeframe, timing.engineType);
  const idx = barIndexContainingMs(candles, fillMs, chartTfToMs(timing.chartTf));
  return chartTimeAtIndex(candles, chartTimesSec, idx);
}

export function chartTimeForExitFill(
  trade: BacktestTrade,
  candles: OhlcCandle[],
  chartTimesSec: number[],
  timing: TradeChartTiming,
): UTCTimestamp {
  const fillMs = resolveTradeExitFillMs(trade, timing.runTimeframe);
  const idx = barIndexContainingMs(candles, fillMs, chartTfToMs(timing.chartTf));
  return chartTimeAtIndex(candles, chartTimesSec, idx);
}

/**
 * @deprecated Prefer chartTimeForEntryFill / chartTimeForExitFill for trade markers.
 * Maps trade fill timestamp to the chart time of its OHLC bar (exact open_time match first).
 */
export function chartTimeForTrade(
  iso: string,
  candles: OhlcCandle[],
  chartTimesSec: number[],
  indexByTs: Map<number, number>,
): UTCTimestamp {
  if (!candles.length || !chartTimesSec.length) return Math.floor(Date.now() / 1000) as UTCTimestamp;
  const tms = new Date(iso).getTime();
  const idx = indexByTs.get(tms);
  if (idx != null && chartTimesSec[idx] != null) {
    return chartTimesSec[idx] as UTCTimestamp;
  }
  const rawSec = Math.floor(tms / 1000);
  let lo = 0;
  let hi = chartTimesSec.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chartTimesSec[mid] === rawSec) return rawSec as UTCTimestamp;
    if (chartTimesSec[mid] < rawSec) lo = mid + 1;
    else hi = mid - 1;
  }
  let bestIdx = 0;
  let bestDist = Math.abs(candles[0].ts - tms);
  for (let i = 1; i < candles.length; i++) {
    const d = Math.abs(candles[i].ts - tms);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return chartTimeAtIndex(candles, chartTimesSec, bestIdx);
}

/** lightweight-charts requires strictly ascending unique times per series. */
export function nextChartTime(candidateSec: number, lastSec: number): UTCTimestamp {
  const t = Math.floor(candidateSec);
  const next = t <= lastSec ? lastSec + 1 : t;
  return next as UTCTimestamp;
}

/** Nearest bar index for a candle open_time (ms). */
export function barIndexForMs(candles: OhlcCandle[], tsMs: number): number {
  if (!candles.length || !Number.isFinite(tsMs)) return 0;
  let idx = candles.findIndex((c) => c && c.ts === tsMs);
  if (idx >= 0) return idx;
  let best = 0;
  let bestD = Math.abs((candles[0]?.ts ?? tsMs) - tsMs);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    if (!c || !Number.isFinite(Number(c.ts))) continue;
    const d = Math.abs(c.ts - tsMs);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function barIndexForTradeFill(
  candles: OhlcCandle[],
  trade: BacktestTrade,
  chartTf: string,
  runTimeframe: string,
  engineType?: string | null,
  kind: "entry" | "exit" = "entry",
): number {
  const chartTfMs = chartTfToMs(chartTf);
  const ms =
    kind === "exit"
      ? resolveTradeExitFillMs(trade, runTimeframe)
      : resolveTradeEntryFillMs(trade, runTimeframe, engineType);
  return barIndexContainingMs(candles, ms, chartTfMs);
}

export function barAtTradeTime(
  iso: string,
  candles: OhlcCandle[],
  indexByTs: Map<number, number>,
): OhlcCandle | null {
  const tms = new Date(iso).getTime();
  const idx = indexByTs.get(tms);
  if (idx != null) return candles[idx] ?? null;
  const i = candles.findIndex((c) => c.ts >= tms);
  return i >= 0 ? candles[i] : null;
}

export function exitInsideBar(
  direction: string,
  exitPrice: number,
  bar: OhlcCandle | null,
): boolean {
  if (!bar || !Number.isFinite(exitPrice)) return true;
  const lo = Math.min(bar.low, bar.high);
  const hi = Math.max(bar.low, bar.high);
  return exitPrice >= lo - 1e-6 && exitPrice <= hi + 1e-6;
}

/** Bracket SL/TP disabled in config is stored as 0 — treat as absent for chart overlays. */
export function activeBracketPrice(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
