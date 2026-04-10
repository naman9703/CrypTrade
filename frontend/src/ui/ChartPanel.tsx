import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  type IChartApi,
  type UTCTimestamp,
  type Time,
  TickMarkType,
} from "lightweight-charts";
import { api } from "../api/client";
import { buildOhlc, isOhlcBarRenderable, ohlcBarsToMsCandles, type OhlcBar } from "../lib/chartOhlc";
import { isPlausibleCandleClose } from "../lib/symbolPriceSanity";
import { playSupertrendBuySound, playSupertrendSellSound } from "../lib/uiSounds";
import { buildChartSupertrend } from "../lib/supertrend";
import { useThemeStore } from "../themeStore";
import { CHART_CANDLE_MAX, useAppStore } from "../ws/store";
import { OrderBookPanel } from "./OrderBookPanel";

/** Display axis + crosshair in IST (UTC+5:30); bar timestamps stay UTC unix seconds from the feed. */
const CHART_TIMEZONE = "Asia/Kolkata";

/** Max markers on candlesticks (merged live + history); excess causes overlap and slows lightweight-charts. */
const CHART_MARKER_DISPLAY_CAP = 40;

/** Max rows in the “signals” list under the chart (newest first). */
const SUPERTREND_SIGNAL_LIST_MAX = 50;

/** Background REST sync for candles (does not remount chart; restores visible range). */
const CHART_BACKGROUND_SYNC_MS = 60_000;

function normalizeSymTf(s: string | undefined) {
  return String(s ?? "").trim();
}

function timeToUtcMs(time: Time): number {
  if (typeof time === "number") return Math.floor(time) * 1000;
  if (typeof time === "string") {
    const parts = time.split("-").map((x) => Number(x));
    if (parts.length >= 3 && parts.every((n) => Number.isFinite(n))) {
      return Date.UTC(parts[0], parts[1] - 1, parts[2]);
    }
    return 0;
  }
  return Date.UTC(time.year, time.month - 1, time.day);
}

