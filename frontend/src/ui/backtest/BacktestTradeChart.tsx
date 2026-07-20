/**
 * OHLCV candlestick chart with trade entry / exit at fill prices on the correct bar.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  LineStyle,
  LineType,
  type UTCTimestamp,
} from "lightweight-charts";
import { api } from "../../api/client";
import type { BacktestRunSummary, BacktestTrade } from "../../types/backtest";
import {
  barAtTradeTime,
  barIndexForTradeFill,
  buildCandleChartSeries,
  chartTimeForEntryFill,
  chartTimeForExitFill,
  exitInsideBar,
  formatChartTimeIST,
  formatTsIST,
  resolveTradeEntryFillMs,
  resolveTradeExitFillMs,
  activeBracketPrice,
  nextChartTime,
  type OhlcCandle,
  type TradeChartTiming,
} from "./backtestChartTime";
import {
  buildPositionPatternOverlay,
  buildStrategyTaOverlay,
  isTokyoSessionRun,
  buildTradeChartZoneSeries,
  type ChartPriceLineSpec,
} from "./backtestChartOverlays";
import {
  focusLogicalRangeForTrade,
  mergeTradeAndSmcMarkers,
  type SmcChartMarkup,
} from "./smcChartMarkup";
import {
  buildStrategyTradeMarkup,
  resolveStrategyMarkupKind,
  strategyMarkupToLayers,
} from "./strategyTradeMarkup";
import { SmcTradeSetupPanel } from "./SmcTradeSetupPanel";
import { LiquidityTradeSetupPanel } from "./LiquidityTradeSetupPanel";
import { ChartOverlayLegend } from "./ChartOverlayLegend";
import {
  buildDetailOverlayToggleList,
  defaultOverlayLayerState,
  filterTradeMarkers,
  formatMaeMfeLine,
  inferTaLineLayer,
  isOverlayLayerOn,
  type ChartOverlayLayerId,
} from "./backtestChartOverlayLayers";
import { approxBarCount } from "./backtestEta";
import {
  buildAllTradePointSeries,
  buildSingleTradeMarkers,
} from "./backtestTradeChartPoints";
import {
  buildBacktestTrailTierLines,
  isBacktestTrailingChartEnabled,
} from "./backtestTrailTierLines";
import { buildBacktestTrailEventSeries } from "./backtestTrailEventOverlays";
import { TrailTierLeftLabels } from "./TrailTierLeftLabels";

const SUPPORTED_TFS = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "6h", "8h", "12h", "1d"];

type Props = {
  run: BacktestRunSummary | null;
  trades: BacktestTrade[];
  selectedTrade?: BacktestTrade | null;
  onSelectTrade?: (trade: BacktestTrade | null) => void;
};

const FALLBACK_CHART_TF = "1h";

/** ~10 days of 1m bars — cap chart fetch unless a trade is selected (trade gets a padded window). */
const MAX_CHART_BARS_WITHOUT_TRADE = 14_400;
const TRADE_CHART_PAD_MS = 24 * 60 * 60_000;

