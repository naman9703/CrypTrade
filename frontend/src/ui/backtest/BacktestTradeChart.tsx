/**
 * OHLCV candlestick chart with trade entry / exit at fill prices on the correct bar.
 */
import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import { api } from "../../api/client";
import type { BacktestRunSummary, BacktestTrade } from "../../types/backtest";
import {
  barAtTradeTime,
  buildCandleChartSeries,
  chartTimeForTrade,
  exitInsideBar,
  formatChartTimeIST,
  nextChartTime,
  type OhlcCandle,
} from "./backtestChartTime";

const SUPPORTED_TFS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"];

type Props = {
  run: BacktestRunSummary | null;
  trades: BacktestTrade[];
};

const FALLBACK_CHART_TF = "1h";

/** Entry arrows (long ↑ / short ↓) + exit dots, each labeled with trade #. */
function buildTradeMarkers(
  trades: BacktestTrade[],
  candles: OhlcCandle[],
  chartTimesSec: number[],
  indexByTs: Map<number, number>,
): SeriesMarker<UTCTimestamp>[] {
  const sorted = [...trades].sort((a, b) => a.tradeNumber - b.tradeNumber);
  const markers: SeriesMarker<UTCTimestamp>[] = [];
  let lastSec = 0;

  for (const t of sorted) {
    const isLong = t.direction === "BUY";
    const longColor = "#22c55e";
    const shortColor = "#ef4444";

    if (t.entryTs && t.entryPrice != null && Number.isFinite(t.entryPrice)) {
      const base = chartTimeForTrade(t.entryTs, candles, chartTimesSec, indexByTs) as number;
      const time = nextChartTime(base, lastSec) as UTCTimestamp;
      lastSec = time as number;
      markers.push({
        time,
        position: isLong ? "belowBar" : "aboveBar",
        shape: isLong ? "arrowUp" : "arrowDown",
        color: isLong ? longColor : shortColor,
        text: `#${t.tradeNumber}`,
      });
    }

    if (t.exitTs && t.exitPrice != null && Number.isFinite(t.exitPrice)) {
      const base = chartTimeForTrade(t.exitTs, candles, chartTimesSec, indexByTs) as number;
      const time = nextChartTime(base, lastSec) as UTCTimestamp;
      lastSec = time as number;
      const win = Number(t.netPnl) >= 0;
      markers.push({
        time,
        position: isLong ? "aboveBar" : "belowBar",
        shape: "circle",
        color: win ? longColor : shortColor,
        text: `#${t.tradeNumber}`,
      });
    }
  }

  return markers.sort((a, b) => Number(a.time) - Number(b.time));
}

function buildSelectedTradeLine(
  t: BacktestTrade,
  candles: OhlcCandle[],
  chartTimesSec: number[],
  indexByTs: Map<number, number>,
): LineData[] | null {
  if (!t.exitTs || t.exitPrice == null) return null;
  const entryTime = chartTimeForTrade(t.entryTs, candles, chartTimesSec, indexByTs);
  const exitBase = chartTimeForTrade(t.exitTs, candles, chartTimesSec, indexByTs) as number;
  const exitTime =
    (exitBase as number) <= (entryTime as number)
      ? nextChartTime(exitBase, entryTime as number)
      : (exitBase as UTCTimestamp);
  return [
    { time: entryTime, value: t.entryPrice },
    { time: exitTime, value: t.exitPrice },
  ];
}