function formatIstTimeScale(time: Time, tickMarkType: TickMarkType): string {
  const d = new Date(timeToUtcMs(time));
  const tz: Intl.DateTimeFormatOptions = { timeZone: CHART_TIMEZONE };
  switch (tickMarkType) {
    case TickMarkType.Year:
      return d.toLocaleString("en-IN", { ...tz, year: "numeric" });
    case TickMarkType.Month:
      return d.toLocaleString("en-IN", { ...tz, month: "short", year: "numeric" });
    case TickMarkType.DayOfMonth:
      return d.toLocaleString("en-IN", { ...tz, day: "numeric", month: "short" });
    case TickMarkType.Time:
      return d.toLocaleString("en-IN", { ...tz, hour: "2-digit", minute: "2-digit", hour12: false });
    case TickMarkType.TimeWithSeconds:
      return d.toLocaleString("en-IN", {
        ...tz,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
    default:
      return d.toLocaleString("en-IN", { ...tz, hour: "2-digit", minute: "2-digit", hour12: false });
  }
}

function formatIstCrosshairTime(time: Time): string {
  const d = new Date(timeToUtcMs(time));
  return d.toLocaleString("en-IN", {
    timeZone: CHART_TIMEZONE,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

type SupertrendSignalHistRow = {
  ts: number;
  side: "BUY" | "SELL";
  aiGate: number | null;
  strength: number | null;
  stAction: string | null;
};

/** On-chart marker (compact; full text also in list under chart). */
function formatSupertrendSignalMarkerText(
  m: { side: "buy" | "sell"; preview?: boolean },
  h: SupertrendSignalHistRow | undefined,
): string {
  if (m.preview === true) return "ST preview";
  const sideOk =
    h &&
    ((h.side === "BUY" && m.side === "buy") || (h.side === "SELL" && m.side === "sell"));
  if (sideOk && h) {
    const ai = h.aiGate != null && Number.isFinite(Number(h.aiGate)) ? Number(h.aiGate).toFixed(2) : "—";
    const ss = h.strength != null && Number.isFinite(Number(h.strength)) ? String(Math.round(Number(h.strength))) : "—";
    let act = "·";
    if (h.stAction === "TRADE") act = "T";
    else if (h.stAction === "WAIT") act = "W";
    else if (h.stAction === "SKIP") act = "K";
    const tag = m.side === "buy" ? "BUY" : "SELL";
    return `${m.side === "buy" ? "▲" : "▼"}${tag} AI${ai} SS${ss} ${act}`;
  }
  return m.side === "buy" ? "ST buy" : "ST sell";
}

function formatHistTimeIst(ts: number): string {
  const t = Number(ts);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("en-IN", {
    timeZone: CHART_TIMEZONE,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function tryApplyAutoFit(
  chart: IChartApi | null,
  ohlcLen: number,
  pendingAutoFit: { current: boolean },
  fitAfterRest: { current: boolean },
  skipUntilBulk: { current: boolean },
) {
  const canFit = !skipUntilBulk.current || fitAfterRest.current || ohlcLen >= 20;
  const shouldFit = pendingAutoFit.current && canFit && ohlcLen > 0;
  if (!shouldFit || !chart) return;
  try {
    chart.timeScale().fitContent();
  } catch {
    /* ignore */
  }
  pendingAutoFit.current = false;
  fitAfterRest.current = false;
  skipUntilBulk.current = false;
}

export function ChartPanel() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<any>(null);
  const supertrendLineRef = useRef<any>(null);
  const chartOkRef = useRef(false);
  const pendingAutoFitRef = useRef(true);
  const fitAfterRestSnapshotRef = useRef(false);
  const skipFitUntilBulkRef = useRef(false);
  const prevChartSymbolRef = useRef<string | undefined>(undefined);
  const prevChartTfRef = useRef<string | undefined>(undefined);
  const bulkFitFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const candles = useAppStore((s) => s.candles);
  const market = useAppStore((s) => s.market);
  const bot = useAppStore((s) => s.bot);
  const chartTheme = useThemeStore((s) => s.theme);

  const ohlc = useMemo(
    () => buildOhlc(candles, { symbol: bot?.symbol != null ? String(bot.symbol) : undefined }),
    [candles, bot?.symbol],
  );
  /** Same bars as candlesticks (in ms) so Supertrend math cannot diverge from what you see. */
  const ohlcAsMsCandles = useMemo(() => ohlcBarsToMsCandles(ohlc), [ohlc]);
  const candleTimes = useMemo(() => new Set(ohlc.map((b) => Number(b.time))), [ohlc]);
  const chartSupertrend = useMemo(() => {
    const period = Math.max(2, Math.floor(Number(bot?.supertrendPeriod ?? 10)));
    const multiplier = Number(bot?.supertrendMultiplier ?? 3);
    const wilderAtr = bot?.supertrendWilderAtr !== false;
    return buildChartSupertrend(ohlcAsMsCandles, {
      period,
      multiplier,
      wilderAtr,
      timeframe: bot?.timeframe != null ? String(bot.timeframe) : "1m",
      symbol: bot?.symbol != null ? String(bot.symbol) : undefined,
    });
  }, [ohlcAsMsCandles, bot?.symbol, bot?.supertrendPeriod, bot?.supertrendMultiplier, bot?.supertrendWilderAtr, bot?.timeframe]);

  /** Latest k.x may be a no-flip bar; keep showing the last chart-aligned flip that autotrade could use (matches Activity). */
  const supertrendHud = useMemo(() => {
    type Snap = {
      buySignal?: boolean;
      sellSignal?: boolean;
      aiGateBuy?: number | null;
      aiGateSell?: number | null;
      decisionLong?: number | null;
      decisionShort?: number | null;
      decisionMaxLong?: number | null;
      decisionMaxShort?: number | null;
      signalStrengthDecision?: { strength?: number; action?: string } | null;
    };
    const last = bot?.supertrendLastBarClose as Snap | null | undefined;
    const flip = bot?.supertrendLastFlipBarClose as Snap | null | undefined;
    if (last?.buySignal || last?.sellSignal) return { snap: last, kind: "latest_kx" as const };
    if (flip?.buySignal || flip?.sellSignal) return { snap: flip, kind: "last_flip" as const };
    return null;
  }, [bot?.supertrendLastBarClose, bot?.supertrendLastFlipBarClose]);

  /** Chart-derived markers + server last bar-close (matches Activity when client OHLC lags k.x). */
  const safeMarkers = useMemo(() => {
    const ct = candleTimes;
    const seen = new Set<string>();
    const out: Array<{ time: number; side: "buy" | "sell"; preview?: boolean }> = [];
    for (const m of chartSupertrend.markers) {
      const t = Math.floor(Number(m.time));
      if (!Number.isFinite(t) || !ct.has(t)) continue;
      const k = `${t}:${m.side}:${m.preview === true ? "p" : "c"}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ time: t, side: m.side, preview: m.preview === true });
    }
    const mergeServerFlip = (
      srv: { ts?: number; buySignal?: boolean; sellSignal?: boolean } | null | undefined,
    ) => {
      if (!srv || !(srv.buySignal || srv.sellSignal)) return;
      const tWant = Math.floor(Number(srv.ts) / 1000);
      const side = srv.buySignal ? ("buy" as const) : ("sell" as const);
      const kWant = `${tWant}:${side}:c`;
      if (Number.isFinite(tWant) && !seen.has(kWant)) {
        if (ct.has(tWant)) {
          out.push({ time: tWant, side, preview: false });
          seen.add(kWant);
        } else if (ohlc.length) {
          const lastT = Math.floor(Number(ohlc[ohlc.length - 1].time));
          if (Number.isFinite(lastT) && Math.abs(tWant - lastT) <= 1) {
            out.push({ time: lastT, side, preview: false });
            seen.add(`${lastT}:${side}:c`);
          }
        }
      }
    };
    mergeServerFlip(
      bot?.supertrendLastBarClose as { ts?: number; buySignal?: boolean; sellSignal?: boolean } | null | undefined,
    );
    /** Persisted flip — latest close may be a no-flip bar after Activity placed an order. */
    mergeServerFlip(
      bot?.supertrendLastFlipBarClose as { ts?: number; buySignal?: boolean; sellSignal?: boolean } | null | undefined,
    );
    return out.sort((a, b) => a.time - b.time);
  }, [chartSupertrend.markers, candleTimes, bot?.supertrendLastBarClose, bot?.supertrendLastFlipBarClose, ohlc]);

  /** Persisted flips for current symbol/timeframe (server); markers + list under chart. T/W/K = TRADE/WAIT/SKIP. */
  const supertrendSignalHistoryRecent = useMemo(
    () => (Array.isArray(bot?.supertrendSignalHistory) ? (bot.supertrendSignalHistory as SupertrendSignalHistRow[]) : []),
    [bot?.supertrendSignalHistory],
  );

  const supertrendSignalHistoryNewestFirst = useMemo(
    () => [...supertrendSignalHistoryRecent].reverse(),
    [supertrendSignalHistoryRecent],
  );

  const supertrendSignalHistoryListRows = useMemo(
    () => supertrendSignalHistoryNewestFirst.slice(0, SUPERTREND_SIGNAL_LIST_MAX),
    [supertrendSignalHistoryNewestFirst],
  );

  const candlestickSeriesMarkers = useMemo(() => {
    const hist = supertrendSignalHistoryRecent;
    const histByKey = new Map<string, SupertrendSignalHistRow>();
    for (const h of hist) {
      const sec = Math.floor(Number(h.ts) / 1000);
      if (!Number.isFinite(sec)) continue;
      const sk = h.side === "BUY" ? "buy" : "sell";
      histByKey.set(`${sec}:${sk}`, h);
    }

    const seen = new Set(safeMarkers.map((m) => `${m.time}:${m.side}`));
    const extra: typeof safeMarkers = [];
    for (const h of hist) {
      const sec = Math.floor(Number(h.ts) / 1000);
      if (!Number.isFinite(sec) || !candleTimes.has(sec)) continue;
      const side = h.side === "BUY" ? ("buy" as const) : ("sell" as const);
      const k = `${sec}:${side}`;
      if (seen.has(k)) continue;
      seen.add(k);
      extra.push({ time: sec, side, preview: false });
    }
    const merged = [...safeMarkers, ...extra].sort((a, b) => a.time - b.time);
    const capped =
      merged.length > CHART_MARKER_DISPLAY_CAP ? merged.slice(-CHART_MARKER_DISPLAY_CAP) : merged;

    return capped.map((m) => {
      const hMatch = histByKey.get(`${m.time}:${m.side}`);
      const text = formatSupertrendSignalMarkerText(m, hMatch);
      return {
        time: Math.floor(Number(m.time)) as UTCTimestamp,
        position: m.side === "buy" ? ("belowBar" as const) : ("aboveBar" as const),
        color: m.preview === true ? "#eab308" : m.side === "buy" ? "#34d399" : "#fb7185",
        shape:
          m.preview === true
            ? ("circle" as const)
            : m.side === "buy"
              ? ("arrowUp" as const)
              : ("arrowDown" as const),
        text,
      };
    });
  }, [safeMarkers, supertrendSignalHistoryRecent, candleTimes]);

  const supertrendSoundCtx = useMemo(
    () =>
      `${normalizeSymTf(bot?.symbol)}|${normalizeSymTf(bot?.timeframe)}|${Number(bot?.supertrendPeriod ?? 10)}|${Number(bot?.supertrendMultiplier ?? 3)}|${bot?.supertrendWilderAtr !== false}`,
    [bot?.symbol, bot?.timeframe, bot?.supertrendPeriod, bot?.supertrendMultiplier, bot?.supertrendWilderAtr],
  );
  const stSigSoundBootRef = useRef(true);
  const stSigSoundPrevKeyRef = useRef<string | null>(null);
  const stSigSoundCtxSeenRef = useRef(supertrendSoundCtx);
  useEffect(() => {
    if (stSigSoundCtxSeenRef.current !== supertrendSoundCtx) {
      stSigSoundCtxSeenRef.current = supertrendSoundCtx;
      stSigSoundBootRef.current = true;
      stSigSoundPrevKeyRef.current = null;
    }
    const last = safeMarkers.at(-1);
    if (!last) return;
    if (last.preview === true) return;
    const key = `${last.time}:${last.side}`;
    if (stSigSoundBootRef.current) {
      stSigSoundBootRef.current = false;
      stSigSoundPrevKeyRef.current = key;
      return;
    }
    if (stSigSoundPrevKeyRef.current === key) return;
    stSigSoundPrevKeyRef.current = key;
    if (last.side === "buy") playSupertrendBuySound();
    else playSupertrendSellSound();
  }, [safeMarkers, supertrendSoundCtx]);

  const alignedStLine = useMemo((): { time: UTCTimestamp; value: number }[] => {
    return chartSupertrend.linePoints.map((p) => ({
      time: p.time as UTCTimestamp,
      value: p.value,
    }));
  }, [chartSupertrend.linePoints]);

  /** `bot` is the selected pair; `market` can lag one tick after symbol/timeframe changes — avoid mixing them in the header. */
  const chartHud = useMemo(() => {
    const bSym = normalizeSymTf(bot?.symbol);
    const mSym = normalizeSymTf(market?.symbol);
    const coherent = Boolean(bSym && mSym && bSym === mSym);
    const symbol = bSym || mSym || "—";
    const tf = normalizeSymTf(bot?.timeframe) || normalizeSymTf(market?.timeframe) || "—";
    const lastBar = ohlc.length ? ohlc[ohlc.length - 1] : null;
    /** Match what the candlestick series draws; `market.candle` can briefly disagree after WS/REST races. */
    let price: number | null = null;
    if (lastBar && Number.isFinite(lastBar.close)) {
      price = lastBar.close;
    } else if (
      coherent &&
      market?.candle?.close != null &&
      Number.isFinite(Number(market.candle.close)) &&
      isPlausibleCandleClose(
        symbol,
        Number(market.candle.close),
        Number(market.candle.low),
        ohlc.length >= 2 ? Number(ohlc[ohlc.length - 2].close) : null,
      )
    ) {
      price = Number(market.candle.close);
    }
    const regimeType = coherent ? (market?.regime?.type ?? "—") : "—";
    const stTrendLocal = chartSupertrend.lastTrend;
    const stTrend =
      stTrendLocal != null
        ? stTrendLocal
        : coherent && market?.supertrend != null && Number.isFinite(Number(market.supertrend.trend))
          ? Number(market.supertrend.trend)
          : null;
    return { symbol, tf, price, regimeType, stTrend };
  }, [bot?.symbol, bot?.timeframe, market, ohlc, chartSupertrend.lastTrend]);

  const ohlcRef = useRef(ohlc);
  ohlcRef.current = ohlc;
  /** Last OHLC set applied to lightweight-charts (for incremental update vs full setData). */
  const chartOhlcAppliedRef = useRef<OhlcBar[] | null>(null);
  /** After `applyMarketCandlesResult(..., { preserveView: true })`, restore time-scale range after next series update. */
  const syncPreserveViewRef = useRef(false);
  const stLineFlushRafRef = useRef(0);
  /** Bump to destroy + recreate the chart canvas (same effect as a full page load / server restart for rendering). */
  const [chartInstanceKey, setChartInstanceKey] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#cbd5e1",
      },
      grid: {
        vertLines: { color: "rgba(148,163,184,0.12)" },
        horzLines: { color: "rgba(148,163,184,0.12)" },
      },
      localization: {
        locale: "en-IN",
        dateFormat: "dd MMM ''yy",
        timeFormatter: (t: Time) => formatIstCrosshairTime(t),
      },
      timeScale: {
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (t: Time, tickMarkType: TickMarkType) => formatIstTimeScale(t, tickMarkType),
      },
      /** Single scale for candles + Supertrend — same magnitude as OHLC; avoids dual-axis glitches when line v.s. scale desync. */
      rightPriceScale: { borderColor: "rgba(148,163,184,0.15)" },
      leftPriceScale: { visible: false },
      crosshair: { mode: 0 },
      handleScroll: true,
      handleScale: true,
    });

    const series = chart.addCandlestickSeries({
      priceScaleId: "right",
      upColor: "#34d399",
      downColor: "#fb7185",
      borderDownColor: "#fb7185",
      borderUpColor: "#34d399",
      wickDownColor: "#fb7185",
      wickUpColor: "#34d399",
    });

    const stLine = chart.addLineSeries({
      priceScaleId: "right",
      color: "#4ade80",
      lineWidth: 2,
      title: "Supertrend",
      lastValueVisible: false,
      priceLineVisible: false,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    supertrendLineRef.current = stLine;
    chartOkRef.current = true;

    const cur = ohlcRef.current;
    if (cur.length) {
      try {
        const sym0 = normalizeSymTf(useAppStore.getState().bot?.symbol);
        const filtered = cur.filter((bar, i) => isOhlcBarRenderable(bar, i > 0 ? cur[i - 1]! : null, sym0));
        if (filtered.length) {
          series.setData(filtered);
          chartOhlcAppliedRef.current = filtered.slice();
          tryApplyAutoFit(chart, filtered.length, pendingAutoFitRef, fitAfterRestSnapshotRef, skipFitUntilBulkRef);
        }
      } catch {
        /* ignore */
      }
    }

    return () => {
      chartOhlcAppliedRef.current = null;
      chartOkRef.current = false;
      if (bulkFitFallbackTimerRef.current) {
        clearTimeout(bulkFitFallbackTimerRef.current);
        bulkFitFallbackTimerRef.current = null;
      }
      try {
        chart.remove();
      } catch {
        /* ignore */
      }
      chartRef.current = null;
      seriesRef.current = null;
      supertrendLineRef.current = null;
    };
  }, [chartInstanceKey]);

  useEffect(() => {
    const chart = chartRef.current;
    const st = supertrendLineRef.current;
    if (!chart) return;
    const isDark = chartTheme === "dark";
    try {
      chart.applyOptions({
        layout: {
          background: { color: "transparent" },
          textColor: isDark ? "#cbd5e1" : "#475569",
        },
        grid: {
          vertLines: { color: isDark ? "rgba(148,163,184,0.12)" : "rgba(71,85,105,0.16)" },
          horzLines: { color: isDark ? "rgba(148,163,184,0.12)" : "rgba(71,85,105,0.16)" },
        },
        rightPriceScale: { borderColor: isDark ? "rgba(148,163,184,0.15)" : "rgba(71,85,105,0.22)" },
      });
      st?.applyOptions?.({ color: isDark ? "#4ade80" : "#15803d" });
    } catch {
      /* ignore */
    }
  }, [chartTheme, chartInstanceKey]);

  useEffect(() => {
    if (!ohlc.length) {
      chartOhlcAppliedRef.current = null;
      syncPreserveViewRef.current = false;
      return;
    }
    if (!chartOkRef.current || !seriesRef.current || !chartRef.current) {
      syncPreserveViewRef.current = false;
      return;
    }
    const series = seriesRef.current;
    const chart = chartRef.current;

    let logicalRangeRestore: { from: number; to: number } | null = null;
    if (syncPreserveViewRef.current) {
      syncPreserveViewRef.current = false;
      try {
        const lr = chart.timeScale().getVisibleLogicalRange();
        if (lr && Number.isFinite(lr.from) && Number.isFinite(lr.to)) {
          logicalRangeRestore = { from: lr.from, to: lr.to };
        }
      } catch {
        /* ignore */
      }
    }

    const prev = chartOhlcAppliedRef.current;
    const last = ohlc[ohlc.length - 1]!;
    const first = ohlc[0]!;
    const sym = normalizeSymTf(bot?.symbol);

    let full =
      !prev ||
      prev.length === 0 ||
      ohlc.length < prev.length ||
      first.time !== prev[0].time ||
      ohlc.length > prev.length + 1;

    const pLast = prev?.length ? prev[prev.length - 1]! : null;
    if (!full && pLast != null && ohlc.length === prev!.length + 1 && Number(last.time) <= Number(pLast.time)) {
      full = true;
    }
    if (!full && pLast != null && !isOhlcBarRenderable(last, pLast, sym)) {
      full = true;
    }

    try {
      if (full) {
        const sanitized = ohlc.filter((bar, i) => isOhlcBarRenderable(bar, i > 0 ? ohlc[i - 1]! : null, sym));
        if (!sanitized.length) return;
        series.setData(sanitized);
        chartOhlcAppliedRef.current = sanitized.slice();
      } else {
        const sanitizedNow = ohlc.filter((bar, i) =>
          isOhlcBarRenderable(bar, i > 0 ? ohlc[i - 1]! : null, sym),
        );
        const pLastInner = prev![prev!.length - 1]!;
        if (last.time === pLastInner.time || Number(last.time) > Number(pLastInner.time)) {
          if (!isOhlcBarRenderable(last, pLastInner, sym)) {
            if (sanitizedNow.length) {
              series.setData(sanitizedNow);
              chartOhlcAppliedRef.current = sanitizedNow.slice();
            }
          } else {
            const pLen = prev!.length;
            const sLen = sanitizedNow.length;
            /** Chart + ref must both track filtered bars only; raw `ohlc.length` can exceed series length. */
            if (sLen !== pLen && sLen !== pLen + 1) {
              if (sanitizedNow.length) {
                series.setData(sanitizedNow);
                chartOhlcAppliedRef.current = sanitizedNow.slice();
              }
            } else {
              series.update(last);
              chartOhlcAppliedRef.current = sanitizedNow.slice();
            }
          }
        } else {
          const sanitized = ohlc.filter((bar, i) => isOhlcBarRenderable(bar, i > 0 ? ohlc[i - 1]! : null, sym));
          if (sanitized.length) {
            series.setData(sanitized);
            chartOhlcAppliedRef.current = sanitized.slice();
          }
        }
      }
      tryApplyAutoFit(
        chart,
        chartOhlcAppliedRef.current?.length ?? ohlc.length,
        pendingAutoFitRef,
        fitAfterRestSnapshotRef,
        skipFitUntilBulkRef,
      );
      if (logicalRangeRestore) {
        const r = logicalRangeRestore;
        requestAnimationFrame(() => {
          try {
            chartRef.current?.timeScale().setVisibleLogicalRange({
              from: r.from,
              to: r.to,
            });
          } catch {
            /* ignore */
          }
        });
      }
    } catch {
      try {
        const sanitized = ohlc.filter((bar, i) => isOhlcBarRenderable(bar, i > 0 ? ohlc[i - 1]! : null, sym));
        if (sanitized.length) {
          series.setData(sanitized);
          chartOhlcAppliedRef.current = sanitized.slice();
        }
      } catch {
        /* ignore */
      }
    }
  }, [ohlc, bot?.symbol]);

  useEffect(() => {
    const sym = bot?.symbol as string | undefined;
    const tf = bot?.timeframe as string | undefined;
    if (!sym || !tf) return;
    const hadPrev = prevChartSymbolRef.current !== undefined;
    const changed =
      hadPrev && (prevChartSymbolRef.current !== sym || prevChartTfRef.current !== tf);
    prevChartSymbolRef.current = sym;
    prevChartTfRef.current = tf;
    if (!changed) return;

    chartOhlcAppliedRef.current = null;
    pendingAutoFitRef.current = true;
    skipFitUntilBulkRef.current = true;

    if (bulkFitFallbackTimerRef.current) clearTimeout(bulkFitFallbackTimerRef.current);
    bulkFitFallbackTimerRef.current = setTimeout(() => {
      bulkFitFallbackTimerRef.current = null;
      skipFitUntilBulkRef.current = false;
      pendingAutoFitRef.current = true;
      const chart = chartRef.current;
      const len = ohlcRef.current.length;
      if (chartOkRef.current && chart && len > 0) {
        try {
          chart.timeScale().fitContent();
          pendingAutoFitRef.current = false;
          fitAfterRestSnapshotRef.current = false;
        } catch {
          /* ignore */
        }
      }
    }, 2800);
  }, [bot?.symbol, bot?.timeframe]);

  const applyMarketCandlesResult = useCallback((r: any, sym: string, tf: string, opts?: { preserveView?: boolean }): boolean => {
    if (!r?.ok || !Array.isArray(r.candles) || !r.candles.length) return false;
    const live = useAppStore.getState();
    if (normalizeSymTf(live.bot?.symbol) !== sym || normalizeSymTf(live.bot?.timeframe) !== tf) return false;
    if (normalizeSymTf(r.symbol) !== sym || normalizeSymTf(r.timeframe) !== tf) return false;
    const preserveView = Boolean(opts?.preserveView);
    if (preserveView) {
      syncPreserveViewRef.current = true;
    } else {
      if (bulkFitFallbackTimerRef.current) {
        clearTimeout(bulkFitFallbackTimerRef.current);
        bulkFitFallbackTimerRef.current = null;
      }
      skipFitUntilBulkRef.current = false;
      fitAfterRestSnapshotRef.current = true;
      pendingAutoFitRef.current = true;
    }
    const cc0 = r.candles.slice(-CHART_CANDLE_MAX);
    useAppStore.setState((s) => {
      const cc = cc0;
      const last = cc[cc.length - 1];
      const stLine = Array.isArray(r.supertrendLine) ? r.supertrendLine : [];
      const stSigs = Array.isArray(r.supertrendSignals) ? r.supertrendSignals : [];
      const stMeta = r.supertrend ?? null;
      return {
        candles: cc,
        market: s.market
          ? {
              ...s.market,
              symbol: r.symbol ?? s.market.symbol,
              timeframe: r.timeframe ?? s.market.timeframe,
              supertrendLine: stLine,
              supertrendSignals: stSigs,
              supertrend: stMeta,
              candle: last ?? s.market.candle,
            }
          : {
              symbol: String(r.symbol ?? sym),
              timeframe: String(r.timeframe ?? tf),
              candle: last,
              indicators: {},
              regime: { type: "—", atrPct: 0, adx: 0 },
              supertrendLine: stLine,
              supertrendSignals: stSigs,
              supertrend: stMeta,
            },
      };
    });
    return true;
  }, []);

  const [chartRefreshBusy, setChartRefreshBusy] = useState(false);
  const handleRefreshChart = useCallback(async () => {
    const sym = normalizeSymTf(bot?.symbol);
    const tf = normalizeSymTf(bot?.timeframe);
    if (!sym || !tf) return;
    setChartRefreshBusy(true);
    try {
      const r = await api.marketCandles(24);
      const ok = applyMarketCandlesResult(r, sym, tf);
      const pushLog = useAppStore.getState().pushLog;
      if (ok) {
        chartOhlcAppliedRef.current = null;
        setChartInstanceKey((k) => k + 1);
        pushLog({
          level: "info",
          msg: "Chart fully reloaded from server (new canvas + OHLC snapshot, same path as after reconnect)",
        });
      } else pushLog({ level: "warn", msg: "Chart refresh: no data or pair changed — try again." });
    } catch {
      useAppStore.getState().pushLog({ level: "error", msg: "Chart refresh failed (network or server error)" });
    } finally {
      setChartRefreshBusy(false);
    }
  }, [bot?.symbol, bot?.timeframe, applyMarketCandlesResult]);

  /** REST snapshot after symbol/timeframe change so the chart fills ~24h once Binance backfill completes. */
  useEffect(() => {
    const sym = normalizeSymTf(bot?.symbol);
    const tf = normalizeSymTf(bot?.timeframe);
    if (!sym || !tf) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      api
        .marketCandles(24)
        .then((r) => {
          if (cancelled) return;
          applyMarketCandlesResult(r, sym, tf);
        })
        .catch(() => {});
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [bot?.symbol, bot?.timeframe, applyMarketCandlesResult]);

  useEffect(() => {
    const sym = normalizeSymTf(bot?.symbol);
    const tf = normalizeSymTf(bot?.timeframe);
    if (!sym || !tf) return;
    const id = window.setInterval(() => {
      const live = useAppStore.getState();
      const liveSym = normalizeSymTf(live.bot?.symbol);
      const liveTf = normalizeSymTf(live.bot?.timeframe);
      if (liveSym !== sym || liveTf !== tf) return;
      api
        .marketCandles(24)
        .then((r) => {
          applyMarketCandlesResult(r, sym, tf, { preserveView: true });
        })
        .catch(() => {});
    }, CHART_BACKGROUND_SYNC_MS);
    return () => clearInterval(id);
  }, [bot?.symbol, bot?.timeframe, applyMarketCandlesResult]);

  useEffect(() => {
    if (stLineFlushRafRef.current) cancelAnimationFrame(stLineFlushRafRef.current);
    stLineFlushRafRef.current = requestAnimationFrame(() => {
      stLineFlushRafRef.current = 0;
      if (!chartOkRef.current || !supertrendLineRef.current) return;
      try {
        if (!alignedStLine.length) {
          supertrendLineRef.current.setData([]);
          return;
        }
        const mono: typeof alignedStLine = [];
        for (const p of alignedStLine) {
          if (!Number.isFinite(p.value) || p.value <= 0) continue;
          if (!mono.length || p.time > mono[mono.length - 1].time) mono.push(p);
        }
        while (mono.length >= 2) {
          const a = mono[mono.length - 2]!.value;
          const b = mono[mono.length - 1]!.value;
          if (a > 0 && b > 0 && (b / a > 80 || a / b > 80)) mono.pop();
          else break;
        }
        supertrendLineRef.current.setData(mono);
      } catch {
        try {
          supertrendLineRef.current.setData([]);
        } catch {
          /* ignore */
        }
      }
    });
    return () => {
      if (stLineFlushRafRef.current) cancelAnimationFrame(stLineFlushRafRef.current);
    };
  }, [alignedStLine]);

  useEffect(() => {
    if (!chartOkRef.current || !seriesRef.current) return;
    try {
      seriesRef.current.setMarkers(candlestickSeriesMarkers);
    } catch {
      /* ignore */
    }
  }, [candlestickSeriesMarkers]);

  return (
    <div className="p-4">
      <div className="mb-3 border-b border-slate-200/90 dark:border-slate-800/80 pb-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-500">Crypto chart</h2>
            <p className="mt-0.5 max-w-xl text-[10px] leading-snug text-slate-600 dark:text-slate-500">
              Supertrend: <span className="text-slate-600 dark:text-slate-400">saved signals</span> for this symbol/timeframe (mixed BUY/SELL, by time):{" "}
              <span className="text-slate-600 dark:text-slate-400">AI</span> = AI confidence gate at close,{" "}
              <span className="text-slate-600 dark:text-slate-400">SS</span> = composite signal strength (0–100),{" "}
              <span className="text-slate-600 dark:text-slate-400">T/W/K</span> = TRADE / WAIT / SKIP (when “gates opens” is on, only{" "}
              <span className="text-slate-600 dark:text-slate-400">T</span> can open).
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleRefreshChart()}
            disabled={chartRefreshBusy || !normalizeSymTf(bot?.symbol) || !normalizeSymTf(bot?.timeframe)}
            className="shrink-0 rounded-lg border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-800 shadow-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-sky-500/50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
            title="Fetch latest ~24h OHLC and rebuild the chart canvas (fixes stuck rendering)"
            aria-label="Reload chart from server"
          >
            {chartRefreshBusy ? "Reloading…" : "Reload chart"}
          </button>
        </div>
      </div>

      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{chartHud.symbol}</div>
          <div className="text-xs text-slate-600 dark:text-slate-400">
            {chartHud.tf} · Regime: <span className="text-slate-800 dark:text-slate-200">{chartHud.regimeType}</span>
            {chartHud.stTrend != null ? (
              <span className="ml-2 text-emerald-400/90">
                · ST {chartHud.stTrend === 1 ? "long" : "short"}
              </span>
            ) : null}
            {supertrendHud ? (
              <span
                className={`ml-2 ${supertrendHud.snap.buySignal ? "text-emerald-300/95" : "text-rose-300/95"}`}
                title={
                  supertrendHud.kind === "latest_kx"
                    ? "Server: latest k.x close (matches Activity)"
                    : "Server: last chart-aligned flip — latest k.x had no new flip; Activity used this bar"
                }
              >
                · {supertrendHud.kind === "latest_kx" ? "last k.x" : "last autotrade flip"}:{" "}
                {supertrendHud.snap.buySignal ? "BUY" : "SELL"}
                {(() => {
                  const x = supertrendHud.snap;
                  if (x.buySignal) {
                    const p = x.aiGateBuy;
                    const ai = p != null && Number.isFinite(Number(p)) ? Number(p).toFixed(2) : "—";
                    const ss = x.signalStrengthDecision;
                    if (ss?.strength != null && Number.isFinite(Number(ss.strength))) {
                      return ` (AI ${ai} · strength ${Number(ss.strength).toFixed(0)}${ss.action ? ` ${ss.action}` : ""})`;
                    }
                    const t = x.decisionLong;
                    const m = x.decisionMaxLong ?? 100;
                    const r = t != null && Number.isFinite(Number(t)) ? `${Math.round(Number(t))}/${m}` : "—";
                    return ` (AI ${ai} · dec ${r})`;
                  }
                  const p = x.aiGateSell;
                  const ai = p != null && Number.isFinite(Number(p)) ? Number(p).toFixed(2) : "—";
                  const ss = x.signalStrengthDecision;
                  if (ss?.strength != null && Number.isFinite(Number(ss.strength))) {
                    return ` (AI ${ai} · strength ${Number(ss.strength).toFixed(0)}${ss.action ? ` ${ss.action}` : ""})`;
                  }
                  const t = x.decisionShort;
                  const m = x.decisionMaxShort ?? 100;
                  const r = t != null && Number.isFinite(Number(t)) ? `${Math.round(Number(t))}/${m}` : "—";
                  return ` (AI ${ai} · dec ${r})`;
                })()}
              </span>
            ) : null}
          </div>
        </div>
        <div className="shrink-0 text-xs text-slate-600 dark:text-slate-400">
          Price:{" "}
          <span className="text-slate-900 dark:text-slate-100">
            {chartHud.price != null && Number.isFinite(chartHud.price) ? chartHud.price.toFixed(2) : "—"}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div
          key={chartInstanceKey}
          ref={containerRef}
          className="w-full min-h-[320px] shrink-0"
          style={{ height: "min(520px, 60vh)" }}
        />
        {supertrendSignalHistoryListRows.length > 0 ? (
          <div className="w-full rounded-md border border-slate-200/90 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-950/50 px-2 py-2">
            <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-500">
              {supertrendSignalHistoryNewestFirst.length > SUPERTREND_SIGNAL_LIST_MAX
                ? `Last ${SUPERTREND_SIGNAL_LIST_MAX} of ${supertrendSignalHistoryNewestFirst.length} signals`
                : `${supertrendSignalHistoryListRows.length} signal${supertrendSignalHistoryListRows.length === 1 ? "" : "s"}`}{" "}
              (newest first · scores match markers, times {CHART_TIMEZONE})
            </div>
            <ul className="max-h-[min(360px,50vh)] space-y-1 overflow-y-auto text-[11px] leading-snug">
              {supertrendSignalHistoryListRows.map((h, i) => {
                const ai =
                  h.aiGate != null && Number.isFinite(Number(h.aiGate)) ? Number(h.aiGate).toFixed(2) : "—";
                const ss =
                  h.strength != null && Number.isFinite(Number(h.strength)) ? String(Math.round(Number(h.strength))) : "—";
                const act = h.stAction != null ? String(h.stAction) : "—";
                return (
                  <li
                    key={`${h.ts}-${h.side}-${i}`}
                    className={
                      h.side === "BUY"
                        ? "border-l-2 border-emerald-500/60 pl-2 text-emerald-100/95"
                        : "border-l-2 border-rose-500/60 pl-2 text-rose-100/95"
                    }
                  >
                    <span className="text-slate-600 dark:text-slate-500">{formatHistTimeIst(h.ts)}</span>{" "}
                    <span className="font-semibold">{h.side}</span>
                    <span className="text-slate-600 dark:text-slate-400"> · AI {ai}</span>
                    <span className="text-slate-600 dark:text-slate-400"> · SS {ss}</span>
                    <span className="text-slate-600 dark:text-slate-500"> · {act}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        <div className="w-full">
          <OrderBookPanel />
        </div>
      </div>
    </div>
  );
}
