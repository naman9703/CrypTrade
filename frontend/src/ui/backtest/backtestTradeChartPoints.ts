/**
 * Lightweight trade point builders for backtest chart overview vs detail modes.
 */
import type { LineData, SeriesMarker, UTCTimestamp } from "lightweight-charts";
import type { BacktestTrade } from "../../types/backtest";
import { chartTimeForTrade, type OhlcCandle } from "./backtestChartTime";

function bumpTime(usedTimes: Map<number, number>, baseSec: number): UTCTimestamp {
  const n = usedTimes.get(baseSec) ?? 0;
  usedTimes.set(baseSec, n + 1);
  return (baseSec + n) as UTCTimestamp;
}

/** All entry + exit prices as dots — overview mode (no arrow/circle markers). */
export function buildAllTradePointSeries(
  trades: BacktestTrade[],
  candles: OhlcCandle[],
  chartTimesSec: number[],
  indexByTs: Map<number, number>,
): { entries: LineData[]; exits: LineData[] } {
  const entries: LineData[] = [];
  const exits: LineData[] = [];
  const usedTimes = new Map<number, number>();

  for (const t of trades) {
    if (t.entryTs && t.entryPrice != null && Number.isFinite(t.entryPrice)) {
      const base = chartTimeForTrade(t.entryTs, candles, chartTimesSec, indexByTs) as number;
      entries.push({ time: bumpTime(usedTimes, base), value: t.entryPrice });
    }
    if (t.exitTs && t.exitPrice != null && Number.isFinite(t.exitPrice)) {
      const base = chartTimeForTrade(t.exitTs, candles, chartTimesSec, indexByTs) as number;
      exits.push({ time: bumpTime(usedTimes, base), value: t.exitPrice });
    }
  }

  const byTime = (a: LineData, b: LineData) => Number(a.time) - Number(b.time);
  entries.sort(byTime);
  exits.sort(byTime);
  return { entries, exits };
}

/** Full markers for one trade — detail mode only. */
export function buildSingleTradeMarkers(
  trade: BacktestTrade,
  candles: OhlcCandle[],
  chartTimesSec: number[],
  indexByTs: Map<number, number>,
): SeriesMarker<UTCTimestamp>[] {
  const markers: SeriesMarker<UTCTimestamp>[] = [];
  const usedTimes = new Map<number, number>();
  const isLong = trade.direction === "BUY";
  const longColor = "#22c55e";
  const shortColor = "#ef4444";

  const bump = (baseSec: number): UTCTimestamp => bumpTime(usedTimes, baseSec);

  if (trade.entryTs && trade.entryPrice != null && Number.isFinite(trade.entryPrice)) {
    const base = chartTimeForTrade(trade.entryTs, candles, chartTimesSec, indexByTs) as number;
    markers.push({
      time: bump(base),
      position: isLong ? "belowBar" : "aboveBar",
      shape: isLong ? "arrowUp" : "arrowDown",
      color: isLong ? longColor : shortColor,
      text: `#${trade.tradeNumber}`,
    });
  }

  if (trade.exitTs && trade.exitPrice != null && Number.isFinite(trade.exitPrice)) {
    const base = chartTimeForTrade(trade.exitTs, candles, chartTimesSec, indexByTs) as number;
    const win = Number(trade.netPnl) >= 0;
    markers.push({
      time: bump(base),
      position: isLong ? "aboveBar" : "belowBar",
      shape: "circle",
      color: win ? longColor : shortColor,
      text: `#${trade.tradeNumber}`,
    });
  }

  return markers.sort((a, b) => Number(a.time) - Number(b.time));
}