function normalizeBacktestCandles(raw: unknown): OhlcCandle[] {
  if (!Array.isArray(raw)) return [];
  const byTs = new Map<number, OhlcCandle>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const ts = Number(r.ts);
    const open = Number(r.open);
    const high = Number(r.high);
    const low = Number(r.low);
    const close = Number(r.close);
    if (![ts, open, high, low, close].every(Number.isFinite)) continue;
    if (ts <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    byTs.set(ts, {
      ts,
      open,
      high: Math.max(high, open, low, close),
      low: Math.min(low, open, high, close),
      close,
    });
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

function buildSelectedTradeLine(
  t: BacktestTrade,
  candles: OhlcCandle[],
  chartTimesSec: number[],
  timing: TradeChartTiming,
): LineData[] | null {
  if (!t.exitTs || t.exitPrice == null) return null;
  const entryTime = chartTimeForEntryFill(t, candles, chartTimesSec, timing);
  const exitBase = chartTimeForExitFill(t, candles, chartTimesSec, timing) as number;
  const exitTime =
    (exitBase as number) <= (entryTime as number)
      ? nextChartTime(exitBase, entryTime as number)
      : (exitBase as UTCTimestamp);
  const entryPx =
    t.entryMarkPx != null && Number.isFinite(t.entryMarkPx) ? t.entryMarkPx : t.entryPrice;
  return [
    { time: entryTime, value: entryPx },
    { time: exitTime, value: t.exitPrice },
  ];
}

function utcDayId(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

function utcWeekId(ms: number): number {
  return Math.floor(ms / (7 * 86_400_000));
}

function buildSrLevels(candles: OhlcCandle[]): {
  prevDayHigh: Array<number | null>;
  prevDayLow: Array<number | null>;
  prevWeekHigh: Array<number | null>;
  prevWeekLow: Array<number | null>;
} {
  const n = candles.length;
  const prevDayHigh = new Array<number | null>(n).fill(null);
  const prevDayLow = new Array<number | null>(n).fill(null);
  const prevWeekHigh = new Array<number | null>(n).fill(null);
  const prevWeekLow = new Array<number | null>(n).fill(null);

  let curDay: number | null = null;
  let dayHigh = -Infinity;
  let dayLow = Infinity;
  let pDayHigh: number | null = null;
  let pDayLow: number | null = null;

  let curWeek: number | null = null;
  let weekHigh = -Infinity;
  let weekLow = Infinity;
  let pWeekHigh: number | null = null;
  let pWeekLow: number | null = null;

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    prevDayHigh[i] = pDayHigh;
    prevDayLow[i] = pDayLow;
    prevWeekHigh[i] = pWeekHigh;
    prevWeekLow[i] = pWeekLow;

    const d = utcDayId(c.ts);
    const w = utcWeekId(c.ts);

    if (curWeek == null) curWeek = w;
    if (w !== curWeek) {
      pWeekHigh = Number.isFinite(weekHigh) ? weekHigh : null;
      pWeekLow = Number.isFinite(weekLow) ? weekLow : null;
      curWeek = w;
      weekHigh = c.high;
      weekLow = c.low;
    } else {
      weekHigh = Math.max(weekHigh, c.high);
      weekLow = Math.min(weekLow, c.low);
    }

    if (curDay == null) curDay = d;
    if (d !== curDay) {
      pDayHigh = Number.isFinite(dayHigh) ? dayHigh : null;
      pDayLow = Number.isFinite(dayLow) ? dayLow : null;
      curDay = d;
      dayHigh = c.high;
      dayLow = c.low;
    } else {
      dayHigh = Math.max(dayHigh, c.high);
      dayLow = Math.min(dayLow, c.low);
    }
  }

  return { prevDayHigh, prevDayLow, prevWeekHigh, prevWeekLow };
}

/** Step-line data: only points where the level changes (avoids 10k+ points on long backtests). */
function lineFromLevels(
  chartTimesSec: number[],
  levels: Array<number | null>,
): LineData[] {
  const out: LineData[] = [];
  let lastV: number | null = null;
  for (let i = 0; i < chartTimesSec.length; i++) {
    const v = levels[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (v !== lastV) {
      out.push({ time: chartTimesSec[i] as UTCTimestamp, value: v });
      lastV = v;
    }
  }
  return out;
}

function readVisibleLogicalRange(chart: IChartApi | null): { from: number; to: number } | null {
  if (!chart) return null;
  try {
    const lr = chart.timeScale().getVisibleLogicalRange();
    if (lr && Number.isFinite(lr.from) && Number.isFinite(lr.to)) {
      return { from: lr.from, to: lr.to };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Bar padding when zooming to a selected trade — tighter on lower TFs. */
function focusPadBarsForChartTf(chartTf: string): number {
  switch (chartTf) {
    case "1m":
      return 18;
    case "5m":
      return 16;
    case "15m":
      return 14;
    case "30m":
      return 12;
    case "1h":
      return 10;
    case "2h":
    case "4h":
      return 8;
    case "1d":
      return 6;
    default:
      return 12;
  }
}

function restoreVisibleLogicalRange(
  chart: IChartApi | null,
  range: { from: number; to: number } | null,
): void {
  if (!chart || !range) return;
  try {
    chart.timeScale().setVisibleLogicalRange(range);
  } catch {
    /* ignore */
  }
}

/** Backtest snapshots store bot cfg under `configSnapshot.bot` (same as backend `pickBotFromConfigSnapshot`). */
function botFromRunConfig(run: BacktestRunSummary | null): Record<string, unknown> {
  if (!run) return {};
  const cfg = (run.configSnapshot ?? {}) as Record<string, unknown>;
  if (cfg.bot && typeof cfg.bot === "object" && !Array.isArray(cfg.bot)) {
    return cfg.bot as Record<string, unknown>;
  }
  return cfg;
}

function manualStrategyFromRun(run: BacktestRunSummary | null): string {
  const bot = botFromRunConfig(run);
  const cfg = (run?.configSnapshot ?? {}) as Record<string, unknown>;
  return String(bot.manualStrategy ?? cfg.manualStrategy ?? "").toUpperCase();
}

function shouldShowSessionSrOverlays(run: BacktestRunSummary | null): boolean {
  const strat = manualStrategyFromRun(run);
  if (strat === "SR_INTRADAY" || strat === "INTRADAY_PRO") return true;
  const bot = botFromRunConfig(run);
  if (bot.intradayGateLiquidity === true || bot.intradayGateInstitutionalSr === true) return true;
  if (bot.intradayGateSmcIct === true || bot.intradaySmcIctMode === true) return true;
  return false;
}

function applyPriceLineSpecs(
  series: ISeriesApi<"Candlestick"> | null,
  existing: IPriceLine[],
  specs: ChartPriceLineSpec[],
): IPriceLine[] {
  if (!series) return [];
  for (const pl of existing) {
    series.removePriceLine(pl);
  }
  return specs.map((spec) =>
    series.createPriceLine({
      price: spec.price,
      color: spec.color,
      lineWidth: spec.lineWidth ?? 1,
      lineStyle: spec.lineStyle ?? LineStyle.Dashed,
      axisLabelVisible: spec.axisLabelVisible ?? true,
      title: spec.title,
    }),
  );
}

export function BacktestTradeChart({ run, trades, selectedTrade: selectedProp, onSelectTrade }: Props) {
  const [chartTf, setChartTf] = useState<string>(
    run?.timeframe && SUPPORTED_TFS.includes(run.timeframe) ? run.timeframe : FALLBACK_CHART_TF,
  );
  const [candles, setCandles] = useState<OhlcCandle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [internalSelected, setInternalSelected] = useState<BacktestTrade | null>(null);
  const [showTaDrawing, setShowTaDrawing] = useState(true);
  const [showPositionPattern, setShowPositionPattern] = useState(true);
  const [overlayLayers, setOverlayLayers] = useState(defaultOverlayLayerState);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    if (!fullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [fullscreen]);

  const toggleOverlayLayer = useCallback((id: ChartOverlayLayerId) => {
    setOverlayLayers((prev) => ({ ...prev, [id]: !isOverlayLayerOn(prev, id) }));
  }, []);
  const selectedTrade = selectedProp !== undefined ? selectedProp : internalSelected;
  const setSelectedTrade = (t: BacktestTrade | null) => {
    if (onSelectTrade) onSelectTrade(t);
    else setInternalSelected(t);
  };
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartApi = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const linkSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const overviewEntrySeries = useRef<ISeriesApi<"Line"> | null>(null);
  const overviewExitSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const trailActivationSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const trailNextGateSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const trailSlPathSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const srDayHighSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const srDayLowSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const srWeekHighSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const srWeekLowSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const trailTierLinesRef = useRef<IPriceLine[]>([]);
  const taPriceLinesRef = useRef<IPriceLine[]>([]);
  const patternPriceLinesRef = useRef<IPriceLine[]>([]);
  const zoneRiskTopSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const zoneRiskBottomSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const zoneRewardTopSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const zoneRewardBottomSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const zoneTokyoTopSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const zoneTokyoBottomSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const taZoneSeriesPool = useRef<ISeriesApi<"Line">[]>([]);
  const fetchSeqRef = useRef(0);
  const selectedTradeNumber = selectedTrade?.tradeNumber ?? null;
  const detailMode = selectedTradeNumber != null;
  const indexByTsRef = useRef<Map<number, number>>(new Map());
  const chartSeriesKeyRef = useRef("");
  const chartTimesSecRef = useRef<number[]>([]);
  const focusedTradeRef = useRef<number | null>(null);
  const overviewFitRef = useRef(false);
  const lastChartModeRef = useRef<"overview" | "detail">("overview");
  const [chartRev, setChartRev] = useState(0);

  const tradeForOverlays = useMemo(() => {
    if (selectedTradeNumber == null) return null;
    return trades.find((t) => t.tradeNumber === selectedTradeNumber) ?? selectedTrade;
  }, [trades, selectedTradeNumber, selectedTrade]);

  /** Portfolio runs: load candles for the selected trade's coin (or first universe symbol). */
  const chartSymbol = useMemo(() => {
    if (tradeForOverlays?.symbol) return String(tradeForOverlays.symbol);
    if (run.isPortfolio && run.symbols?.length) return run.symbols[0]!;
    return run.symbol;
  }, [run.isPortfolio, run.symbol, run.symbols, tradeForOverlays?.symbol]);

  const showSessionSrOverlays = useMemo(
    () => shouldShowSessionSrOverlays(run),
    [run?.id, run?.configSnapshot],
  );
  const runStrategyLabel = useMemo(() => manualStrategyFromRun(run) || "—", [run?.id, run?.configSnapshot]);
  const candlesSeriesKey = useMemo(() => {
    if (!candles.length) return "";
    const first = candles[0]!.ts;
    const last = candles[candles.length - 1]!.ts;
    return `${run?.id ?? ""}|${chartTf}|${candles.length}|${first}|${last}`;
  }, [run?.id, chartTf, candles]);

  const chartSeries = useMemo(() => {
    if (!candles.length) return null;
    return buildCandleChartSeries(candles);
  }, [candlesSeriesKey, candles]);

  const srLineData = useMemo(() => {
    if (!detailMode || !showSessionSrOverlays || !candles.length || !chartSeries) return null;
    const sr = buildSrLevels(candles);
    const { chartTimesSec } = chartSeries;
    return {
      prevDayHigh: lineFromLevels(chartTimesSec, sr.prevDayHigh),
      prevDayLow: lineFromLevels(chartTimesSec, sr.prevDayLow),
      prevWeekHigh: lineFromLevels(chartTimesSec, sr.prevWeekHigh),
      prevWeekLow: lineFromLevels(chartTimesSec, sr.prevWeekLow),
    };
  }, [detailMode, showSessionSrOverlays, candlesSeriesKey, candles, chartSeries]);

  const candlestickData = useMemo((): CandlestickData[] => {
    if (!chartSeries || !candles.length) return [];
    const { chartTimesSec } = chartSeries;
    return candles.map((c, i) => ({
      time: chartTimesSec[i] as UTCTimestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
  }, [candlesSeriesKey, candles, chartSeries]);

  const chartTiming = useMemo((): TradeChartTiming | null => {
    if (!run?.timeframe) return null;
    return { chartTf, runTimeframe: run.timeframe, engineType: run.engineType };
  }, [chartTf, run?.timeframe, run?.engineType]);

  const trailTierLineSpecs = useMemo(() => {
    if (!run || !tradeForOverlays) return [];
    return buildBacktestTrailTierLines(run, tradeForOverlays);
  }, [run, tradeForOverlays]);

  const trailEventSeries = useMemo(() => {
    if (!tradeForOverlays || !chartSeries || !candles.length) {
      return { activations: [], nextGates: [], slPath: [] };
    }
    return buildBacktestTrailEventSeries(
      tradeForOverlays,
      candles,
      chartSeries.chartTimesSec,
      chartSeries.indexByTs,
    );
  }, [tradeForOverlays, candlesSeriesKey, candles, chartSeries]);

  const showTrailTierChart = isBacktestTrailingChartEnabled(run);

  const overviewPoints = useMemo(() => {
    if (detailMode || !chartSeries || !trades.length || !chartTiming) return null;
    return buildAllTradePointSeries(
      trades,
      candles,
      chartSeries.chartTimesSec,
      chartTiming,
    );
  }, [detailMode, trades, candlesSeriesKey, candles, chartSeries, chartTiming]);

  const runBotCfg = useMemo(() => botFromRunConfig(run), [run?.id, run?.configSnapshot]);

  const smcLegendMarkup = useMemo((): SmcChartMarkup | null => {
    if (!detailMode || !tradeForOverlays || !showTaDrawing || !candles.length) return null;
    return buildStrategyTradeMarkup(candles, tradeForOverlays, run, runBotCfg, chartTf);
  }, [detailMode, tradeForOverlays?.tradeNumber, showTaDrawing, candlesSeriesKey, run?.id, runBotCfg, candles, tradeForOverlays, run, chartTf]);

  const focusChartOnTrade = useCallback(
    (trade: BacktestTrade) => {
      if (!chartApi.current || !candles.length || !chartSeries) return;
      const range = smcLegendMarkup
        ? { from: smcLegendMarkup.focusFromIdx, to: smcLegendMarkup.focusToIdx }
        : focusLogicalRangeForTrade(
            trade,
            candles,
            chartSeries.indexByTs,
            focusPadBarsForChartTf(chartTf),
            chartTiming ?? undefined,
          );
      if (!range) return;
      try {
        chartApi.current.timeScale().setVisibleLogicalRange(range);
        focusedTradeRef.current = trade.tradeNumber;
      } catch {
        /* ignore */
      }
    },
    [candles, chartSeries, smcLegendMarkup, chartTf, chartTiming],
  );

  const smcLayers = useMemo(() => {
    if (!smcLegendMarkup || !chartSeries) return null;
    return strategyMarkupToLayers(smcLegendMarkup, chartSeries.chartTimesSec);
  }, [smcLegendMarkup, chartSeries]);

  const detailTradeMarkers = useMemo(() => {
    if (!detailMode || !tradeForOverlays || !chartSeries || !chartTiming) return [];
    const base = buildSingleTradeMarkers(
      tradeForOverlays,
      candles,
      chartSeries.chartTimesSec,
      chartTiming,
    );
    if (!smcLayers?.markers.length) return base;
    return mergeTradeAndSmcMarkers(base, smcLayers.markers);
  }, [detailMode, tradeForOverlays, candlesSeriesKey, candles, chartSeries, smcLayers, chartTiming]);

  useEffect(() => {
    if (!run || run.status !== "done") {
      setCandles([]);
      setLoading(false);
      setError(null);
      return;
    }

    const runFromMs = new Date(run.startDate).getTime();
    const runToMs = new Date(run.endDate).getTime();
    if (!Number.isFinite(runFromMs) || !Number.isFinite(runToMs)) {
      setCandles([]);
      setLoading(false);
      setError("Invalid run date range");
      return;
    }

    const estBars = approxBarCount(run.startDate, run.endDate, chartTf);
    const trade = tradeForOverlays;
    let fromMs = runFromMs;
    let toMs = runToMs;

    if (trade?.entryTs != null && run?.timeframe) {
      const entryMs = resolveTradeEntryFillMs(trade, run.timeframe, run.engineType);
      const exitMs = trade.exitTs != null ? resolveTradeExitFillMs(trade, run.timeframe) : entryMs;
      if (Number.isFinite(entryMs)) {
        fromMs = Math.max(runFromMs, entryMs - TRADE_CHART_PAD_MS);
        toMs = Math.min(runToMs, (Number.isFinite(exitMs) ? exitMs : entryMs) + TRADE_CHART_PAD_MS);
      }
    } else if (estBars > MAX_CHART_BARS_WITHOUT_TRADE) {
      setCandles([]);
      setLoading(false);
      setError(
        `Too many ${chartTf} bars (~${estBars.toLocaleString()}) for the full run — pick a Trade # first, then switch to ${chartTf}.`,
      );
      return;
    }

    const seq = ++fetchSeqRef.current;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const bot = botFromRunConfig(run);
        const marketMode = String(bot.marketMode ?? bot.market ?? "FUTURES").toUpperCase();
        const data = await api.getBacktestCandles({
          symbol: chartSymbol,
          timeframe: chartTf,
          from: fromMs,
          to: toMs,
          market: marketMode === "SPOT" ? "spot" : "futures",
        });
        if (fetchSeqRef.current !== seq) return;
        setCandles(normalizeBacktestCandles(data.candles));
      } catch (e) {
        if (fetchSeqRef.current !== seq) return;
        setError(String((e as Error).message ?? e));
      } finally {
        if (fetchSeqRef.current === seq) setLoading(false);
      }
    })();
  }, [run?.id, run?.status, run?.timeframe, run?.engineType, chartSymbol, run?.startDate, run?.endDate, chartTf, tradeForOverlays?.tradeNumber, tradeForOverlays?.entryTs, tradeForOverlays?.exitTs, tradeForOverlays?.entryFillTs]);

  const strategyMarkupKind = useMemo(
    () => (detailMode ? resolveStrategyMarkupKind(run, tradeForOverlays) : "none"),
    [detailMode, run, tradeForOverlays],
  );

  const taOverlay =
    detailMode && tradeForOverlays && showTaDrawing && run && !smcLegendMarkup?.hlines.length
      ? buildStrategyTaOverlay(run, tradeForOverlays)
      : null;
  const patternOverlay =
    detailMode && tradeForOverlays && showPositionPattern
      ? buildPositionPatternOverlay(tradeForOverlays)
      : null;

  const overlayToggleList = useMemo(() => {
    const items = buildDetailOverlayToggleList({
      showSessionSr: showSessionSrOverlays,
      hasTrade: tradeForOverlays != null,
      trade: tradeForOverlays,
      markup: smcLegendMarkup,
      taOverlay,
      patternLegend: patternOverlay?.legend,
      strategyKind: strategyMarkupKind,
      showTrailTiers: showTrailTierChart,
    });
    const maeLine = tradeForOverlays ? formatMaeMfeLine(tradeForOverlays) : null;
    if (!maeLine) return items;
    return items.map((it) => (it.id === "mae_mfe" ? { ...it, label: maeLine } : it));
  }, [
    showSessionSrOverlays,
    tradeForOverlays,
    smcLegendMarkup,
    taOverlay,
    patternOverlay?.legend,
    strategyMarkupKind,
    showTrailTierChart,
    trailTierLineSpecs.length,
  ]);

  const clearDetailOverlays = useCallback(() => {
    try {
      candleSeries.current?.setMarkers([]);
    } catch {
      /* ignore */
    }
    linkSeries.current?.setData([]);
    priceLinesRef.current = applyPriceLineSpecs(candleSeries.current, priceLinesRef.current, []);
    trailTierLinesRef.current = applyPriceLineSpecs(
      candleSeries.current,
      trailTierLinesRef.current,
      [],
    );
    zoneRiskTopSeries.current?.setData([]);
    zoneRiskBottomSeries.current?.setData([]);
    zoneRewardTopSeries.current?.setData([]);
    zoneRewardBottomSeries.current?.setData([]);
    zoneTokyoTopSeries.current?.setData([]);
    zoneTokyoBottomSeries.current?.setData([]);
    for (const series of taZoneSeriesPool.current) series?.setData([]);
    srDayHighSeries.current?.setData([]);
    srDayLowSeries.current?.setData([]);
    srWeekHighSeries.current?.setData([]);
    srWeekLowSeries.current?.setData([]);
    trailActivationSeries.current?.setData([]);
    trailNextGateSeries.current?.setData([]);
    trailSlPathSeries.current?.setData([]);
  }, []);

  const applyTradeOverlays = useCallback(() => {
    if (!candles.length || !candleSeries.current || !chartSeries) return;

    const chartTimesSec = chartSeries.chartTimesSec;
    const indexByTs = chartSeries.indexByTs;
    chartTimesSecRef.current = chartTimesSec;
    indexByTsRef.current = indexByTs;

    if (!detailMode) {
      if (lastChartModeRef.current === "detail") overviewFitRef.current = false;
      lastChartModeRef.current = "overview";
      clearDetailOverlays();
      overviewEntrySeries.current?.setData(overviewPoints?.entries ?? []);
      overviewExitSeries.current?.setData(overviewPoints?.exits ?? []);
      if (!overviewFitRef.current) {
        try {
          chartApi.current?.timeScale().fitContent();
          overviewFitRef.current = true;
        } catch {
          /* ignore */
        }
      }
      focusedTradeRef.current = null;
      return;
    }

    lastChartModeRef.current = "detail";
    overviewFitRef.current = false;
    overviewEntrySeries.current?.setData([]);
    overviewExitSeries.current?.setData([]);

    const trade = tradeForOverlays;
    const layerOn = (id: ChartOverlayLayerId) => isOverlayLayerOn(overlayLayers, id);

    try {
      candleSeries.current.setMarkers(filterTradeMarkers(detailTradeMarkers, overlayLayers));
    } catch {
      /* ignore */
    }

    const link = trade && chartTiming ? buildSelectedTradeLine(trade, candles, chartTimesSec, chartTiming) : null;
    linkSeries.current?.setData(layerOn("trade_link") && link ? link : []);

    type TaggedBracket = ChartPriceLineSpec & { layer: ChartOverlayLayerId };
    const bracketSpecs: TaggedBracket[] = [];
    if (trade) {
      bracketSpecs.push({
        price: trade.entryPrice,
        color: "#38bdf8",
        title: `Entry #${trade.tradeNumber}`,
        lineStyle: LineStyle.Dashed,
        layer: "bracket_entry",
      });
      const sl = activeBracketPrice(trade.slPrice);
      if (sl != null) {
        bracketSpecs.push({
          price: sl,
          color: "#ef4444",
          title: `SL #${trade.tradeNumber}`,
          lineStyle: LineStyle.Dashed,
          layer: "bracket_sl",
        });
      }
      const tp = activeBracketPrice(trade.tpPrice);
      if (tp != null) {
        bracketSpecs.push({
          price: tp,
          color: "#a855f7",
          title: `TP #${trade.tradeNumber}`,
          lineStyle: LineStyle.Dashed,
          layer: "bracket_tp",
        });
      }
      if (trade.exitPrice != null) {
        bracketSpecs.push({
          price: trade.exitPrice,
          color: "#22c55e",
          title: `Exit #${trade.tradeNumber}`,
          lineStyle: LineStyle.Solid,
          layer: "bracket_exit",
        });
      }
      const exitBar = barAtTradeTime(trade.exitTs, candles, indexByTs);
      if (exitBar && trade.exitPrice != null) {
        const inside = exitInsideBar(trade.direction, trade.exitPrice, exitBar);
        if (!inside) {
          bracketSpecs.push(
            {
              price: exitBar.high,
              color: "#f97316",
              title: "Bar high",
              lineStyle: 3,
              layer: "bracket_exit",
            },
            {
              price: exitBar.low,
              color: "#f97316",
              title: "Bar low",
              lineStyle: 3,
              layer: "bracket_exit",
            },
          );
        }
      }
      if (strategyMarkupKind === "liquidity" && trade.liqContext) {
        const lc = trade.liqContext as Record<string, unknown>;
        const isSupport = trade.direction === "BUY";
        const lt = String(lc.levelType ?? "").toUpperCase();
        const srLevel = Number(lc.level);
        const opposing = Number(lc.opposingLevel);
        if (Number.isFinite(srLevel) && srLevel > 0) {
          bracketSpecs.push({
            price: srLevel,
            color: isSupport ? "#2dd4bf" : "#fb923c",
            title: `${isSupport ? "Support" : "Resistance"}${lt ? ` ${lt}` : ""}`,
            lineStyle: LineStyle.Solid,
            lineWidth: 2,
            layer: "liq_sr_zone",
          });
        }
        if (Number.isFinite(opposing) && opposing > 0) {
          bracketSpecs.push({
            price: opposing,
            color: "#c084fc",
            title: `Liq target ${isSupport ? "(resistance)" : "(support)"}`,
            lineStyle: LineStyle.Dotted,
            lineWidth: 2,
            layer: "liq_opposing",
          });
        }
      }
    }
    priceLinesRef.current = applyPriceLineSpecs(
      candleSeries.current,
      priceLinesRef.current,
      bracketSpecs.filter((s) => layerOn(s.layer)).map(({ layer: _layer, ...spec }) => spec),
    );
    trailTierLinesRef.current = applyPriceLineSpecs(
      candleSeries.current,
      trailTierLinesRef.current,
      showTrailTierChart && layerOn("trail_tiers") ? trailTierLineSpecs : [],
    );

    const showTrailEvents = showTrailTierChart && layerOn("trail_tiers");
    trailActivationSeries.current?.setData(showTrailEvents ? trailEventSeries.activations : []);
    trailNextGateSeries.current?.setData(showTrailEvents ? trailEventSeries.nextGates : []);
    trailSlPathSeries.current?.setData(showTrailEvents ? trailEventSeries.slPath : []);

    if (srLineData) {
      srDayHighSeries.current?.setData(layerOn("session_pdh") ? srLineData.prevDayHigh : []);
      srDayLowSeries.current?.setData(layerOn("session_pdl") ? srLineData.prevDayLow : []);
      srWeekHighSeries.current?.setData(layerOn("session_pwh") ? srLineData.prevWeekHigh : []);
      srWeekLowSeries.current?.setData(layerOn("session_pwl") ? srLineData.prevWeekLow : []);
    } else {
      srDayHighSeries.current?.setData([]);
      srDayLowSeries.current?.setData([]);
      srWeekHighSeries.current?.setData([]);
      srWeekLowSeries.current?.setData([]);
    }

    const zones =
      trade && run && (!smcLayers?.taLines?.length || isTokyoSessionRun(run))
        ? buildTradeChartZoneSeries(run, trade, candles, chartTimesSec, indexByTs, {
            showTa: showTaDrawing,
            showPattern: showPositionPattern,
            chartTf,
          })
        : null;

    zoneRiskTopSeries.current?.setData(
      showPositionPattern && layerOn("risk_band") && zones ? zones.riskTop : [],
    );
    zoneRiskBottomSeries.current?.setData(
      showPositionPattern && layerOn("risk_band") && zones ? zones.riskBottom : [],
    );
    zoneRewardTopSeries.current?.setData(
      showPositionPattern && layerOn("reward_band") && zones ? zones.rewardTop : [],
    );
    zoneRewardBottomSeries.current?.setData(
      showPositionPattern && layerOn("reward_band") && zones ? zones.rewardBottom : [],
    );
    zoneTokyoTopSeries.current?.setData(
      layerOn("tokyo_session_box") && zones ? zones.tokyoBoxTop : [],
    );
    zoneTokyoBottomSeries.current?.setData(
      layerOn("tokyo_session_box") && zones ? zones.tokyoBoxBottom : [],
    );

    const taLines = smcLayers?.taLines?.length ? smcLayers.taLines : zones?.taLines ?? [];
    for (let i = 0; i < taZoneSeriesPool.current.length; i++) {
      const series = taZoneSeriesPool.current[i];
      const line = taLines[i];
      if (!series) continue;
      const layer = line?.layer ?? (line ? inferTaLineLayer(line.color, line.lineWidth) : null);
      if (line?.data.length && layer && !layerOn(layer)) {
        series.setData([]);
        continue;
      }
      if (line?.data.length) {
        series.applyOptions({
          color: line.color,
          lineStyle: line.lineStyle ?? LineStyle.Solid,
          lineWidth: (line.lineWidth ?? 2) as 1 | 2 | 3 | 4,
          visible: true,
        });
        series.setData(line.data);
      } else {
        series.setData([]);
      }
    }

  }, [
    candles,
    chartSeries,
    detailMode,
    tradeForOverlays,
    showTaDrawing,
    showPositionPattern,
    run,
    smcLayers,
    smcLegendMarkup,
    strategyMarkupKind,
    detailTradeMarkers,
    overviewPoints,
    srLineData,
    overlayLayers,
    chartTiming,
    chartTf,
    clearDetailOverlays,
    showTrailTierChart,
    trailTierLineSpecs,
    trailEventSeries,
  ]);

  /** Candle + S/R series — only when candle payload changes; never reset pan/zoom on trade pick. */
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
      overviewEntrySeries.current = null;
      overviewExitSeries.current = null;
      trailActivationSeries.current = null;
      trailNextGateSeries.current = null;
      trailSlPathSeries.current = null;
      srDayHighSeries.current = null;
      srDayLowSeries.current = null;
      srWeekHighSeries.current = null;
      srWeekLowSeries.current = null;
      zoneRiskTopSeries.current = null;
      zoneRiskBottomSeries.current = null;
      zoneRewardTopSeries.current = null;
      zoneRewardBottomSeries.current = null;
      zoneTokyoTopSeries.current = null;
      zoneTokyoBottomSeries.current = null;
      taZoneSeriesPool.current = [];
      priceLinesRef.current = [];
      trailTierLinesRef.current = [];
      taPriceLinesRef.current = [];
      patternPriceLinesRef.current = [];
      chartSeriesKeyRef.current = "";
      chartTimesSecRef.current = [];
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
        handleScroll: true,
        handleScale: true,
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
      const overviewPointOpts = {
        lineVisible: false,
        pointMarkersVisible: true,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        lineWidth: 2 as const,
      };
      overviewEntrySeries.current = chartApi.current.addLineSeries({
        ...overviewPointOpts,
        color: "#22c55e",
      });
      overviewExitSeries.current = chartApi.current.addLineSeries({
        ...overviewPointOpts,
        color: "#94a3b8",
      });
      const trailPointOpts = {
        lineVisible: false,
        pointMarkersVisible: true,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: true,
        lineWidth: 2 as const,
      };
      trailActivationSeries.current = chartApi.current.addLineSeries({
        ...trailPointOpts,
        color: "#fbbf24",
      });
      trailNextGateSeries.current = chartApi.current.addLineSeries({
        ...trailPointOpts,
        color: "#fb923c",
      });
      trailSlPathSeries.current = chartApi.current.addLineSeries({
        lineVisible: true,
        pointMarkersVisible: true,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        color: "#22d3ee",
        lineWidth: 2,
        lineStyle: LineStyle.Dotted,
        lineType: LineType.WithSteps,
      });
      const srLineOpts = {
        lineWidth: 2 as const,
        lineType: LineType.WithSteps,
        lastValueVisible: false,
        priceLineVisible: false,
      };
      srDayHighSeries.current = chartApi.current.addLineSeries({
        ...srLineOpts,
        color: "#60a5fa",
        lineStyle: LineStyle.Dotted,
      });
      srDayLowSeries.current = chartApi.current.addLineSeries({
        ...srLineOpts,
        color: "#34d399",
        lineStyle: LineStyle.Dotted,
      });
      srWeekHighSeries.current = chartApi.current.addLineSeries({
        ...srLineOpts,
        color: "#818cf8",
        lineStyle: LineStyle.Dashed,
      });
      srWeekLowSeries.current = chartApi.current.addLineSeries({
        ...srLineOpts,
        color: "#f59e0b",
        lineStyle: LineStyle.Dashed,
      });
      const zoneOpts = {
        lineWidth: 3 as const,
        lineType: LineType.Simple,
        lastValueVisible: true,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      };
      zoneRiskTopSeries.current = chartApi.current.addLineSeries({
        ...zoneOpts,
        color: "rgba(248,113,113,0.95)",
        lineStyle: LineStyle.Solid,
      });
      zoneRiskBottomSeries.current = chartApi.current.addLineSeries({
        ...zoneOpts,
        color: "rgba(248,113,113,0.55)",
        lineStyle: LineStyle.Dashed,
      });
      zoneRewardTopSeries.current = chartApi.current.addLineSeries({
        ...zoneOpts,
        color: "rgba(74,222,128,0.95)",
        lineStyle: LineStyle.Solid,
      });
      zoneRewardBottomSeries.current = chartApi.current.addLineSeries({
        ...zoneOpts,
        color: "rgba(74,222,128,0.55)",
        lineStyle: LineStyle.Dashed,
      });
      zoneTokyoTopSeries.current = chartApi.current.addLineSeries({
        ...zoneOpts,
        color: "rgba(251,146,60,0.95)",
        lineStyle: LineStyle.Solid,
      });
      zoneTokyoBottomSeries.current = chartApi.current.addLineSeries({
        ...zoneOpts,
        color: "rgba(251,146,60,0.55)",
        lineStyle: LineStyle.Dashed,
      });
      taZoneSeriesPool.current = [];
      for (let i = 0; i < 14; i++) {
        taZoneSeriesPool.current.push(
          chartApi.current.addLineSeries({
            lineWidth: 2,
            lineType: LineType.Simple,
            lastValueVisible: true,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          }),
        );
      }
      setChartRev((v) => v + 1);
    }

    const isNewSeries = chartSeriesKeyRef.current !== candlesSeriesKey;
    if (isNewSeries) {
      focusedTradeRef.current = null;
      overviewFitRef.current = false;
    }
    const visibleRange = isNewSeries ? null : readVisibleLogicalRange(chartApi.current);

    if (!chartSeries) return;
    const { chartTimesSec, indexByTs } = chartSeries;
    indexByTsRef.current = indexByTs;
    chartTimesSecRef.current = chartTimesSec;
    chartSeriesKeyRef.current = candlesSeriesKey;

    candleSeries.current?.setData(candlestickData);

    if (!isNewSeries) {
      restoreVisibleLogicalRange(chartApi.current, visibleRange);
    }
  }, [candles, candlesSeriesKey, chartSeries, candlestickData, fullscreen]);

  /** Re-zoom whenever the user picks a different trade (table, dropdown, or chart). */
  useEffect(() => {
    focusedTradeRef.current = null;
    if (selectedTradeNumber != null) {
      window.requestAnimationFrame(() => {
        chartRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    }
  }, [selectedTradeNumber]);

  useEffect(() => {
    if (!detailMode || !tradeForOverlays || !candles.length || !chartSeries || loading) return;
    if (focusedTradeRef.current === tradeForOverlays.tradeNumber) return;
    focusChartOnTrade(tradeForOverlays);
  }, [
    detailMode,
    tradeForOverlays,
    candlesSeriesKey,
    candles.length,
    chartSeries,
    loading,
    focusChartOnTrade,
    chartRev,
  ]);

  /** Portal fullscreen moves the chart DOM node — tear down so the candle effect recreates on the new host. */
  useEffect(() => {
    focusedTradeRef.current = null;
    return () => {
      chartApi.current?.remove();
      chartApi.current = null;
      candleSeries.current = null;
      linkSeries.current = null;
      overviewEntrySeries.current = null;
      overviewExitSeries.current = null;
      trailActivationSeries.current = null;
      trailNextGateSeries.current = null;
      trailSlPathSeries.current = null;
      srDayHighSeries.current = null;
      srDayLowSeries.current = null;
      srWeekHighSeries.current = null;
      srWeekLowSeries.current = null;
      zoneRiskTopSeries.current = null;
      zoneRiskBottomSeries.current = null;
      zoneRewardTopSeries.current = null;
      zoneRewardBottomSeries.current = null;
      zoneTokyoTopSeries.current = null;
      zoneTokyoBottomSeries.current = null;
      taZoneSeriesPool.current = [];
      priceLinesRef.current = [];
      trailTierLinesRef.current = [];
      taPriceLinesRef.current = [];
      patternPriceLinesRef.current = [];
    };
  }, [fullscreen]);

  /** Markers + selected-trade overlays — single pass per update. */
  useLayoutEffect(() => {
    applyTradeOverlays();
  }, [applyTradeOverlays, candlesSeriesKey]);

  useEffect(() => {
    return () => {
      chartApi.current?.remove();
      chartApi.current = null;
      srDayHighSeries.current = null;
      srDayLowSeries.current = null;
      srWeekHighSeries.current = null;
      srWeekLowSeries.current = null;
    };
  }, []);

  const tfOptions = SUPPORTED_TFS.filter((tf) =>
    ["1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"].includes(tf),
  );

  const tfMismatch = run && chartTf !== run.timeframe;

  const selectedExitBar = (() => {
    if (!selectedTrade || !candles.length || !run?.timeframe) return null;
    const idx = barIndexForTradeFill(candles, selectedTrade, chartTf, run.timeframe, run.engineType, "exit");
    return idx >= 0 && idx < candles.length ? candles[idx] ?? null : null;
  })();
  const exitOffBar =
    selectedTrade &&
    selectedExitBar &&
    selectedTrade.exitPrice != null &&
    !exitInsideBar(selectedTrade.direction, selectedTrade.exitPrice, selectedExitBar);

  const showSmcSetup = detailMode && strategyMarkupKind === "smc_ict" && tradeForOverlays != null;
  const showLiqSetup = detailMode && strategyMarkupKind === "liquidity" && tradeForOverlays != null;

  if (!run) return null;

  const chartBody = (
    <>

      {tfMismatch && (
        <p className="border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          Chart is on <strong>{chartTf}</strong> but this run used <strong>{run.timeframe}</strong>. Entry/exit
          markers use <strong>fill time</strong> mapped to {chartTf} bars (not the parent bar open).
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
          No stored candles for {chartSymbol} / {chartTf}. Sync data first.
        </p>
      )}

      {!detailMode && candles.length > 0 && !loading && trades.length > 0 && (
        <p className="border-b border-slate-100 px-3 py-1.5 text-[10px] text-slate-600 dark:border-slate-800 dark:text-slate-400">
          Overview: {trades.length} trades — green = entry · gray = exit. Pick a <strong>Trade #</strong> for
          markers, strategy diagram, and zoom.
        </p>
      )}

      {detailMode && selectedTrade && selectedExitBar && run && (
        <div className="border-b border-slate-100 px-3 py-2 text-[11px] dark:border-slate-800">
          <span className="font-semibold text-slate-700 dark:text-slate-200">
            Trade #{selectedTrade.tradeNumber}
          </span>
          <span className="ml-2 text-slate-500">
            entry {formatTsIST(resolveTradeEntryFillMs(selectedTrade, run.timeframe, run.engineType))}
            {" · "}
            exit {formatTsIST(resolveTradeExitFillMs(selectedTrade, run.timeframe))}
            {" · "}
            held {selectedTrade.barsHeld}×{run.timeframe}
          </span>
          {(selectedTrade.entryBarTs ?? selectedTrade.entryTs) &&
          selectedTrade.entryFillTs &&
          new Date(selectedTrade.entryFillTs).getTime() !==
            new Date(selectedTrade.entryBarTs ?? selectedTrade.entryTs).getTime() ? (
            <span className="ml-2 text-slate-400">
              bar open {formatTsIST(selectedTrade.entryBarTs ?? selectedTrade.entryTs)}
            </span>
          ) : null}
          <span className="ml-2 text-slate-500">
            exit bar O/H/L/C: {selectedExitBar.open.toFixed(2)} / {selectedExitBar.high.toFixed(2)} /{" "}
            {selectedExitBar.low.toFixed(2)} / {selectedExitBar.close.toFixed(2)}
          </span>
          {selectedTrade.entryMarkPx != null && Number.isFinite(selectedTrade.entryMarkPx) && (
            <span className="ml-2 font-mono text-slate-600 dark:text-slate-300">
              entry close {selectedTrade.entryMarkPx.toFixed(2)}
            </span>
          )}
          {selectedTrade.exitPrice != null && (
            <span className="ml-2 font-mono text-slate-600 dark:text-slate-300">
              fill incl. slip {selectedTrade.exitPrice.toFixed(2)}
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

      {detailMode && showSmcSetup && tradeForOverlays && showTaDrawing && (
        <SmcTradeSetupPanel trade={tradeForOverlays} markup={smcLegendMarkup} />
      )}

      {detailMode &&
        tradeForOverlays &&
        showTaDrawing &&
        strategyMarkupKind === "smc_ict" &&
        !smcLegendMarkup?.hlines.length &&
        !taOverlay?.lines.length &&
        candles.length > 0 &&
        !loading && (
          <p className="border-b border-slate-100 px-3 py-1.5 text-[10px] text-amber-700 dark:border-slate-800 dark:text-amber-300">
            Strategy markup: no stored SMC levels for this trade — re-run the backtest with SMC/ICT gate enabled
            so sweep / CHoCH / BOS / FVG / OB levels are persisted. Entry / SL / TP still show when enabled.
          </p>
        )}

      <div
        className={
          fullscreen
            ? "relative flex min-h-0 w-full flex-1 flex-col"
            : "relative w-full"
        }
        style={{ display: candles.length && !loading ? undefined : "none" }}
      >
        <div
          ref={chartRef}
          className={fullscreen ? "min-h-0 w-full flex-1" : "h-[min(420px,50vh)] w-full"}
        />
        {detailMode && showTrailTierChart && (
          <TrailTierLeftLabels
            chart={chartApi.current}
            series={candleSeries.current}
            tiers={trailTierLineSpecs}
            visible={isOverlayLayerOn(overlayLayers, "trail_tiers")}
            chartRev={chartRev}
          />
        )}
      </div>

      {detailMode && overlayToggleList.length > 0 && candles.length > 0 && !loading && (
        <ChartOverlayLegend
          items={overlayToggleList}
          layers={overlayLayers}
          onToggle={toggleOverlayLayer}
        />
      )}

      {detailMode && showLiqSetup && tradeForOverlays && showTaDrawing && candles.length > 0 && !loading && (
        <LiquidityTradeSetupPanel trade={tradeForOverlays} markup={smcLegendMarkup} />
      )}

      {!showSessionSrOverlays && candles.length > 0 && !loading && (
        <p className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-amber-700 dark:border-slate-800 dark:text-amber-300">
          Session S/R (prev day/week) only show for SR_INTRADAY / INTRADAY_PRO / liquidity-gate runs. This run:{" "}
          <strong>{runStrategyLabel}</strong>. Pick a trade # for entry / SL / TP / exit lines.
        </p>
      )}

      {!detailMode && candles.length > 0 && !loading && (
        <p className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400 dark:border-slate-800">
          — = all trade dots · pick Trade # for full markup
        </p>
      )}

      {detailMode && (
        <p className="border-t border-slate-100 px-3 py-1.5 text-[10px] text-slate-400 dark:border-slate-800">
          ↑↓ = entry · ○ = exit · ● = trail armed · ◆ = next tier gate · dotted = SL path · SH/SL = swings · Sweep/Reclaim/BOS = SMC · Orange = entry→exit link
        </p>
      )}
    </>
  );

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 dark:border-slate-800">
      <div>
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Trade chart</h3>
        <p className="text-[11px] text-slate-500">
          {chartSymbol}
          {run.isPortfolio ? " (portfolio — pick a trade for its coin)" : ""} · — = all entries/exits · Trade # = zoom
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            className="rounded border-slate-300"
            checked={showTaDrawing}
            onChange={(e) => setShowTaDrawing(e.target.checked)}
          />
          {strategyMarkupKind === "smc_ict" || strategyMarkupKind === "liquidity"
            ? "Strategy markup"
            : "TA drawing"}
        </label>
        <label className="flex cursor-pointer items-center gap-1 text-[11px] text-slate-600 dark:text-slate-400">
          <input
            type="checkbox"
            className="rounded border-slate-300"
            checked={showPositionPattern}
            onChange={(e) => setShowPositionPattern(e.target.checked)}
          />
          Position pattern
        </label>
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
            value={selectedTradeNumber != null ? String(selectedTradeNumber) : ""}
            onChange={(e) => {
              const raw = e.target.value;
              if (!raw) {
                setSelectedTrade(null);
                return;
              }
              const n = Number(raw);
              setSelectedTrade(trades.find((t) => t.tradeNumber === n) ?? null);
            }}
          >
            <option value="">—</option>
            {trades.map((t) => (
              <option key={t.tradeNumber} value={String(t.tradeNumber)}>
                {t.tradeNumber}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="rounded border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-900"
          title={fullscreen ? "Exit fullscreen" : "Expand chart"}
          onClick={() => setFullscreen((v) => !v)}
        >
          {fullscreen ? "⊗" : "⛶"}
        </button>
      </div>
    </div>
  );

  const shellClass = fullscreen
    ? "fixed inset-0 z-[200] flex flex-col bg-white shadow-2xl dark:bg-slate-950"
    : "rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950/60";

  const shell = (
    <div className={shellClass}>
      {header}
      <div className={fullscreen ? "flex min-h-0 flex-1 flex-col overflow-y-auto" : undefined}>{chartBody}</div>
    </div>
  );

  if (fullscreen) return createPortal(shell, document.body);
  return shell;
}