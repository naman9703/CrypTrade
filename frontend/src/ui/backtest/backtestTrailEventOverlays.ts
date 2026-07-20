/**
 * Dynamic trail activation overlays for backtest trade chart (detail mode).
 */
import type { LineData, UTCTimestamp } from "lightweight-charts";
import type { BacktestTrade } from "../../types/backtest";
import { chartTimeForTrade, type OhlcCandle } from "./backtestChartTime.ts";

export type TrailEventSeries = {
  /** Favorable extreme when each tier armed. */
  activations: LineData[];
  /** Next-tier activation gate at each arm event. */
  nextGates: LineData[];
  /** Stepped SL path after each lock-in. */
  slPath: LineData[];
};

const TIER_COLORS: Record<string, string> = {
  T01: "#fbbf24",
  T02: "#fb923c",
  T1: "#a3e635",
  T2: "#34d399",
  T3: "#22d3ee",
  T0: "#fbbf24",
};

export function trailTierColor(tierLabel: string | null | undefined): string {
  if (!tierLabel) return "#fbbf24";
  return TIER_COLORS[tierLabel] ?? "#fbbf24";
}

function bumpTime(usedTimes: Map<number, number>, baseSec: number): UTCTimestamp {
  const n = usedTimes.get(baseSec) ?? 0;
  usedTimes.set(baseSec, n + 1);
  return (baseSec + n) as UTCTimestamp;
}

export function buildBacktestTrailEventSeries(
  trade: BacktestTrade,
  candles: OhlcCandle[],
  chartTimesSec: number[],
  indexByTs: Map<number, number>,
): TrailEventSeries {
  const events = trade.trailEvents;
  if (!events?.length || !candles.length || !chartTimesSec.length) {
    return { activations: [], nextGates: [], slPath: [] };
  }

  const activations: LineData[] = [];
  const nextGates: LineData[] = [];
  const slPath: LineData[] = [];
  const usedTimes = new Map<number, number>();

  for (const ev of events) {
    const tsMs = ev.ts != null ? Number(ev.ts) : NaN;
    if (!Number.isFinite(tsMs)) continue;
    const chartSec = chartTimeForTrade(tsMs, candles, chartTimesSec, indexByTs) as number;
    const time = bumpTime(usedTimes, chartSec);

    if (ev.favorablePx != null && Number.isFinite(ev.favorablePx)) {
      activations.push({ time, value: ev.favorablePx });
    }
    if (ev.nextActivationPx != null && Number.isFinite(ev.nextActivationPx)) {
      nextGates.push({ time, value: ev.nextActivationPx });
    }
    if (ev.slPrice != null && Number.isFinite(ev.slPrice)) {
      slPath.push({ time, value: ev.slPrice });
    }
  }

  const byTime = (a: LineData, b: LineData) => Number(a.time) - Number(b.time);
  activations.sort(byTime);
  nextGates.sort(byTime);
  slPath.sort(byTime);
  return { activations, nextGates, slPath };
}

export function hasBacktestTrailEvents(trade: BacktestTrade | null | undefined): boolean {
  return Boolean(trade?.trailEvents?.length);
}
