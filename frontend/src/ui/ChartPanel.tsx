import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createChart,
  LineStyle,
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
import { advanceTrailingStopState, buildTrailLockPrices, mergeStopWithTrail } from "../lib/trailingFeeLadder";
import { computeSupertrendTrailingSlUpdate } from "../lib/supertrendTrailingSl";
import { clampTradeCloseFeeRate } from "../lib/tradeCloseFee";
import {
  computeSupertrendSignalVerdicts,
  formatSupertrendSignalVerdict,
} from "../lib/supertrendSignalVerdict";
import { useThemeStore } from "../themeStore";
import { CHART_CANDLE_MAX, useAppStore } from "../ws/store";
import { OrderBookPanel } from "./OrderBookPanel";
import { MultiCoinSignalTabs } from "./MultiCoinSignalTabs";
import { PositionMiniChartsRow } from "./PositionMiniChartsRow";

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

/** Align chart symbol vs exchange position `symbol` (slashes, dashes, case). */
function canonicalChartSymbol(s: string | undefined | null): string {
  return String(s ?? "")
    .trim()
    .toUpperCase()
    .replace(/[/\s_-]/g, "");
}

/**
 * LWC builds price-scale ticks from series `priceFormat`; defaults break for sub‑$1 pairs (e.g. DOGE ~0.09)
 * — the right axis can look “empty” or show only one tick (see lightweight-charts #1186 / #1452).
 */