export function BacktestTradeChart({ run, trades }: Props) {
  const [chartTf, setChartTf] = useState<string>(
    run?.timeframe && SUPPORTED_TFS.includes(run.timeframe) ? run.timeframe : FALLBACK_CHART_TF,
  );
  const [candles, setCandles] = useState<OhlcCandle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedTrade, setSelectedTrade] = useState<BacktestTrade | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linkSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const fetchSeqRef = useRef(0);
  const indexByTsRef = useRef<Map<number, number>>(new Map());

  useEffect(() => {
    if (!run || run.status !== "done") {
      setCandles([]);
      setLoading(false);
      setError(null);
      return;
    }

    const fromMs = new Date(run.startDate).getTime();
    const toMs = new Date(run.endDate).getTime();
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
      setCandles([]);
      setLoading(false);
      setError("Invalid run date range");
      return;
    }

    const seq = ++fetchSeqRef.current;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.getBacktestCandles({
          symbol: run.symbol,
          timeframe: chartTf,
          from: fromMs,
          to: toMs,
        });
        if (fetchSeqRef.current !== seq) return;
        setCandles(Array.isArray(data.candles) ? data.candles : []);
      } catch (e) {
        if (fetchSeqRef.current !== seq) return;
        setError(String((e as Error).message ?? e));
      } finally {
        if (fetchSeqRef.current === seq) setLoading(false);
      }
    })();
  }, [run?.id, run?.status, run?.symbol, run?.startDate, run?.endDate, chartTf]);

  useEffect(() => {
    if (!chartRef.current) return;
    if (!candles.length) {
      try {
        candleSeries.current?.setMarkers([]);
      } catch {
        /* ignore */
      }
      chartApi.current?.remove();
      chartApi.current = null;
      candleSeries.current = null;
      linkSeries.current = null;
      priceLinesRef.current = [];
      return;
    }

    if (!chartApi.current) {
      chartApi.current = createChart(chartRef.current, {
        autoSize: true,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: "#94a3b8",
        },
        grid: {
          horzLines: { color: "rgba(148,163,184,0.15)" },
          vertLines: { color: "rgba(148,163,184,0.08)" },
        },
        localization: {
          timeFormatter: formatChartTimeIST,
        },
        timeScale: { borderVisible: false, timeVisible: true },
        rightPriceScale: { borderVisible: false },
        crosshair: { mode: 0 },
      });
      candleSeries.current = chartApi.current.addCandlestickSeries({
        upColor: "#22c55e",
        downColor: "#ef4444",
        borderVisible: false,
        wickUpColor: "#22c55e",
        wickDownColor: "#ef4444",
      });
      linkSeries.current = chartApi.current.addLineSeries({
        lineVisible: true,
        pointMarkersVisible: true,
        lastValueVisible: false,
        priceLineVisible: false,
        color: "#f59e0b",
        lineWidth: 2,
        lineStyle: 2,
      });
    }

    const { chartTimesSec, indexByTs } = buildCandleChartSeries(candles);
    indexByTsRef.current = indexByTs;

    const cdata: CandlestickData[] = candles.map((c, i) => ({
      time: chartTimesSec[i] as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    candleSeries.current?.setData(cdata);

    try {
      candleSeries.current?.setMarkers(
        buildTradeMarkers(trades, candles, chartTimesSec, indexByTs),
      );
    } catch {
      /* ignore */
    }

    const link = selectedTrade
      ? buildSelectedTradeLine(selectedTrade, candles, chartTimesSec, indexByTs)
      : null;
    linkSeries.current?.setData(link ?? []);

    for (const pl of priceLinesRef.current) {
      candleSeries.current?.removePriceLine(pl);
    }
    priceLinesRef.current = [];
    if (selectedTrade && candleSeries.current) {
      priceLinesRef.current.push(
        candleSeries.current.createPriceLine({
          price: selectedTrade.entryPrice,
          color: "#38bdf8",
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: `Entry #${selectedTrade.tradeNumber}`,
        }),
      );
      if (selectedTrade.exitPrice != null) {
        priceLinesRef.current.push(
          candleSeries.current.createPriceLine({
            price: selectedTrade.exitPrice,
            color: "#22c55e",
            lineWidth: 1,
            lineStyle: 2,
            axisLabelVisible: true,
            title: `Exit #${selectedTrade.tradeNumber}`,
          }),
        );
      }
      const exitBar = barAtTradeTime(selectedTrade.exitTs, candles, indexByTs);
      if (exitBar && selectedTrade.exitPrice != null) {
        const inside = exitInsideBar(selectedTrade.direction, selectedTrade.exitPrice, exitBar);
        if (!inside) {
          priceLinesRef.current.push(
            candleSeries.current.createPriceLine({
              price: exitBar.high,
              color: "#f97316",
              lineWidth: 1,
              lineStyle: 3,
              axisLabelVisible: true,
              title: "Bar high",
            }),
            candleSeries.current.createPriceLine({
              price: exitBar.low,
              color: "#f97316",
              lineWidth: 1,
              lineStyle: 3,
              axisLabelVisible: true,
              title: "Bar low",
            }),
          );
        }
      }
    }

    chartApi.current.timeScale().fitContent();

    return () => {};
  }, [candles, trades, selectedTrade]);

  useEffect(() => {
    return () => {
      chartApi.current?.remove();
      chartApi.current = null;
    };
  }, []);

  const tfOptions = SUPPORTED_TFS.filter((tf) =>
    ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"].includes(tf),
  );

  const tfMismatch = run && chartTf !== run.timeframe;

  const selectedExitBar =
    selectedTrade && candles.length
      ? barAtTradeTime(selectedTrade.exitTs, candles, indexByTsRef.current)
      : null;
  const exitOffBar =
    selectedTrade &&
    selectedExitBar &&
    selectedTrade.exitPrice != null &&
    !exitInsideBar(selectedTrade.direction, selectedTrade.exitPrice, selectedExitBar);

  if (!run) return null;

  return (
    <div className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950/60">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
        <div>
          <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Trade chart</h3>
          <p className="text-[11px] text-slate-500">
            {run.symbol} · ↑ long / ↓ short at entry, numbered · ○ exit (IST axis)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[11px] text-slate-500">
            TF
            <select
              className="ml-1 rounded border border-slate-200 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              value={chartTf}
              onChange={(e) => setChartTf(e.target.value)}
            >
              {tfOptions.map((tf) => (
                <option key={tf} value={tf}>
                  {tf}
                </option>
              ))}
            </select>
          </label>
          <label className="text-[11px] text-slate-500">
            Trade #
            <select
              className="ml-1 max-w-[5rem] rounded border border-slate-200 bg-white px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900"
              value={selectedTrade?.tradeNumber ?? ""}
              onChange={(e) => {
                const n = Number(e.target.value);
                setSelectedTrade(trades.find((t) => t.tradeNumber === n) ?? null);
              }}
            >
              <option value="">—</option>
              {trades.map((t) => (
                <option key={t.tradeNumber} value={t.tradeNumber}>
                  {t.tradeNumber}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {tfMismatch && (
        <p className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          Chart is on <strong>{chartTf}</strong> but this run used <strong>{run.timeframe}</strong> — switch TF to
          match for bar alignment.
        </p>
      )}

      {loading && (
        <p className="px-3 py-6 text-center text-sm text-slate-500">Loading candles…</p>
      )}
      {error && (
        <p className="px-3 py-4 text-center text-sm text-rose-600">{error}</p>
      )}
      {!loading && !error && !candles.length && (
        <p className="px-3 py-6 text-center text-sm text-slate-500">
          No stored candles for {run.symbol} / {chartTf}. Sync data first.
        </p>
      )}

      {selectedTrade && selectedExitBar && (
        <div className="border-b border-slate-100 px-3 py-2 text-[11px] dark:border-slate-800">
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            Trade #{selectedTrade.tradeNumber}
          </span>
          <span className="ml-2 text-slate-500">
            exit bar O/H/L/C: {selectedExitBar.open.toFixed(2)} / {selectedExitBar.high.toFixed(2)} /{" "}
            {selectedExitBar.low.toFixed(2)} / {selectedExitBar.close.toFixed(2)}
          </span>
          {selectedTrade.exitPrice != null && (
            <span className="ml-2 font-mono text-slate-600 dark:text-slate-300">
              fill {selectedTrade.exitPrice.toFixed(2)}
            </span>
          )}
          {exitOffBar && (
            <p className="mt-1 text-amber-700 dark:text-amber-300">
              Exit fill is outside this bar&apos;s range (stop + slippage on a bar that never traded there). Re-run
              the backtest to clamp bracket fills to OHLC; the marker will sit on the bar low/high.
            </p>
          )}
        </div>
      )}

      <div
        ref={chartRef}
        className="h-[min(420px,50vh)] w-full"
        style={{ display: candles.length && !loading ? "block" : "none" }}
      />

      <p className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400 dark:border-slate-800">
        Green ↑ = long entry · Red ↓ = short entry · Circle = exit (same #) · Orange dashed = selected trade · Dotted
        lines = exit bar range when fill is off-bar (legacy runs)
      </p>
    </div>
  );
}