function inferChartPriceFormat(lastClose: number | null): { type: "price"; precision: number; minMove: number } {
  const x = lastClose != null && Number.isFinite(lastClose) && lastClose > 0 ? lastClose : null;
  if (x == null) return { type: "price", precision: 6, minMove: 0.000001 };
  if (x >= 10_000) return { type: "price", precision: 1, minMove: 0.1 };
  if (x >= 1000) return { type: "price", precision: 2, minMove: 0.01 };
  if (x >= 1) return { type: "price", precision: 4, minMove: 0.0001 };
  if (x >= 0.01) return { type: "price", precision: 5, minMove: 0.00001 };
  return { type: "price", precision: 6, minMove: 0.000001 };
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
  symbol?: string;
  timeframe?: string;
  aiGate: number | null;
  strength: number | null;
  stAction: string | null;
  /** SurfPulse ML /predict/surfpulse win probability at bar close (0–1). */
  surfPulse?: number | null;
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
    const pair = h.symbol?.trim() ? `${h.symbol.trim()} ` : "";
    const ai = h.aiGate != null && Number.isFinite(Number(h.aiGate)) ? Number(h.aiGate).toFixed(2) : "—";
    const ss = h.strength != null && Number.isFinite(Number(h.strength)) ? String(Math.round(Number(h.strength))) : "—";
    const sp =
      h.surfPulse != null && Number.isFinite(Number(h.surfPulse)) ? Number(h.surfPulse).toFixed(2) : "—";
    let act = "·";
    if (h.stAction === "TRADE") act = "T";
    else if (h.stAction === "WAIT") act = "W";
    else if (h.stAction === "SKIP") act = "K";
    const tag = m.side === "buy" ? "BUY" : "SELL";
    return `${m.side === "buy" ? "▲" : "▼"}${pair}${tag} AI${ai} SS${ss} SP${sp} ${act}`;
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

type BracketPriceLineHandle = { remove: () => void };

/**
 * Drop SL/TP that cannot belong to the charted instrument (wrong row / stale merge), e.g. TP 9 on DOGE ~0.09.
 * Uses last candle close as reference when available.
 */
function futuresBracketLevelSane(chartSymForPlausible: string, px: number, lastClose: number | null): boolean {
  if (!Number.isFinite(px) || px <= 0) return false;
  if (lastClose != null && Number.isFinite(lastClose) && lastClose > 0) {
    const r = px / lastClose;
    if (!Number.isFinite(r) || r < 1 / 50 || r > 50) return false;
  }
  return isPlausibleCandleClose(chartSymForPlausible, px, px * 0.999, lastClose);
}

type ChartStTrailPreviewLine = { px: number; title: string; kind: "st_activation" | "st_trail" | "fee_trail" };

/** Live “mark past activation” vs server-persisted trail step (≥1 SL trail update). */
type ChartTrailingBadge = { trailing: boolean; trailed: boolean };

type ChartTrailingPreview = { key: string; lines: ChartStTrailPreviewLine[]; badge: ChartTrailingBadge | null };

/** Main chart SL/TP / trailing preview only when the bot is routed to futures (not pure spot). */
function inferFuturesBracketLinesActive(bot: unknown): boolean {
  const b = bot as Record<string, unknown> | undefined;
  if (!b) return true;
  const mm = String(b.marketMode ?? "AUTO").toUpperCase();
  if (mm === "FUTURES") return true;
  if (mm === "SPOT") return false;
  const fut = Boolean(b.supertrendFuturesAuto);
  const spot = Boolean(b.supertrendSpotAuto);
  if (fut && !spot) return true;
  if (!fut && spot) return false;
  return fut;
}

function positionOpenedAtMs(p: Record<string, unknown>): number {
  const m = (p.meta as Record<string, unknown> | undefined) || {};
  const t = p.openedAt ?? p.opened_at ?? m.openedAt ?? m.opened_at;
  if (t == null) return 0;
  const ms = new Date(String(t)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** Futures rows use positive `qty` with `side` — must match server / PortfolioPanel. */
function futuresPositionIsLong(pos: Record<string, unknown>): boolean {
  const s = String(pos?.side ?? "").toUpperCase();
  if (s === "BUY" || s === "LONG") return true;
  if (s === "SELL" || s === "SHORT") return false;
  const q = Number(pos?.qty ?? pos?.positionAmt);
  if (Number.isFinite(q) && q !== 0) return q > 0;
  return true;
}

/** Non-zero futures legs for the chart symbol (deduped by id / side+entry). */
function filterChartSymbolFuturesOpenRows(
  positions: unknown,
  chartSymbolEffective: string,
): Record<string, unknown>[] {
  const symKey = canonicalChartSymbol(chartSymbolEffective);
  if (!symKey) return [];
  const rows = Array.isArray(positions) ? positions : [];
  const hereRaw = rows.filter((p: Record<string, unknown>) => {
    const ps = canonicalChartSymbol(String(p?.symbol ?? ""));
    if (!ps || ps !== symKey) return false;
    const q = Number(p?.qty ?? p?.positionAmt);
    if (!Number.isFinite(q) || Math.abs(q) <= 1e-8) return false;
    const v = String(p?.venue ?? "").toUpperCase();
    return v === "FUTURES";
  });
  const seenRow = new Set<string>();
  return hereRaw.filter((p: Record<string, unknown>) => {
    const id = String(p?.id ?? "").trim();
    const k = id || `${String(p?.side ?? "")}|${String(p?.entryPrice ?? "")}`;
    if (seenRow.has(k)) return false;
    seenRow.add(k);
    return true;
  });
}

/** One row per chart: newest open first, then largest notional (hedge / duplicate API rows). */
function selectPrimaryFuturesPositionForChart(here: Record<string, unknown>[]): Record<string, unknown> | undefined {
  if (!here.length) return undefined;
  const scored = here.map((p) => {
    const q = Math.abs(Number(p.qty ?? p.positionAmt) || 0);
    const e = Number(p.entryPrice);
    const notional = Number.isFinite(q) && Number.isFinite(e) && e > 0 ? q * e : 0;
    return { p, opened: positionOpenedAtMs(p), notional };
  });
  scored.sort((a, b) => b.opened - a.opened || b.notional - a.notional);
  return scored[0]?.p;
}

function nearlySameTrailPx(a: number, b: number, rel = 1e-5): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return false;
  return Math.abs(a - b) / a < rel;
}

type HorzBracketLineSpec = { px: number; title: string; color: string };

/**
 * Collapse specs that sit at (almost) the same price so lightweight-charts only draws **one** price line
 * and **one** scale label per level — otherwise the library stacks duplicate tags and the axis looks noisy.
 */
function mergeBracketLineSpecsByPrice(lines: HorzBracketLineSpec[]): HorzBracketLineSpec[] {
  const out: HorzBracketLineSpec[] = [];
  for (const L of lines) {
    if (!Number.isFinite(L.px) || L.px <= 0) continue;
    const hit = out.find((e) => nearlySameTrailPx(e.px, L.px));
    if (hit) {
      const parts = hit.title.split(" · ").map((s) => s.trim());
      const t = L.title.trim();
      if (!parts.includes(t)) hit.title = `${hit.title} · ${t}`;
    } else {
      out.push({ px: L.px, title: L.title.trim(), color: L.color });
    }
  }
  return out;
}

/** SL/TP + trail preview lines (dashed). `axisLabelVisible` stays false — LWC stacks duplicate badges on the scale. */
function buildMergedFuturesBracketPriceSpecs(
  slPx: number | null,
  tpPx: number | null,
  trailLines: ChartStTrailPreviewLine[],
  badge: ChartTrailingBadge | null,
  isDark: boolean,
): HorzBracketLineSpec[] {
  const slCol = isDark ? "#f87171" : "#dc2626";
  const tpCol = isDark ? "#38bdf8" : "#0284c7";
  const amberTrail = isDark ? "#f59e0b" : "#d97706";
  const amberTrailSoft = isDark ? "#fbbf24" : "#f59e0b";
  const trailStopPx = trailLines.find((l) => l.kind === "st_trail" || l.kind === "fee_trail")?.px;
  const slAsTrail =
    slPx != null &&
    trailStopPx != null &&
    Number.isFinite(trailStopPx) &&
    nearlySameTrailPx(slPx, trailStopPx);
  const slUseTrailAmber = Boolean(badge?.trailed || slAsTrail);
  const slLineCol = slUseTrailAmber ? amberTrail : slCol;
  const bracketSpecs: HorzBracketLineSpec[] = [];
  if (slPx != null) {
    bracketSpecs.push({ px: slPx, title: slUseTrailAmber ? "SL trail" : "SL", color: slLineCol });
  }
  if (tpPx != null) {
    bracketSpecs.push({ px: tpPx, title: "TP", color: tpCol });
  }
  for (const ln of trailLines) {
    if (!Number.isFinite(ln.px) || ln.px <= 0) continue;
    const col = ln.kind === "st_activation" ? amberTrailSoft : amberTrail;
    bracketSpecs.push({ px: ln.px, title: ln.title, color: col });
  }
  return mergeBracketLineSpecsByPrice(bracketSpecs);
}

/** Futures row for the chart symbol (deduped); used for SL/TP price lines. */
function pickChartFuturesBracket(
  positions: unknown,
  chartSymbolEffective: string,
  _isMultiCoin: boolean,
  lastClose: number | null,
  bot?: unknown,
): {
  slPx: number | null;
  tpPx: number | null;
  hasBracket: boolean;
} {
  if (!inferFuturesBracketLinesActive(bot)) return { slPx: null, tpPx: null, hasBracket: false };
  const symKey = canonicalChartSymbol(chartSymbolEffective);
  if (!symKey) return { slPx: null, tpPx: null, hasBracket: false };
  const here = filterChartSymbolFuturesOpenRows(positions, chartSymbolEffective);
  const pos = selectPrimaryFuturesPositionForChart(here);
  if (!pos) return { slPx: null, tpPx: null, hasBracket: false };
  const slRaw = Number(pos.stopLoss);
  const tpRaw = Number(pos.takeProfit);
  let slPx = Number.isFinite(slRaw) && slRaw > 0 ? slRaw : null;
  let tpPx = Number.isFinite(tpRaw) && tpRaw > 0 ? tpRaw : null;
  const symPlausible = normalizeSymTf(chartSymbolEffective) || chartSymbolEffective;
  if (slPx != null && !futuresBracketLevelSane(symPlausible, slPx, lastClose)) slPx = null;
  if (tpPx != null && !futuresBracketLevelSane(symPlausible, tpPx, lastClose)) tpPx = null;
  return {
    slPx,
    tpPx,
    hasBracket: slPx != null || tpPx != null,
  };
}

/** First deduped futures row for the chart symbol (same filter as SL/TP brackets). */
function pickChartFuturesPositionRow(
  positions: unknown,
  chartSymbolEffective: string,
  _isMultiCoin: boolean,
  bot?: unknown,
): Record<string, unknown> | null {
  if (!inferFuturesBracketLinesActive(bot)) return null;
  const symKey = canonicalChartSymbol(chartSymbolEffective);
  if (!symKey) return null;
  const here = filterChartSymbolFuturesOpenRows(positions, chartSymbolEffective);
  return selectPrimaryFuturesPositionForChart(here) ?? null;
}

function metaTrailTrailedFromPosition(pos: Record<string, unknown>): boolean {
  const meta = (pos.meta || {}) as Record<string, unknown>;
  const ts = Number(meta.trailStep);
  return Number.isFinite(ts) && Math.floor(ts) >= 1;
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
  /** Every SL/TP `createPriceLine` handle so we always remove orphans (axis labels stack if `remove` is skipped or races). */
  const bracketPriceLinesRef = useRef<BracketPriceLineHandle[]>([]);
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
  const chartDisplaySymbol = useAppStore((s) => s.chartDisplaySymbol);
  const setChartDisplaySymbol = useAppStore((s) => s.setChartDisplaySymbol);
  const positions = useAppStore((s) => s.positions);
  const chartTheme = useThemeStore((s) => s.theme);

  const [altCandles, setAltCandles] = useState<any[]>([]);
  /** After SL tightens at least once for a symbol, keep the Trailed chip highlighted for that chart session (e.g. after flat). */
  const [chartTrailedSessionBySymbol, setChartTrailedSessionBySymbol] = useState<Record<string, true>>({});

  const effectiveSym = useMemo(() => {
    const b = normalizeSymTf(bot?.symbol);
    const d = chartDisplaySymbol ? normalizeSymTf(chartDisplaySymbol) : "";
    return d || b || "";
  }, [bot?.symbol, chartDisplaySymbol]);

  const isAltChartView = useMemo(() => {
    const b = normalizeSymTf(bot?.symbol);
    return Boolean(effectiveSym && b && effectiveSym !== b);
  }, [effectiveSym, bot?.symbol]);

  const isMultiCoinMode = String(bot?.universeCoinSelectMode || "").toUpperCase() === "MULTIPLE";

  /** Server `supertrendLastBarClose` / flips are for `bot.symbol` only — ignore on chart when viewing another pair. */
  const serverStSnapMatchesChart = useMemo(() => {
    const es = canonicalChartSymbol(effectiveSym);
    const bs = canonicalChartSymbol(bot?.symbol);
    return Boolean(es && bs && es === bs);
  }, [effectiveSym, bot?.symbol]);

  useEffect(() => {
    if (!isMultiCoinMode) setChartDisplaySymbol(null);
  }, [isMultiCoinMode, setChartDisplaySymbol]);

  const parseCandlesFromMarketApi = useCallback((r: any, chartSym: string) => {
    if (!r?.ok || !Array.isArray(r.candles)) return [] as any[];
    const out: any[] = [];
    let prevHello: number | null = null;
    for (const c of r.candles) {
      const cl = Number(c?.close);
      const lo = Number(c?.low);
      if (!isPlausibleCandleClose(chartSym, cl, lo, prevHello)) continue;
      out.push(c);
      prevHello = cl;
    }
    return out.slice(-CHART_CANDLE_MAX);
  }, []);

  useEffect(() => {
    const es = normalizeSymTf(effectiveSym);
    const bs = normalizeSymTf(bot?.symbol);
    if (!es) return;
    if (es === bs) {
      setAltCandles([]);
      return;
    }
    /** Avoid painting the previous alt pair while REST loads the newly selected symbol (tab vs chart mismatch). */
    setAltCandles([]);
    let cancelled = false;
    const load = async () => {
      try {
        const r = await api.marketCandles({ hours: 24, symbol: es });
        if (cancelled) return;
        setAltCandles(parseCandlesFromMarketApi(r, es));
      } catch {
        if (!cancelled) setAltCandles([]);
      }
    };
    void load();
    const id = window.setInterval(() => void load(), CHART_BACKGROUND_SYNC_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [effectiveSym, bot?.symbol, parseCandlesFromMarketApi]);

  const baseCandles = isAltChartView ? altCandles : candles;

  const ohlc = useMemo(
    () => buildOhlc(baseCandles, { symbol: effectiveSym || undefined }),
    [baseCandles, effectiveSym],
  );
  const ohlcLastClose = useMemo(() => {
    if (!ohlc.length) return null;
    const c = Number(ohlc[ohlc.length - 1]!.close);
    return Number.isFinite(c) && c > 0 ? c : null;
  }, [ohlc]);
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
      symbol: effectiveSym || undefined,
    });
  }, [
    ohlcAsMsCandles,
    effectiveSym,
    bot?.supertrendPeriod,
    bot?.supertrendMultiplier,
    bot?.supertrendWilderAtr,
    bot?.timeframe,
  ]);

  /** Latest k.x may be a no-flip bar; keep showing the last chart-aligned flip that autotrade could use (matches Activity). */
  const supertrendHud = useMemo(() => {
    if (!serverStSnapMatchesChart) return null;
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
  }, [bot?.supertrendLastBarClose, bot?.supertrendLastFlipBarClose, serverStSnapMatchesChart]);

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
    if (serverStSnapMatchesChart) {
      mergeServerFlip(
        bot?.supertrendLastBarClose as { ts?: number; buySignal?: boolean; sellSignal?: boolean } | null | undefined,
      );
      /** Persisted flip — latest close may be a no-flip bar after Activity placed an order. */
      mergeServerFlip(
        bot?.supertrendLastFlipBarClose as { ts?: number; buySignal?: boolean; sellSignal?: boolean } | null | undefined,
      );
    }
    return out.sort((a, b) => a.time - b.time);
  }, [
    chartSupertrend.markers,
    candleTimes,
    bot?.supertrendLastBarClose,
    bot?.supertrendLastFlipBarClose,
    ohlc,
    serverStSnapMatchesChart,
  ]);

  /** Persisted flips for current symbol/timeframe (server); markers + list under chart. T/W/K = TRADE/WAIT/SKIP. */
  const supertrendSignalHistoryRecent = useMemo(() => {
    const raw = Array.isArray(bot?.supertrendSignalHistory)
      ? (bot.supertrendSignalHistory as SupertrendSignalHistRow[])
      : [];
    const symChart = canonicalChartSymbol(effectiveSym);
    if (!symChart) return [];
    const tfBot = normalizeSymTf(bot?.timeframe ?? "").trim();
    const byKey = new Map<string, SupertrendSignalHistRow>();
    for (const h of raw) {
      const sym = canonicalChartSymbol(String(h.symbol ?? ""));
      /** Rows without `symbol` used to leak onto every chart in multi-coin mode — require exact pair match. */
      if (!sym || sym !== symChart) continue;
      const tf = String(h.timeframe ?? "").trim();
      if (tfBot && tf && tf !== tfBot) continue;
      byKey.set(`${h.ts}|${h.side}|${sym}|${tf}`, h);
    }
    return [...byKey.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  }, [bot?.supertrendSignalHistory, bot?.timeframe, effectiveSym]);

  const supertrendSignalHistoryNewestFirst = useMemo(
    () => [...supertrendSignalHistoryRecent].reverse(),
    [supertrendSignalHistoryRecent],
  );

  const supertrendSignalHistoryListRows = useMemo(
    () => supertrendSignalHistoryNewestFirst.slice(0, SUPERTREND_SIGNAL_LIST_MAX),
    [supertrendSignalHistoryNewestFirst],
  );

  const smartSsSuggestedTitle = useMemo(() => {
    const m = bot?.smartSignalStrengthThresholdMeta as Record<string, unknown> | null | undefined;
    const lines = [
      "Suggested min SS (0–100) from your signal list: resolved flips (True/False vs next opposite) vs composite strength.",
      "Scans thresholds high→low; keeps the highest SS floor where precision and Wilson lower bound pass (stable on small n).",
      "Blends with the last saved value after restarts so new jsonl rows refine the estimate.",
    ];
    if (m && typeof m === "object") {
      const n = m.nResolved;
      const p = m.precisionAtThreshold;
      const wl = m.wilsonLower;
      const lr = m.learnedRaw;
      if (typeof n === "number" && Number.isFinite(n)) lines.push(`Resolved rows used: ${n}`);
      if (typeof p === "number" && Number.isFinite(p)) lines.push(`Precision at chosen floor: ${(p * 100).toFixed(1)}%`);
      if (typeof wl === "number" && Number.isFinite(wl)) lines.push(`Wilson LB: ${(wl * 100).toFixed(1)}%`);
      if (lr != null && Number.isFinite(Number(lr))) lines.push(`Raw scan result (before blend): ${Math.round(Number(lr))}`);
    }
    return lines.join("\n");
  }, [bot?.smartSignalStrengthThresholdMeta]);

  const supertrendSignalVerdictsChrono = useMemo(
    () => computeSupertrendSignalVerdicts(supertrendSignalHistoryRecent, ohlc),
    [supertrendSignalHistoryRecent, ohlc],
  );

  const signalListCloseBySec = useMemo(() => {
    const m = new Map<number, number>();
    for (const b of ohlc) {
      const t = Number(b.time);
      const c = Number(b.close);
      if (Number.isFinite(t) && Number.isFinite(c) && c > 0) m.set(t, c);
    }
    return m;
  }, [ohlc]);

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
      const text =
        isMultiCoinMode && !m.preview
          ? m.side === "buy"
            ? "▲ ST"
            : "▼ ST"
          : formatSupertrendSignalMarkerText(m, hMatch);
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
  }, [safeMarkers, supertrendSignalHistoryRecent, candleTimes, isMultiCoinMode]);

  const supertrendSoundCtx = useMemo(
    () =>
      `${normalizeSymTf(effectiveSym)}|${normalizeSymTf(bot?.timeframe)}|${Number(bot?.supertrendPeriod ?? 10)}|${Number(bot?.supertrendMultiplier ?? 3)}|${bot?.supertrendWilderAtr !== false}`,
    [effectiveSym, bot?.timeframe, bot?.supertrendPeriod, bot?.supertrendMultiplier, bot?.supertrendWilderAtr],
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
    const bSym = normalizeSymTf(effectiveSym);
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
    const pr = market?.feedExecutionPause?.reason;
    const feedPauseLabel =
      pr === "feed_ws"
        ? "Feed: WS reconnecting (autotrade paused)"
        : pr === "feed_stale"
          ? "Feed: stale (autotrade paused)"
          : null;
    return { symbol, tf, price, regimeType, stTrend, feedPauseLabel };
  }, [effectiveSym, bot?.timeframe, market, ohlc, chartSupertrend.lastTrend]);

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
      rightPriceScale: {
        visible: true,
        borderVisible: true,
        borderColor: "rgba(148,163,184,0.15)",
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      leftPriceScale: { visible: false },
      crosshair: { mode: 0 },
      handleScroll: true,
      handleScale: true,
    });

    const cur = ohlcRef.current;
    const last0 =
      cur.length > 0
        ? (() => {
            const c = Number(cur[cur.length - 1]!.close);
            return Number.isFinite(c) && c > 0 ? c : null;
          })()
        : null;
    const pf0 = inferChartPriceFormat(last0);

    const series = chart.addCandlestickSeries({
      priceScaleId: "right",
      upColor: "#34d399",
      downColor: "#fb7185",
      borderDownColor: "#fb7185",
      borderUpColor: "#34d399",
      wickDownColor: "#fb7185",
      wickUpColor: "#34d399",
      /**
       * Realtime last close: dashed line + highlighted last-value label on the price scale (SL/TP/trail use
       * separate `createPriceLine` without axis tags to avoid stacked badges).
       */
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineWidth: 1,
      priceLineStyle: LineStyle.Dashed,
      priceLineColor: chartTheme === "dark" ? "#ffffff" : "#0f172a",
      priceFormat: pf0,
    });

    const stLine = chart.addLineSeries({
      priceScaleId: "right",
      color: "#4ade80",
      lineWidth: 2,
      /** Empty title avoids an extra scale label column fighting with tick marks. */
      title: "",
      lastValueVisible: false,
      priceLineVisible: false,
      priceFormat: pf0,
    });

    chartRef.current = chart;
    seriesRef.current = series;
    supertrendLineRef.current = stLine;
    chartOkRef.current = true;

    if (cur.length) {
      try {
        const st = useAppStore.getState();
        const sym0 = normalizeSymTf(st.chartDisplaySymbol ?? st.bot?.symbol);
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
      for (const pl of bracketPriceLinesRef.current) {
        try {
          pl.remove();
        } catch {
          /* ignore */
        }
      }
      bracketPriceLinesRef.current = [];
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
        rightPriceScale: {
          visible: true,
          borderVisible: true,
          borderColor: isDark ? "rgba(148,163,184,0.15)" : "rgba(71,85,105,0.22)",
          scaleMargins: { top: 0.1, bottom: 0.1 },
        },
      });
      st?.applyOptions?.({ color: isDark ? "#4ade80" : "#15803d", title: "" });
      seriesRef.current?.applyOptions?.({
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineWidth: 1,
        priceLineStyle: LineStyle.Dashed,
        priceLineColor: isDark ? "#ffffff" : "#0f172a",
      });
    } catch {
      /* ignore */
    }
  }, [chartTheme, chartInstanceKey]);

  /** Keep tick marks valid when switching pairs (esp. sub‑$1 coins like DOGE). */
  useEffect(() => {
    if (!chartOkRef.current) return;
    const pf = inferChartPriceFormat(ohlcLastClose);
    try {
      const isDark = chartTheme === "dark";
      seriesRef.current?.applyOptions?.({
        lastValueVisible: true,
        priceLineVisible: true,
        priceLineWidth: 1,
        priceLineStyle: LineStyle.Dashed,
        priceLineColor: isDark ? "#ffffff" : "#0f172a",
        priceFormat: pf,
      });
      supertrendLineRef.current?.applyOptions?.({
        lastValueVisible: false,
        priceLineVisible: false,
        title: "",
        priceFormat: pf,
      });
    } catch {
      /* ignore */
    }
  }, [ohlcLastClose, chartInstanceKey]);

  const symKey = useMemo(() => canonicalChartSymbol(effectiveSym), [effectiveSym]);

  /** No open leg for this chart symbol → clear session “Trailed” memory so tan chips / legend match flat state. */
  useEffect(() => {
    if (!symKey) return;
    const pos = pickChartFuturesPositionRow(positions, effectiveSym, isMultiCoinMode, bot);
    const q = pos ? Math.abs(Number(pos.qty ?? pos.positionAmt ?? 0)) : 0;
    if (q > 1e-8) return;
    setChartTrailedSessionBySymbol((prev) => {
      if (!prev[symKey]) return prev;
      const next = { ...prev };
      delete next[symKey];
      return next;
    });
  }, [symKey, positions, effectiveSym, isMultiCoinMode, bot]);

  const futuresBracket = useMemo(() => {
    const futActive = inferFuturesBracketLinesActive(bot) ? 1 : 0;
    const { slPx, tpPx, hasBracket } = pickChartFuturesBracket(
      positions,
      effectiveSym,
      isMultiCoinMode,
      ohlcLastClose,
      bot,
    );
    const posRow = pickChartFuturesPositionRow(positions, effectiveSym, isMultiCoinMode, bot);
    const trailStepKey =
      posRow?.meta && typeof posRow.meta === "object"
        ? String((posRow.meta as { trailStep?: unknown }).trailStep ?? "")
        : "";
    /** Forces SL/TP/trail layer refresh when the open leg changes (close/reopen, new entry/qty) even if SL/TP numbers match. */
    const openPosSig = posRow
      ? `open:${Math.abs(Number(posRow.qty ?? posRow.positionAmt ?? 0)).toFixed(8)}@${Number(posRow.entryPrice ?? 0).toFixed(6)}`
      : "flat";
    const slCol = chartTheme === "dark" ? "#f87171" : "#dc2626";
    const tpCol = chartTheme === "dark" ? "#38bdf8" : "#0284c7";
    const mm = String(bot?.marketMode ?? "").toUpperCase();
    /** Omit `ohlcLastClose` here — it changes every tick and was recreating price lines / stacking axis labels. SL/TP values already reflect sanity vs last close. */
    const key = `${symKey}|${openPosSig}|${slPx ?? ""}|${tpPx ?? ""}|${trailStepKey}|${chartTheme}|${isMultiCoinMode ? "M" : "S"}|${futActive}|${mm}`;
    return { key, slPx, tpPx, hasBracket, slCol, tpCol };
  }, [
    positions,
    effectiveSym,
    symKey,
    chartTheme,
    isMultiCoinMode,
    ohlcLastClose,
    bot?.marketMode,
    bot?.supertrendFuturesAuto,
    bot?.supertrendSpotAuto,
    bot?.trailingStopLossAuto,
  ]);

  /**
   * Trailing preview lines for the charted futures leg.
   * Supertrend mode: **ST trail activates** (mark must cross this — same as server `activation`; only then does ST trailing apply).
   * **ST trail** is shown only once `computeSupertrendTrailingSlUpdate` returns OK (matches server: NO_TRAIL does not move SL toward ST).
   * Fee ladder: one line.
   */
  const chartTrailingPreview = useMemo((): ChartTrailingPreview => {
    const none = (k: string, badge: ChartTrailingBadge | null = null): ChartTrailingPreview => ({
      key: k,
      lines: [] as ChartStTrailPreviewLine[],
      badge,
    });
    if (bot?.trailingStopLossAuto !== true) return none("trail-off");
    if (!inferFuturesBracketLinesActive(bot)) return none("trail-venue");

    const pos = pickChartFuturesPositionRow(positions, effectiveSym, isMultiCoinMode, bot);
    if (!pos) return none("trail-nopos");
    const q = Number(pos.qty ?? pos.positionAmt);
    if (!Number.isFinite(q) || Math.abs(q) <= 1e-8) return none("trail-flat");
    const isLong = futuresPositionIsLong(pos as Record<string, unknown>);
    const trailedPersist = metaTrailTrailedFromPosition(pos);
    const mkBadge = (trailing: boolean): ChartTrailingBadge => ({ trailing, trailed: trailedPersist });
    const entry = Number(pos.entryPrice);
    if (!Number.isFinite(entry) || entry <= 0) return none("trail-noentry", mkBadge(false));
    const levRaw = Number(pos.leverage);
    const lev = Math.max(1, Math.floor(Number.isFinite(levRaw) && levRaw > 0 ? levRaw : 1));
    const mp = Number(pos.markPrice);
    const cur =
      Number.isFinite(mp) && mp > 0
        ? mp
        : ohlcLastClose != null && Number.isFinite(ohlcLastClose) && ohlcLastClose > 0
          ? ohlcLastClose
          : NaN;
    if (!Number.isFinite(cur) || cur <= 0) return none("trail-nopx", mkBadge(false));

    const symPlausible = normalizeSymTf(effectiveSym) || effectiveSym;
    const slRaw = Number(pos.stopLoss);
    let prevSlChart = Number.isFinite(slRaw) && slRaw > 0 ? slRaw : NaN;
    if (Number.isFinite(prevSlChart) && !futuresBracketLevelSane(symPlausible, prevSlChart, ohlcLastClose)) {
      prevSlChart = NaN;
    }
    const prevSlForCompute =
      Number.isFinite(prevSlChart) && prevSlChart > 0 ? prevSlChart : isLong ? entry * 1e-8 : entry * 1e8;

    const mode = String(bot?.futuresTrailingStopMode || "SUPERTREND").toUpperCase() === "FEE_LADDER" ? "FEE_LADDER" : "SUPERTREND";
    const feeR = clampTradeCloseFeeRate();
    const bufferRate = 0.0005;
    const maintenanceMarginRate = 0.005;

    const { slPx: chartSlRaw } = pickChartFuturesBracket(positions, effectiveSym, isMultiCoinMode, ohlcLastClose, bot);
    const slDup = (px: number) =>
      chartSlRaw != null && Number.isFinite(chartSlRaw) && chartSlRaw > 0 && nearlySameTrailPx(px, chartSlRaw);

    if (mode === "FEE_LADDER") {
      let displayPx: number | null = null;
      const extras = Array.isArray(bot?.trailingStopExtraScalpingPcts)
        ? (bot.trailingStopExtraScalpingPcts as unknown[]).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
        : [];
      const meta = (pos.meta || {}) as Record<string, unknown>;
      const ts = Number(meta.trailStep);
      const step0 = Number.isFinite(ts) && ts >= 0 ? Math.floor(ts) : 0;
      let extremePx = Number(meta.extremePx);
      if (!Number.isFinite(extremePx) || extremePx <= 0) extremePx = entry;

      const adv = advanceTrailingStopState({
        entryPx: entry,
        isLong,
        trailStep: step0,
        extremePx,
        markPx: cur,
        feeRate: feeR,
        extraScalpingPctsOfEntry: extras,
      });

      if (adv.advanced && adv.proposedSl != null && Number.isFinite(adv.proposedSl)) {
        const merged = mergeStopWithTrail(isLong, prevSlForCompute, adv.proposedSl);
        if (merged != null && Number.isFinite(merged) && merged > 0) displayPx = merged;
      }
      if (displayPx == null) {
        const levels = buildTrailLockPrices(entry, isLong, feeR, extras);
        const next = levels[adv.trailStep];
        if (next && Number.isFinite(next.lockPx) && next.lockPx > 0) displayPx = next.lockPx;
      }
      const feeTrailingLive = adv.trailStep >= 1;
      if (displayPx == null || !Number.isFinite(displayPx) || displayPx <= 0) {
        return none("trail-nodisp", mkBadge(feeTrailingLive));
      }
      if (!futuresBracketLevelSane(symPlausible, displayPx, ohlcLastClose)) {
        return none("trail-insane", mkBadge(feeTrailingLive));
      }
      if (slDup(displayPx)) return none("trail-dup-sl", mkBadge(feeTrailingLive));
      return {
        /** Omit mark `cur` from key — it changes every tick and was retriggering price-line workarounds. */
        key: `trail-FEE-${displayPx.toFixed(6)}|${symKey}`,
        lines: [{ px: displayPx, title: "Fee trail", kind: "fee_trail" }],
        badge: mkBadge(feeTrailingLive),
      };
    }

    const pts = chartSupertrend.linePoints;
    if (!pts.length) return none("trail-nost", mkBadge(false));
    /** Longs trail vs lower rail (`up`); shorts vs upper (`dn`). Regime `line` flips with trend and inverts trail geometry. */
    const stPxPrefer = isLong ? chartSupertrend.lastUp : chartSupertrend.lastDn;
    const stPxFallback = Number(pts[pts.length - 1]!.value);
    const stPx =
      stPxPrefer != null && Number.isFinite(stPxPrefer) && stPxPrefer > 0 ? stPxPrefer : stPxFallback;
    if (!Number.isFinite(stPx) || stPx <= 0) return none("trail-badst", mkBadge(false));

    let breakeven: number;
    let activation: number;
    let liquidation: number;
    if (isLong) {
      breakeven = entry * (1 + feeR);
      activation = entry * (1 + feeR + bufferRate);
      liquidation = entry * (1 - 1 / lev + maintenanceMarginRate);
      if (liquidation >= breakeven) return none("trail-reject", mkBadge(false));
    } else {
      breakeven = entry * (1 - feeR);
      activation = entry * (1 - feeR - bufferRate);
      liquidation = entry * (1 + 1 / lev - maintenanceMarginRate);
      if (liquidation <= breakeven) return none("trail-reject", mkBadge(false));
    }

    const r = computeSupertrendTrailingSlUpdate({
      entryPrice: entry,
      currentPrice: cur,
      supertrend: stPx,
      previousSl: prevSlForCompute,
      isLong,
      leverage: lev,
      feeRate: feeR,
      bufferRate,
      maintenanceMarginRate,
      minSlDistanceFrac: 0.002,
    });

    if (r.status === "NO_SUPERTREND" || r.status === "INVALID" || r.status === "REJECT_TRADE") {
      return none(`trail-${r.status}`, mkBadge(false));
    }

    /** Only after activation does the server merge SL toward ST; do not preview ST-as-trail before that. */
    const trailPx = r.status === "OK" ? r.newSl : null;
    const stTrailingLive = r.status === "OK";

    const lines: ChartStTrailPreviewLine[] = [];

    if (futuresBracketLevelSane(symPlausible, activation, ohlcLastClose) && !slDup(activation)) {
      lines.push({
        px: activation,
        title: isLong ? "ST trail opens (mark ≥)" : "ST trail opens (mark ≤)",
        kind: "st_activation",
      });
    }

    if (
      trailPx != null &&
      Number.isFinite(trailPx) &&
      trailPx > 0 &&
      futuresBracketLevelSane(symPlausible, trailPx, ohlcLastClose) &&
      !slDup(trailPx)
    ) {
      const dupAct = lines.some((l) => nearlySameTrailPx(l.px, trailPx));
      if (!dupAct) {
        lines.push({ px: trailPx, title: "ST trail", kind: "st_trail" });
      }
    }

    if (!lines.length) {
      return { key: `trail-empty|${symKey}`, lines: [], badge: mkBadge(stTrailingLive) };
    }

    return {
      /** Coarser px in key so mark-driven micro jitter does not retrigger the price-line effect every tick. */
      key: `trail-ST-${lines.map((l) => `${l.kind}:${l.px.toFixed(2)}`).join("|")}|${symKey}`,
      lines,
      badge: mkBadge(stTrailingLive),
    };
  }, [
    bot?.trailingStopLossAuto,
    bot?.futuresTrailingStopMode,
    bot?.trailingStopExtraScalpingPcts,
    bot?.marketMode,
    bot?.supertrendFuturesAuto,
    bot?.supertrendSpotAuto,
    positions,
    effectiveSym,
    symKey,
    isMultiCoinMode,
    ohlcLastClose,
    chartSupertrend.linePoints,
    chartSupertrend.lastUp,
    chartSupertrend.lastDn,
  ]);

  useEffect(() => {
    if (!symKey) return;
    /** Persist only when the server has actually tightened SL at least once (`trailStep` ≥ 1). */
    if (chartTrailingPreview.badge?.trailed === true) {
      setChartTrailedSessionBySymbol((prev) => (prev[symKey] ? prev : { ...prev, [symKey]: true }));
    }
  }, [symKey, chartTrailingPreview.badge?.trailed]);

  const trailingStatusChipsVisible = useMemo(() => {
    if (bot?.trailingStopLossAuto !== true) return false;
    if (!inferFuturesBracketLinesActive(bot)) return false;
    if (chartTrailingPreview.badge) return true;
    return Boolean(symKey && chartTrailedSessionBySymbol[symKey]);
  }, [
    bot,
    bot?.trailingStopLossAuto,
    chartTrailingPreview.badge,
    symKey,
    chartTrailedSessionBySymbol,
  ]);

  const trailingChipTrailedHighlight =
    chartTrailingPreview.badge?.trailed === true ||
    Boolean(symKey && chartTrailedSessionBySymbol[symKey]);

  /**
   * Single stable key for the SL/TP/trail price-line effect.
   * **Do not** key that effect on `chartTrailingPreview.lines` — it is a fresh array every memo run (e.g. every
   * positions WS tick), so React re-ran the effect constantly; rapid `createPriceLine` without reliable `remove`
   * stacked identical axis labels (same price, column of badges).
   */
  const chartBracketPriceLayerKey = useMemo(
    () =>
      `${futuresBracket.key}|${chartTrailingPreview.key}|${chartTheme}|${chartInstanceKey}|${chartTrailingPreview.badge?.trailing ? 1 : 0}${chartTrailingPreview.badge?.trailed ? 1 : 0}`,
    [
      futuresBracket.key,
      chartTrailingPreview.key,
      chartTheme,
      chartInstanceKey,
      chartTrailingPreview.badge?.trailing,
      chartTrailingPreview.badge?.trailed,
    ],
  );

  /** One row per merged price level — replaces LWC axis tags (disabled to avoid stacked duplicates). */
  const futuresBracketAxisLegend = useMemo((): HorzBracketLineSpec[] => {
    if (!inferFuturesBracketLinesActive(bot)) return [];
    const { slPx, tpPx } = pickChartFuturesBracket(
      positions,
      effectiveSym,
      isMultiCoinMode,
      ohlcLastClose,
      bot,
    );
    const hasTrail = chartTrailingPreview.lines.length > 0;
    if (
      (slPx == null || !Number.isFinite(slPx)) &&
      (tpPx == null || !Number.isFinite(tpPx)) &&
      !hasTrail
    ) {
      return [];
    }
    return buildMergedFuturesBracketPriceSpecs(
      slPx,
      tpPx,
      chartTrailingPreview.lines,
      chartTrailingPreview.badge,
      chartTheme === "dark",
    );
  }, [bot, positions, effectiveSym, isMultiCoinMode, ohlcLastClose, chartTrailingPreview, chartTheme]);

  function removeAllBracketPriceLines() {
    const prev = bracketPriceLinesRef.current;
    bracketPriceLinesRef.current = [];
    for (const pl of prev) {
      try {
        pl.remove();
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Futures SL/TP for the chart symbol.
   * Runs only when `chartBracketPriceLayerKey` changes — not on every `chartTrailingPreview.lines` reference
   * churn (see memo above).
   */
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !chartOkRef.current) {
      removeAllBracketPriceLines();
      return;
    }

    const live = useAppStore.getState();
    const eff =
      normalizeSymTf(live.chartDisplaySymbol ?? "").trim() || normalizeSymTf(live.bot?.symbol ?? "").trim();
    const symK = canonicalChartSymbol(eff);
    if (!symK) {
      removeAllBracketPriceLines();
      return;
    }

    const multi = String(live.bot?.universeCoinSelectMode ?? "").toUpperCase() === "MULTIPLE";
    const oc = ohlcRef.current;
    const lastClose =
      oc.length > 0
        ? (() => {
            const c = Number(oc[oc.length - 1]!.close);
            return Number.isFinite(c) && c > 0 ? c : null;
          })()
        : null;
    const { slPx, tpPx } = pickChartFuturesBracket(live.positions, eff, multi, lastClose, live.bot);
    const isDark = chartTheme === "dark";

    removeAllBracketPriceLines();

    /** `axisLabelVisible: false` — lightweight-charts stacks multiple axis badges for price lines at/near the same level. */
    const lineOpts = (price: number, title: string, color: string) => ({
      price,
      color,
      lineWidth: 1,
      lineStyle: 2 as const,
      axisLabelVisible: false,
      title,
    });

    const mergedBracketLines = buildMergedFuturesBracketPriceSpecs(
      slPx,
      tpPx,
      chartTrailingPreview.lines,
      chartTrailingPreview.badge,
      isDark,
    );

    try {
      for (const m of mergedBracketLines) {
        bracketPriceLinesRef.current.push(series.createPriceLine(lineOpts(m.px, m.title, m.color)));
      }
    } catch {
      removeAllBracketPriceLines();
    }

    return () => {
      removeAllBracketPriceLines();
    };
  }, [chartBracketPriceLayerKey]);

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
    const sym = normalizeSymTf(effectiveSym);

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
  }, [ohlc, effectiveSym]);

  useEffect(() => {
    const sym = effectiveSym;
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
  }, [effectiveSym, bot?.timeframe]);

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
    const sym = normalizeSymTf(effectiveSym);
    const tf = normalizeSymTf(bot?.timeframe);
    if (!sym || !tf) return;
    setChartRefreshBusy(true);
    try {
      const pushLog = useAppStore.getState().pushLog;
      if (isAltChartView) {
        const r = await api.marketCandles({ hours: 24, symbol: sym });
        const cc = parseCandlesFromMarketApi(r, sym);
        if (cc.length) {
          setAltCandles(cc);
          chartOhlcAppliedRef.current = null;
          setChartInstanceKey((k) => k + 1);
          pushLog({ level: "info", msg: `Chart reloaded from server (REST) · ${sym}` });
        } else pushLog({ level: "warn", msg: "Chart refresh: no candles returned." });
      } else {
        const r = await api.marketCandles(24);
        const ok = applyMarketCandlesResult(r, sym, tf);
        if (ok) {
          chartOhlcAppliedRef.current = null;
          setChartInstanceKey((k) => k + 1);
          pushLog({
            level: "info",
            msg: "Chart fully reloaded from server (new canvas + OHLC snapshot, same path as after reconnect)",
          });
        } else pushLog({ level: "warn", msg: "Chart refresh: no data or pair changed — try again." });
      }
    } catch {
      useAppStore.getState().pushLog({ level: "error", msg: "Chart refresh failed (network or server error)" });
    } finally {
      setChartRefreshBusy(false);
    }
  }, [effectiveSym, bot?.timeframe, isAltChartView, parseCandlesFromMarketApi, applyMarketCandlesResult]);

  /** REST snapshot after symbol/timeframe change so the chart fills ~24h once Binance backfill completes (primary feed only). */
  useEffect(() => {
    const sym = normalizeSymTf(bot?.symbol);
    const tf = normalizeSymTf(bot?.timeframe);
    if (!sym || !tf) return;
    if (normalizeSymTf(effectiveSym) !== sym) return;
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
  }, [effectiveSym, bot?.symbol, bot?.timeframe, applyMarketCandlesResult]);

  useEffect(() => {
    const sym = normalizeSymTf(bot?.symbol);
    const tf = normalizeSymTf(bot?.timeframe);
    if (!sym || !tf) return;
    if (normalizeSymTf(effectiveSym) !== sym) return;
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
  }, [effectiveSym, bot?.symbol, bot?.timeframe, applyMarketCandlesResult]);

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
              <span className="text-slate-600 dark:text-slate-400">T</span> can open).{" "}
              <span className="text-slate-600 dark:text-slate-400">Verdict</span> = indicator check vs next opposite: BUY → Open until next SELL,
              then True if buy price &lt; that sell price; SELL → Open until next BUY, then True if sell price &gt; that buy price. Latest signal stays Open.{" "}
              <span className="text-amber-700/90 dark:text-amber-300/90">Amber (lighter)</span> = Supertrend <span className="font-medium">activation</span>{" "}
              (mark must cross so trailing engages; entry + fee + buffer, same as server).{" "}
              <span className="text-amber-800/95 dark:text-amber-200/95">Amber (solid)</span> = <span className="font-medium">trail stop</span> / ST trail
              level. <span className="font-medium">Fee trail</span> uses the same amber when fee-ladder mode is on.               SL turns amber when it matches the trail
              stop or after a trailed update. Bracket + trail dashed lines share one merged level when prices match; **labels are in the bottom-right overlay** (TradingView was stacking duplicate badges on the price scale). The candle series keeps the last-close horizontal line without a separate last-value scale tag.
              Top-left chips: <span className="font-medium">Trailing</span> highlights after the mark crosses ST activation (or fee-ladder lock progression);{" "}
              <span className="font-medium">Trailed</span> after the server has applied at least one trailing stop update (<span className="font-mono">trailStep</span> ≥ 1).
            </p>
          </div>
          <button
            type="button"
            onClick={() => void handleRefreshChart()}
            disabled={chartRefreshBusy || !normalizeSymTf(effectiveSym) || !normalizeSymTf(bot?.timeframe)}
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
            {chartHud.feedPauseLabel ? (
              <span className="ml-2 text-amber-600 dark:text-amber-400/95" title={chartHud.feedPauseLabel}>
                · {chartHud.feedPauseLabel}
              </span>
            ) : null}
            {!isAltChartView && supertrendHud ? (
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
        {isAltChartView ? (
          <p className="text-[10px] leading-snug text-amber-800/95 dark:text-amber-200/90">
            Main chart: <span className="font-mono">{effectiveSym}</span> (REST + periodic sync). Live WebSocket candle stream follows bot symbol{" "}
            <span className="font-mono">{normalizeSymTf(bot?.symbol) || "—"}</span> — switch tab to match bot for realtime ticks.
          </p>
        ) : null}
        <div className="relative w-full shrink-0">
          <div
            key={chartInstanceKey}
            ref={containerRef}
            className="w-full min-h-[240px]"
            style={{ height: "min(390px, 45vh)" }}
          />
          {futuresBracketAxisLegend.length > 0 ? (
            <div
              className="pointer-events-none absolute bottom-2 right-2 z-10 max-w-[min(20rem,92%)] space-y-0.5 rounded-md border border-slate-600/50 bg-slate-950/85 px-2 py-1.5 text-[10px] leading-tight shadow-lg backdrop-blur-sm dark:border-slate-500/40 dark:bg-slate-950/90"
              aria-label="Futures bracket and trail levels"
            >
              {futuresBracketAxisLegend.map((row) => (
                <div key={`${row.title}-${row.px}`} className="flex flex-wrap items-baseline justify-end gap-x-1.5 gap-y-0">
                  <span className="max-w-[14rem] truncate font-medium" style={{ color: row.color }}>
                    {row.title}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-slate-100">{row.px.toLocaleString("en-US", { maximumFractionDigits: 6 })}</span>
                </div>
              ))}
            </div>
          ) : null}
          {trailingStatusChipsVisible ? (
            <div
              className="pointer-events-none absolute left-2 top-2 z-10 flex flex-row items-center gap-1.5"
              aria-label="Futures trailing status"
            >
              <span
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide shadow-sm ${
                  chartTrailingPreview.badge?.trailing
                    ? "bg-amber-500 text-slate-950 dark:bg-amber-400 dark:text-slate-950"
                    : "border border-slate-400/60 bg-slate-900/55 text-slate-400 dark:border-slate-600 dark:bg-slate-950/70 dark:text-slate-500"
                }`}
              >
                Trailing
              </span>
              <span
                className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide shadow-sm ${
                  trailingChipTrailedHighlight
                    ? "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950"
                    : "border border-slate-400/60 bg-slate-900/55 text-slate-400 dark:border-slate-600 dark:bg-slate-950/70 dark:text-slate-500"
                }`}
              >
                Trailed
              </span>
            </div>
          ) : null}
        </div>
        {isMultiCoinMode && Array.isArray(positions) && positions.length > 0 ? (
          <PositionMiniChartsRow
            positions={positions}
            mainSymbol={effectiveSym}
            onPickSymbol={(sym) => setChartDisplaySymbol(sym)}
          />
        ) : null}
        <MultiCoinSignalTabs />
        {supertrendSignalHistoryListRows.length > 0 ? (
          <div className="w-full rounded-md border border-slate-200/90 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-950/50 px-2 py-2">
            <div className="mb-1.5 flex flex-row items-start justify-between gap-2">
              <div className="min-w-0 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-500">
                {supertrendSignalHistoryNewestFirst.length > SUPERTREND_SIGNAL_LIST_MAX
                  ? `Last ${SUPERTREND_SIGNAL_LIST_MAX} of ${supertrendSignalHistoryNewestFirst.length} signals`
                  : `${supertrendSignalHistoryListRows.length} signal${supertrendSignalHistoryListRows.length === 1 ? "" : "s"}`}{" "}
                <span className="normal-case text-slate-500">
                  ({normalizeSymTf(effectiveSym) || "—"} · newest first · scores match markers, times {CHART_TIMEZONE})
                </span>
              </div>
              <div
                className="shrink-0 text-right text-[10px] leading-tight text-slate-600 dark:text-slate-400"
                title={
                  bot?.smartSignalStrengthThreshold != null && Number.isFinite(Number(bot.smartSignalStrengthThreshold))
                    ? smartSsSuggestedTitle
                    : "Computed server-side from resolved list outcomes (True/False) vs SS; persisted across restarts."
                }
              >
                <div className="font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-500">Suggested SS</div>
                {bot?.smartSignalStrengthThreshold != null && Number.isFinite(Number(bot.smartSignalStrengthThreshold)) ? (
                  <div className="font-mono text-sm font-semibold text-emerald-600 dark:text-emerald-400">
                    ≥{Math.round(Number(bot.smartSignalStrengthThreshold))}
                  </div>
                ) : (
                  <div className="font-mono text-sm text-slate-500">—</div>
                )}
              </div>
            </div>
            <ul className="max-h-[min(360px,50vh)] space-y-1 overflow-y-auto text-[11px] leading-snug">
              {supertrendSignalHistoryListRows.map((h, i) => {
                const ai =
                  h.aiGate != null && Number.isFinite(Number(h.aiGate)) ? Number(h.aiGate).toFixed(2) : "—";
                const ss =
                  h.strength != null && Number.isFinite(Number(h.strength)) ? String(Math.round(Number(h.strength))) : "—";
                const sp =
                  h.surfPulse != null && Number.isFinite(Number(h.surfPulse)) ? Number(h.surfPulse).toFixed(2) : "—";
                const act = h.stAction != null ? String(h.stAction) : "—";
                const nAll = supertrendSignalHistoryNewestFirst.length;
                const chronoIdx = nAll - 1 - i;
                const verdict = supertrendSignalVerdictsChrono[chronoIdx];
                const sec = Math.floor(Number(h.ts) / 1000);
                const entryPx = Number.isFinite(sec) ? signalListCloseBySec.get(sec) : undefined;
                const entryStr =
                  entryPx != null && Number.isFinite(entryPx) && entryPx > 0 ? entryPx.toFixed(2) : "—";
                const vLabel = formatSupertrendSignalVerdict(verdict);
                const vCls =
                  verdict === true
                    ? "text-emerald-400"
                    : verdict === false
                      ? "text-rose-400"
                      : verdict === "open"
                        ? "text-amber-300/90"
                        : "text-slate-500";
                const pair =
                  (h.symbol != null && String(h.symbol).trim()) ||
                  normalizeSymTf(effectiveSym) ||
                  "—";
                return (
                  <li
                    key={`${pair}-${h.ts}-${h.side}-${i}`}
                    className={
                      h.side === "BUY"
                        ? "border-l-2 border-emerald-500/60 pl-2 text-emerald-100/95"
                        : "border-l-2 border-rose-500/60 pl-2 text-rose-100/95"
                    }
                  >
                    <span className="text-slate-600 dark:text-slate-500">{formatHistTimeIst(h.ts)}</span>{" "}
                    <span className="font-mono text-[10px] font-semibold text-slate-700 dark:text-slate-300">{pair}</span>{" "}
                    <span className="font-semibold">{h.side}</span>
                    <span className="text-slate-600 dark:text-slate-400"> · @ {entryStr}</span>
                    <span className="text-slate-600 dark:text-slate-400"> · AI {ai}</span>
                    <span className="text-slate-600 dark:text-slate-400"> · SS {ss}</span>
                    <span className="text-slate-600 dark:text-slate-400"> · SP {sp}</span>
                    <span className="text-slate-600 dark:text-slate-500"> · {act}</span>
                    <span className={`font-medium ${vCls}`}> · {vLabel}</span>
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
