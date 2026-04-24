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
import { isPlausibleCandleClose, normalizeSym } from "../lib/symbolPriceSanity";
import { CLIENT_SUPERTREND_CHIME_EVENT, type ClientSupertrendChimeDetail } from "../lib/clientActivityEvents";
import { playSupertrendBuySound, playSupertrendSellSound } from "../lib/uiSounds";
import { binanceIntervalMs, buildChartSupertrend } from "../lib/supertrend";
import {
  advanceTrailingStopState,
  buildTrailLockPrices,
  DEFAULT_TRAIL_FEE_BE_MULTIPLIER,
  extrapolateTrailTierLockPx,
  feeRateBreakevenPadded,
  mergeStopWithTrail,
  supertrendTieredActivationGate,
  tierLabelForTrailIndex,
  trailLadderConsecutiveLocksReached,
  computeSupertrendTieredMaxTrailStepFromExtreme,
  maxTrailStepsForConfig,
  computeEffectiveTrailBuffer,
  tieredStLockPxForCompletedTrailStep,
} from "../lib/trailingFeeLadder";
import {
  applyMinTrailGapFromMark,
  computeSupertrendTrailingSlUpdate,
  trailStepToTierLabel,
} from "../lib/supertrendTrailingSl";
import { clampTradeCloseFeeRate } from "../lib/tradeCloseFee";
import {
  computeSupertrendSignalVerdicts,
  formatSupertrendSignalVerdict,
} from "../lib/supertrendSignalVerdict";
import { displayMarketDecisionVerdict, mdEnforcementOff } from "../lib/marketDecision/display";
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

/**
 * Multi-coin alt tab: REST gives deep history; WS `candles` give the live tail. Merge so the chart is not
 * stuck painting **only** `altCandles` until an arbitrary bar count — that made non-primary pairs look frozen.
 */
function mergeAltRestWithLiveWs(alt: any[], live: any[]): any[] {
  if (!live.length) return alt.length ? alt.slice(-CHART_CANDLE_MAX) : [];
  if (!alt.length) return live.slice(-CHART_CANDLE_MAX);
  const byTs = new Map<number, any>();
  for (const c of alt) {
    const t = Number(c?.ts);
    if (!Number.isFinite(t)) continue;
    byTs.set(t, c);
  }
  for (const c of live) {
    const t = Number(c?.ts);
    if (!Number.isFinite(t)) continue;
    byTs.set(t, c);
  }
  return [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts)).slice(-CHART_CANDLE_MAX);
}

/**
 * REST reconcile for candles (does not remount chart; restores visible range).
 * Primary pair is driven by WS `market` pushes — this catches WS stalls / background-tab throttling.
 * Default 8s; set `VITE_CHART_REST_RECONCILE_MS` (ms), clamped 3000–120000.
 */
const CHART_BACKGROUND_SYNC_MS = (() => {
  const raw = Number(import.meta.env.VITE_CHART_REST_RECONCILE_MS);
  if (!Number.isFinite(raw) || raw <= 0) return 8_000;
  return Math.min(120_000, Math.max(3_000, Math.floor(raw)));
})();

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
  /** Server: closed-bar OHLC close at signal (preferred over chart OHLC lookup). */
  signalBarClose?: number | null;
  /** Server: ms when the signal candle closes (open + interval); aligns list time with order/fill window. */
  signalBarCloseTs?: number | null;
  /** Move-quality composite score (0–1) and PASS | BORDER | WEAK. */
  mqScore?: number | null;
  mqVerdict?: string | null;
  /** Full market-decision engine snapshot at this bar (ADX/RSI/EMA, regime, verdict, reasons). */
  marketDecisionSnapshot?: Record<string, unknown> | null;
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
    const mq =
      h.mqScore != null && Number.isFinite(Number(h.mqScore)) ? Number(h.mqScore).toFixed(2) : "—";
    let act = "·";
    if (h.stAction === "TRADE") act = "T";
    else if (h.stAction === "WAIT") act = "W";
    else if (h.stAction === "SKIP") act = "K";
    const tag = m.side === "buy" ? "BUY" : "SELL";
    return `${m.side === "buy" ? "▲" : "▼"}${pair}${tag} AI${ai} SS${ss} SP${sp} MQ${mq} ${act}`;
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

function fmtSigNum(n: unknown, d: number): string {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return Number(n).toFixed(d);
}

/** Min SS threshold when signal-strength gate is on (shown on signal list row). */
function signalListSsGateMin(bot: unknown): number | null {
  const b = bot as { signalStrengthGatesTrades?: boolean; signalStrengthOpenMin?: number } | null | undefined;
  if (!b?.signalStrengthGatesTrades) return null;
  const m = Math.round(Number(b.signalStrengthOpenMin ?? 65));
  return Number.isFinite(m) ? Math.max(0, Math.min(100, m)) : null;
}

/** Min MQ score when move-quality gate is on (shown on signal list row). */
function signalListMqGateMin(bot: unknown): number | null {
  const b = bot as { supertrendMoveQualityGate?: boolean; supertrendMoveQualityMinScore?: number } | null | undefined;
  if (!b?.supertrendMoveQualityGate) return null;
  const m = Number(b.supertrendMoveQualityMinScore ?? 0.6);
  return Number.isFinite(m) ? Math.max(0, Math.min(1, m)) : null;
}

/** Compact bracket from `passThresholds` on the snapshot (market decision layers). */
function signalListMdPassBracketCompact(pt: Record<string, unknown> | null): string | null {
  if (!pt) return null;
  const bits: string[] = [];
  const minC = pt.minRegimeConfidence;
  if (minC != null && Number.isFinite(Number(minC))) bits.push(`conf≥${Math.round(Number(minC))}%`);
  const sc = pt.signalScoreMin;
  if (sc != null && Number.isFinite(Number(sc))) bits.push(`score≥${Number(sc).toFixed(1)}`);
  const fee = pt.feeMinExpectedMovePct;
  if (fee != null && Number.isFinite(Number(fee))) bits.push(`fee≥${Number(fee).toFixed(3)}%`);
  const chopA = pt.chopAdxMin;
  if (chopA != null && Number.isFinite(Number(chopA))) bits.push(`chop ADX≥${Number(chopA).toFixed(0)}`);
  const chopR = pt.chopRangeMin;
  if (chopR != null && Number.isFinite(Number(chopR))) bits.push(`Range≥${(Number(chopR) * 100).toFixed(2)}%`);
  const chopF = pt.chopFlipsMax;
  if (chopF != null && Number.isFinite(Number(chopF))) bits.push(`flips≤${Number(chopF).toFixed(0)}`);
  if (!bits.length) return null;
  return `[${bits.join(" · ")}]`;
}

const MD_PASS_CLS = "text-slate-500 dark:text-slate-400";

/** Filled pill behind verdict chips (accordion stage table + summary). */
function mdStageVerdictBadgeCls(v: string): string {
  const u = String(v).toUpperCase();
  if (u === "ALLOW")
    return "bg-emerald-100 text-emerald-900 ring-1 ring-emerald-500/25 dark:bg-emerald-950/55 dark:text-emerald-200 dark:ring-emerald-400/20";
  if (u === "BLOCK")
    return "bg-rose-100 text-rose-900 ring-1 ring-rose-500/25 dark:bg-rose-950/55 dark:text-rose-200 dark:ring-rose-400/20";
  if (u === "WAIT")
    return "bg-amber-100 text-amber-950 ring-1 ring-amber-500/25 dark:bg-amber-950/50 dark:text-amber-100 dark:ring-amber-400/20";
  return "bg-slate-100 text-slate-700 ring-1 ring-slate-400/20 dark:bg-slate-800/80 dark:text-slate-200 dark:ring-slate-500/25";
}

/** RSI row: composite score gives +weight if this bias holds (bands from engine config / snapshot passThresholds). */
function mdRsiScorePassHint(
  side: "BUY" | "SELL" | null,
  pt?: { scoreRsiLongMin?: number | null; scoreRsiShortMax?: number | null } | null,
): string {
  const lo =
    pt?.scoreRsiLongMin != null && Number.isFinite(Number(pt.scoreRsiLongMin)) ? Number(pt.scoreRsiLongMin) : 52;
  const hi =
    pt?.scoreRsiShortMax != null && Number.isFinite(Number(pt.scoreRsiShortMax)) ? Number(pt.scoreRsiShortMax) : 48;
  if (side === "SELL") return `[score +pts: RSI ≤ ${hi}]`;
  if (side === "BUY") return `[score +pts: RSI ≥ ${lo}]`;
  return `[score +pts: long ≥${lo} · short ≤${hi}]`;
}

/** EMA row: alignment component of composite score. */
function mdEmaAlignPassHint(side: "BUY" | "SELL" | null): string {
  if (side === "BUY") return "[score +pts: close > EMA]";
  if (side === "SELL") return "[score +pts: close < EMA]";
  return "[score +pts: BUY close>EMA · SELL close<EMA]";
}

function mdResolveSignalSide(mds: Record<string, unknown> | null | undefined, h: SupertrendSignalHistRow): "BUY" | "SELL" | null {
  const a = mds?.signalSide != null ? String(mds.signalSide).toUpperCase() : "";
  if (a === "BUY" || a === "SELL") return a;
  const b = h.side != null ? String(h.side).toUpperCase() : "";
  if (b === "BUY" || b === "SELL") return b;
  return null;
}

/** Entry timing: numeric pass band vs current distance (from snapshot metrics). */
function mdEntryTimingPassBracket(et: Record<string, unknown>, pt: Record<string, unknown> | null): string | null {
  const mode = String(et.mode ?? "");
  const m = et.metrics as Record<string, unknown> | undefined;
  const th = m?.threshold;
  const t = typeof th === "number" && Number.isFinite(th) ? th : null;
  const dist = m?.distToEmaPct;
  const distFrac = typeof dist === "number" && Number.isFinite(dist) ? dist : null;
  const cur = distFrac != null ? (distFrac * 100).toFixed(3) : null;
  if (mode === "INSTANT") return "[pass: ENTER immediately — no EMA distance wait]";
  if (mode === "PULLBACK" && t != null) {
    const cap = (t * 100).toFixed(3);
    return `[pass: |close−EMA|/price ≤ ${cap}% — now ${cur != null ? `${cur}%` : "—"}]`;
  }
  if (mode === "BREAKOUT" && t != null) {
    const floor = (t * 0.5 * 100).toFixed(3);
    return `[pass: |close−EMA|/price ≥ ${floor}% — now ${cur != null ? `${cur}%` : "—"}]`;
  }
  if (pt?.entryTimingPassHint) return `[${String(pt.entryTimingPassHint)}]`;
  return null;
}

/** Expanded details under a signal row: SS/MQ + market decision snapshot at bar close. */
function SupertrendSignalAccordionDetails({ h }: { h: SupertrendSignalHistRow }) {
  const mds = h.marketDecisionSnapshot;
  const verdict = displayMarketDecisionVerdict(mds);
  const failedStage = mds && mds.failedStage != null ? String(mds.failedStage) : null;
  const enforcementOff = mdEnforcementOff(mds);
  const reasons = Array.isArray(mds?.reasons) ? (mds.reasons as string[]) : [];
  const ci =
    mds && mds.classifierInputs != null && typeof mds.classifierInputs === "object"
      ? (mds.classifierInputs as Record<string, unknown>)
      : null;
  const regime = mds && mds.regime != null && typeof mds.regime === "object" ? (mds.regime as Record<string, unknown>) : null;
  const ltf = regime?.ltf != null && typeof regime.ltf === "object" ? (regime.ltf as Record<string, unknown>) : null;
  const chop = mds && mds.chop != null && typeof mds.chop === "object" ? (mds.chop as Record<string, unknown>) : null;
  const cg = mds && mds.confidenceGate != null && typeof mds.confidenceGate === "object" ? (mds.confidenceGate as Record<string, unknown>) : null;
  const et = mds && mds.entryTiming != null && typeof mds.entryTiming === "object" ? (mds.entryTiming as Record<string, unknown>) : null;
  const fg = mds && mds.feeGate != null && typeof mds.feeGate === "object" ? (mds.feeGate as Record<string, unknown>) : null;
  const score = mds && mds.score != null && typeof mds.score === "object" ? (mds.score as Record<string, unknown>) : null;
  const breakdown = Array.isArray(score?.breakdown) ? (score.breakdown as Array<Record<string, unknown>>) : [];
  const mdMetrics =
    mds && mds.metrics != null && typeof mds.metrics === "object" ? (mds.metrics as Record<string, unknown>) : null;
  const pipeDiag =
    mds && mds.pipelineDiagnostics != null && typeof mds.pipelineDiagnostics === "object"
      ? (mds.pipelineDiagnostics as {
          primaryStage?: string | null;
          primarySeverity?: string;
          secondary?: Array<{ stage: string; severity: string; detail: string }>;
        })
      : null;
  const pt =
    mds && mds.passThresholds != null && typeof mds.passThresholds === "object"
      ? (mds.passThresholds as Record<string, unknown>)
      : null;
  const chopM =
    chop && chop.metrics != null && typeof chop.metrics === "object"
      ? (chop.metrics as Record<string, unknown>)
      : null;
  const mdSide = mds ? mdResolveSignalSide(mds as Record<string, unknown>, h) : null;
  const entryBracket = et ? mdEntryTimingPassBracket(et as Record<string, unknown>, pt) : null;
  const pxNum = ci?.price != null && Number.isFinite(Number(ci.price)) ? Number(ci.price) : null;
  const emaNum = ci?.ema != null && Number.isFinite(Number(ci.ema)) ? Number(ci.ema) : null;
  const distCloseEmaPct =
    pxNum != null && emaNum != null && pxNum > 0 ? (Math.abs(pxNum - emaNum) / pxNum) * 100 : null;

  return (
    <div className="space-y-2 border-t border-slate-300/40 pt-2 dark:border-slate-600/50">
      <div>
        <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Composite signal strength</div>
        <p className="mt-0.5 text-[10px] text-slate-700 dark:text-slate-300">
          SS {h.strength != null && Number.isFinite(Number(h.strength)) ? Math.round(Number(h.strength)) : "—"} · Action{" "}
          <span className="font-mono">{h.stAction ?? "—"}</span> <span className="text-slate-500">(TRADE / WAIT / SKIP)</span>
        </p>
      </div>
      <div>
        <div className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Move quality</div>
        <p className="mt-0.5 text-[10px] text-slate-700 dark:text-slate-300">
          Score{" "}
          {h.mqScore != null && Number.isFinite(Number(h.mqScore)) ? Number(h.mqScore).toFixed(3) : "—"} · Verdict{" "}
          <span className="font-mono">{h.mqVerdict ?? "—"}</span>
        </p>
      </div>
      {mds ? (
        <div>
          <div className="text-[9px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
            Market decision engine
          </div>
          <div className="mt-1 rounded-md border border-violet-200/80 bg-violet-50/90 px-2.5 py-2 dark:border-violet-800/60 dark:bg-violet-950/40">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] font-bold leading-snug text-slate-900 dark:text-slate-100">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-violet-800/90 dark:text-violet-200/90">Final</span>
              <span
                className={`inline-flex items-center rounded px-2 py-0.5 font-mono text-[11px] font-bold ${mdStageVerdictBadgeCls(String(verdict ?? ""))}`}
              >
                {verdict ?? "—"}
              </span>
              {score != null &&
              typeof score.total === "number" &&
              Number.isFinite(Number(score.total)) &&
              typeof score.threshold === "number" ? (
                <>
                  <span className="font-sans text-[11px] font-bold text-slate-800 dark:text-slate-100">
                    Score{" "}
                    <span className="font-mono text-violet-900 dark:text-violet-100">
                      {Number(score.total).toFixed(1)}
                    </span>
                    <span className="font-normal font-mono text-violet-700/90 dark:text-violet-300/90"> / ≥ {Number(score.threshold).toFixed(1)}</span>
                    {typeof score.max === "number" && Number.isFinite(score.max) ? (
                      <span className="font-normal text-slate-600 dark:text-slate-400"> (max {Number(score.max).toFixed(0)})</span>
                    ) : null}
                  </span>
                </>
              ) : (
                <span className="text-[11px] font-normal text-slate-600 dark:text-slate-400">Composite score off or unavailable</span>
              )}
            </p>
            {enforcementOff ? (
              <p className="mt-1.5 text-[10px] leading-snug text-slate-600 dark:text-slate-400">
                <span className="font-semibold text-slate-700 dark:text-slate-300">Monitoring only.</span> Supertrend{" "}
                <span className="font-mono">Action</span> ({h.stAction ?? "—"}) drives trades; the verdict above is for review if the engine were
                enabled.
              </p>
            ) : null}
            {failedStage && failedStage !== "null" && (verdict === "BLOCK" || verdict === "WAIT") ? (
              <p className="mt-0.5 text-[9px] text-slate-600 dark:text-slate-400">
                Primary stage: <span className="font-mono">{failedStage}</span>
                {pipeDiag?.primarySeverity ? (
                  <span>
                    {" "}
                    · severity <span className="font-mono text-amber-800 dark:text-amber-200">{pipeDiag.primarySeverity}</span>
                  </span>
                ) : null}
              </p>
            ) : null}
            {Array.isArray(mds.stageChecks) && (mds.stageChecks as unknown[]).length > 0 ? (
              <div className="mt-2.5">
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
                  Per-parameter verdicts
                </div>
                <div className="max-h-[min(320px,45vh)] overflow-y-auto rounded-lg border border-slate-200/90 bg-white/90 shadow-sm dark:border-slate-600/55 dark:bg-slate-900/60">
                  <table className="w-full border-collapse text-left text-[10px]">
                    <thead className="sticky top-0 z-[1] border-b border-slate-200/80 bg-slate-100/98 dark:border-slate-600/50 dark:bg-slate-800/98">
                      <tr>
                        <th className="whitespace-nowrap px-2 py-1.5 font-semibold text-slate-700 dark:text-slate-200">Verdict</th>
                        <th className="px-2 py-1.5 font-semibold text-slate-700 dark:text-slate-200">Check</th>
                        <th className="px-2 py-1.5 font-semibold text-slate-700 dark:text-slate-200">Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(mds.stageChecks as Array<{ id: string; label: string; verdict: string; detail: string }>).map((row, ri) => {
                        const vLabel = row.verdict === "N_A" ? "N/A" : row.verdict;
                        const stripe = ri % 2 === 0 ? "bg-white/0 dark:bg-transparent" : "bg-slate-50/90 dark:bg-slate-800/35";
                        return (
                          <tr key={row.id} className={`border-t border-slate-200/50 dark:border-slate-700/45 ${stripe}`}>
                            <td className="whitespace-nowrap px-2 py-1 align-top">
                              <span
                                className={`inline-flex rounded px-1.5 py-0.5 font-mono text-[9px] font-bold ${mdStageVerdictBadgeCls(row.verdict)}`}
                              >
                                {vLabel}
                              </span>
                            </td>
                            <td className="px-2 py-1 align-top font-semibold text-slate-800 dark:text-slate-100">{row.label}</td>
                            <td className="px-2 py-1 align-top leading-snug text-slate-600 dark:text-slate-400">{row.detail}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                Per-parameter rows need snapshot schema v6+ (restart backend after upgrade). Older saved signals show the summary blocks below only.
              </p>
            )}
          </div>
          {reasons.length > 0 ? (
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-[9px] text-slate-600 dark:text-slate-400">
              {reasons.map((r, j) => (
                <li key={j}>{r}</li>
              ))}
            </ul>
          ) : null}
          {mdMetrics?.warmupPartial === true ? (
            <p className="mt-1 text-[9px] text-amber-800/95 dark:text-amber-200/90">
              Warm-up snapshot (short history vs full ADX/EMA pipeline) — hypothetical verdict; filters not applied when the engine master switch is
              off.
            </p>
          ) : null}
          {ltf ? (
            <div className="mt-2 rounded border border-violet-200/50 bg-violet-50/50 px-2 py-1 dark:border-violet-800/40 dark:bg-violet-950/30">
              <div className="text-[9px] font-semibold text-violet-800 dark:text-violet-200">Regime (LTF)</div>
              <p className="mt-0.5 font-mono text-[10px] text-slate-800 dark:text-slate-200">
                {String(ltf.type ?? "—")}
                {chop?.isChoppy === true && String(ltf.type ?? "").toUpperCase() === "UPTREND" ? (
                  <span className="font-sans text-amber-800 dark:text-amber-200"> (weak / choppy)</span>
                ) : null}
                {ltf.confidence != null && Number.isFinite(Number(ltf.confidence))
                  ? ` · conf ${Math.round(Number(ltf.confidence))}%`
                  : ""}
                {pt?.minRegimeConfidence != null && Number.isFinite(Number(pt.minRegimeConfidence)) ? (
                  <span className="text-slate-500"> [pass ≥ {Math.round(Number(pt.minRegimeConfidence))}%]</span>
                ) : null}
              </p>
              {ltf.raw != null && typeof ltf.raw === "object" ? (
                <p className="mt-0.5 text-[9px] text-slate-600 dark:text-slate-400">
                  raw ADX {fmtSigNum((ltf.raw as Record<string, unknown>).adx, 1)}
                  {pt?.chopAdxMin != null && Number.isFinite(Number(pt.chopAdxMin)) ? (
                    <span className="text-slate-500"> [pass: ADX ≥ {fmtSigNum(pt.chopAdxMin, 0)}]</span>
                  ) : null}{" "}
                  · ATR/price{" "}
                  {fmtSigNum(
                    ((ltf.raw as Record<string, unknown>).atrRatio as number) != null
                      ? Number((ltf.raw as Record<string, unknown>).atrRatio) * 100
                      : null,
                    2,
                  )}
                  %
                  {pt?.atrVolThreshold != null && Number.isFinite(Number(pt.atrVolThreshold)) ? (
                    <span className="text-slate-500">
                      {" "}
                      [VOLATILE if ATR/price {'>'} {(Number(pt.atrVolThreshold) * 100).toFixed(2)}%]
                    </span>
                  ) : null}
                </p>
              ) : null}
            </div>
          ) : null}
          {ci ? (
            <div className="mt-2 space-y-1">
              <div className="text-[9px] font-semibold text-slate-500 dark:text-slate-400">
                Classifier inputs — values vs pass rules
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-0.5 font-mono text-[9px] text-slate-700 dark:text-slate-300 sm:grid-cols-3">
                <span>
                  ADX(14) {fmtSigNum(ci.adx, 1)}
                  {pt?.chopAdxMin != null && Number.isFinite(Number(pt.chopAdxMin)) ? (
                    <span className={MD_PASS_CLS}>
                      {" "}
                      [chop: need ADX ≥ {fmtSigNum(pt.chopAdxMin, 0)} to avoid weak-ADX chop flag]
                    </span>
                  ) : (
                    <span className={MD_PASS_CLS}> [regime input — chop threshold N/A]</span>
                  )}
                </span>
                <span>
                  RSI(14) {fmtSigNum(ci.rsi, 1)}{" "}
                  <span className={MD_PASS_CLS}>{mdRsiScorePassHint(mdSide, pt)}</span>
                </span>
                <span>
                  EMA({String(ci.emaLength ?? "—")}) {fmtSigNum(ci.ema, 4)}{" "}
                  <span className={MD_PASS_CLS}>{mdEmaAlignPassHint(mdSide)}</span>
                </span>
                <span>
                  ATR(14) {fmtSigNum(ci.atr, 6)}
                  <span className={MD_PASS_CLS}>
                    {" "}
                    [used as ATR/price → %ATR row; pullback band = ATR%×mult]
                  </span>
                </span>
                <span>
                  %ATR{" "}
                  {ci.atrPct != null && Number.isFinite(Number(ci.atrPct))
                    ? `${(Number(ci.atrPct) * 100).toFixed(2)}%`
                    : "—"}
                  {pt?.atrVolThreshold != null && Number.isFinite(Number(pt.atrVolThreshold)) ? (
                    <span className={MD_PASS_CLS}>
                      {" "}
                      [regime: classify VOLATILE if %ATR &gt; {(Number(pt.atrVolThreshold) * 100).toFixed(2)}%]
                    </span>
                  ) : (
                    <span className={MD_PASS_CLS}> [VOLATILE threshold N/A]</span>
                  )}
                </span>
                <span>
                  Close {fmtSigNum(ci.price, 4)}
                  {distCloseEmaPct != null ? (
                    <span className={MD_PASS_CLS}> [|close−EMA|/price {distCloseEmaPct.toFixed(3)}% — compare to entry band below]</span>
                  ) : null}
                </span>
                <span className="col-span-2 sm:col-span-3">
                  Range₁₀{" "}
                  {ci.rangeCompression != null && Number.isFinite(Number(ci.rangeCompression))
                    ? `${(Number(ci.rangeCompression) * 100).toFixed(2)}%`
                    : "—"}
                  {pt?.chopRangeMin != null && Number.isFinite(Number(pt.chopRangeMin)) ? (
                    <span className={MD_PASS_CLS}>
                      {" "}
                      [chop: need Range₁₀ ≥ {(Number(pt.chopRangeMin) * 100).toFixed(2)}% to avoid tight-range chop flag]
                    </span>
                  ) : (
                    <span className={MD_PASS_CLS}> [chop range threshold N/A]</span>
                  )}{" "}
                  · ΔEMA/bar {fmtSigNum(ci.emaSlope, 6)}
                  <span className={MD_PASS_CLS}> [regime trend uses slope vs price — no single pass #]</span>
                </span>
              </div>
            </div>
          ) : null}
          {chop && (chop.isChoppy === true || (Array.isArray(chop.reasons) && (chop.reasons as unknown[]).length > 0)) ? (
            <div className="mt-1.5 space-y-0.5 text-[9px] text-slate-600 dark:text-slate-400">
              <div>
                Chop: {String(chop.isChoppy)}
                {chop.isChoppy === true ? " · trend can still be up/down while chop flags messy microstructure" : ""}
                {chopM?.flips != null && Number.isFinite(Number(chopM.flips)) ? ` · flips ${fmtSigNum(chopM.flips, 0)}` : ""}
                {pt?.chopFlipsMax != null && Number.isFinite(Number(pt.chopFlipsMax)) ? (
                  <span className={MD_PASS_CLS}> [pass: flips ≤ {fmtSigNum(pt.chopFlipsMax, 0)}]</span>
                ) : null}
                {" · "}
                {(chop.reasons as string[])?.join(" · ") || "—"}
              </div>
              {pt?.chopAdxMin != null ||
              pt?.chopRangeMin != null ||
              pt?.chopFlipsMax != null ? (
                <div className={MD_PASS_CLS}>
                  To clear chop (when chop gate is on): ADX ≥ {pt?.chopAdxMin != null ? fmtSigNum(pt.chopAdxMin, 0) : "—"} · Range₁₀ ≥
                  {pt?.chopRangeMin != null ? ` ${(Number(pt.chopRangeMin) * 100).toFixed(2)}%` : " —"} · flips ≤
                  {pt?.chopFlipsMax != null ? ` ${fmtSigNum(pt.chopFlipsMax, 0)}` : " —"}
                </div>
              ) : null}
            </div>
          ) : null}
          {cg ? (
            <div className="mt-1 space-y-0.5 text-[9px] text-slate-600 dark:text-slate-400">
              <div>
                Regime confidence: {fmtSigNum(cg.regimeConfidence, 0)}% vs min {fmtSigNum(cg.minRequired, 0)}%
                <span className={MD_PASS_CLS}>
                  {" "}
                  [pass: confidence ≥ {fmtSigNum(cg.minRequired, 0)}% — {cg.mode === "BLOCK" ? "below blocks" : "below adds penalty"}]
                </span>{" "}
                ·{" "}
                {cg.passed === true ? (
                  <span className="text-emerald-700 dark:text-emerald-300">meets threshold</span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-300">below min</span>
                )}
                {enforcementOff ? <span className="text-slate-500"> (not enforced — engine off)</span> : null}
              </div>
              <div>
                Confidence mode: <span className="font-mono">{String(cg.mode)}</span>
              </div>
              <div>
                Status:{" "}
                {cg.passed === true ? (
                  <span className="text-emerald-700 dark:text-emerald-300">PASS</span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-300">below min</span>
                )}
                {cg.mode === "PENALTY" && cg.passed === true ? (
                  <span className="text-slate-500"> (no confidence penalty to score)</span>
                ) : null}
                {cg.mode === "PENALTY" && cg.passed === false ? (
                  <span className="text-slate-500"> (score penalty applies when engine is on)</span>
                ) : null}
                {cg.mode === "BLOCK" ? (
                  <span className="text-slate-500"> — below min blocks when engine is on</span>
                ) : null}
              </div>
            </div>
          ) : null}
          {et ? (
            <div className="mt-1 text-[9px] text-slate-600 dark:text-slate-400">
              Entry timing: <span className="font-mono">{String(et.recommendation ?? "—")}</span> · mode{" "}
              <span className="font-mono">{String(et.mode ?? "—")}</span>
              {entryBracket ? <span className={MD_PASS_CLS}> {entryBracket}</span> : null}
              {enforcementOff ? <span className="text-slate-500"> — not enforced (engine off)</span> : null}
              {et.reasons != null && Array.isArray(et.reasons) && (et.reasons as string[]).length ? (
                <span> — {(et.reasons as string[]).join("; ")}</span>
              ) : null}
            </div>
          ) : null}
          {pt?.directionPassHint ? (
            <div className="mt-1 text-[9px] text-slate-600 dark:text-slate-400">
              Direction vs regime: <span className="text-slate-500">[{String(pt.directionPassHint)}]</span>
            </div>
          ) : null}
          {fg ? (
            <div className="mt-1 space-y-0.5 text-[9px] text-slate-600 dark:text-slate-400">
              <div>
                Fee gate{fg.enabled === false ? " (disabled in settings)" : ""}:{" "}
                {fg.passed === true ? (
                  <span className="text-emerald-700 dark:text-emerald-300">PASS</span>
                ) : (
                  <span className="text-amber-700 dark:text-amber-300">FAIL</span>
                )}
                {enforcementOff ? <span className="text-slate-500"> — not enforced (engine off)</span> : null}
              </div>
              <div className="font-mono text-[9px]">
                Expected move:{" "}
                {fg.expectedMovePct != null && Number.isFinite(Number(fg.expectedMovePct))
                  ? `${Number(fg.expectedMovePct).toFixed(3)}%`
                  : "—"}
                {pt?.feeMinExpectedMovePct != null && Number.isFinite(Number(pt.feeMinExpectedMovePct)) ? (
                  <span className={MD_PASS_CLS}>
                    {" "}
                    [pass: expected move ≥ {Number(pt.feeMinExpectedMovePct).toFixed(3)}% (= required line below when gate on)]
                  </span>
                ) : null}{" "}
                · Required (fees + buffer + slippage):{" "}
                {fg.requiredMovePct != null && Number.isFinite(Number(fg.requiredMovePct))
                  ? `${Number(fg.requiredMovePct).toFixed(3)}%`
                  : "—"}
                {fg.requiredMovePct != null && Number.isFinite(Number(fg.requiredMovePct)) ? (
                  <span className={MD_PASS_CLS}>
                    {" "}
                    [hurdle: favorable move must cover ≥ this %]
                  </span>
                ) : null}
              </div>
              {Array.isArray(fg.reasons) && (fg.reasons as string[]).length > 0 ? (
                <div className="text-[8px] text-slate-500 dark:text-slate-500">{(fg.reasons as string[]).join(" · ")}</div>
              ) : null}
            </div>
          ) : null}
          {breakdown.length > 0 ? (
            <div className="mt-2">
              <div className="text-[9px] font-semibold text-slate-500 dark:text-slate-400">Score breakdown</div>
              <ul className="mt-0.5 space-y-0.5 text-[9px] text-slate-600 dark:text-slate-400">
                {breakdown.map((b, k) => {
                  const bid = String(b.id ?? "");
                  let hint = "";
                  if (bid === "st") hint = "[+w if ST confirms at bar]";
                  else if (bid === "ema") hint = mdEmaAlignPassHint(mdSide);
                  else if (bid === "rsi") hint = mdRsiScorePassHint(mdSide, pt);
                  else if (bid === "htf") hint = "[+w if HTF trend matches LTF]";
                  else if (bid === "conf") hint = "[− penalty if conf < min]";
                  else if (bid === "weak") hint = "[− penalty in weak trend]";
                  else if (bid === "over") hint = "[− penalty if overextended]";
                  else if (bid === "chop_soft") hint = "[− penalty if chop (soft)]";
                  else if (bid === "dir") hint = "[− penalty if direction vs regime]";
                  else if (bid === "btc") hint = "[− penalty: BTC filter]";
                  return (
                    <li key={k}>
                      {String(b.label ?? b.id)}: +{fmtSigNum(b.contribution, 1)} / w {fmtSigNum(b.weight, 0)}{" "}
                      {hint ? <span className={MD_PASS_CLS}>{hint}</span> : null}
                    </li>
                  );
                })}
              </ul>
              <p className="mt-0.5 text-[9px] font-mono text-slate-700 dark:text-slate-300">
                Total {fmtSigNum(score?.total, 1)} / threshold {fmtSigNum(score?.threshold, 1)}
                {pt?.signalScoreMin != null && Number.isFinite(Number(pt.signalScoreMin)) ? (
                  <span className="text-slate-500"> [pass: total ≥ {fmtSigNum(pt.signalScoreMin, 1)}]</span>
                ) : null}{" "}
                · {String(score?.passed ?? "")}
              </p>
              {score && score.passed === false && score.failKind === "htf_match" ? (
                <p className="mt-0.5 text-[9px] text-amber-800 dark:text-amber-200">
                  Total meets the numeric threshold, but the HTF layer is on — higher timeframe must align with LTF for a pass.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p className="text-[9px] text-slate-500 dark:text-slate-500">
          No market decision snapshot on this row (server build before persistence, or snapshot failed). New signals include full ADX/RSI/EMA
          + verdict.
        </p>
      )}
    </div>
  );
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

type ChartStTrailPreviewLine = {
  px: number;
  title: string;
  kind:
    | "st_activation"
    | "st_trail"
    | "fee_trail"
    | "trail_tier_activated"
    | "trail_tier_next"
    | "trail_tier_lock"
    | "trail_tier_activation"
    | "st_tier_activation";
  /** T0, T1, T2 … label for left-side overlay */
  tierLabel?: string;
  /** Optional per-line color override (e.g. next tier palette). */
  color?: string;
};

/** Live “mark past activation” vs server-persisted trail step (≥1 SL trail update). */
type ChartTrailingBadge = {
  trailing: boolean;
  trailed: boolean;
  tierLabel?: string | null;
  /** SL replace sent; exchange not yet verified — show waiting UI, do not treat as trailed. */
  trailExchangePending?: boolean;
};

type ChartTrailHud = {
  currentSl: number | null;
  takeProfit: number | null;
  nextActivationPx: number | null;
  nextTierLabel: string | null;
  liveTrailSlPx: number | null;
  /** When present (fee ladder), show the current trailed tier and the next two lock points. */
  currentTrailedTierLabel?: string | null;
  /** Next two upcoming tiers: discrete lock (SL level) and activation (mark must cross to arm that tier). */
  nextTwoTierLocks?: { tierLabel: string; lockPx: number; activationPx: number }[];
};

type ChartTrailingPreview = {
  key: string;
  lines: ChartStTrailPreviewLine[];
  badge: ChartTrailingBadge | null;
  trailHud?: ChartTrailHud | null;
};

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

type HorzBracketLineSpec = { px: number; title: string; color: string; lineStyle?: number };

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
      // Prefer solid if any merged spec wants solid.
      if (hit.lineStyle == null) hit.lineStyle = L.lineStyle;
      if (hit.lineStyle === LineStyle.Dashed && L.lineStyle != null && L.lineStyle !== LineStyle.Dashed) hit.lineStyle = L.lineStyle;
    } else {
      out.push({ px: L.px, title: L.title.trim(), color: L.color, lineStyle: L.lineStyle });
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
  const tierTag = badge?.tierLabel != null && String(badge.tierLabel).trim() !== "" ? String(badge.tierLabel) : null;
  const slTitle =
    slPx == null
      ? "SL"
      : slUseTrailAmber && tierTag
        ? `SL (${tierTag} trail)`
        : slUseTrailAmber
          ? "SL trail"
          : "SL (default)";
  const bracketSpecs: HorzBracketLineSpec[] = [];
  if (slPx != null) {
    bracketSpecs.push({ px: slPx, title: slTitle, color: slLineCol, lineStyle: LineStyle.Dashed });
  }
  if (tpPx != null) {
    bracketSpecs.push({ px: tpPx, title: "TP", color: tpCol, lineStyle: LineStyle.Dashed });
  }
  for (const ln of trailLines) {
    if (!Number.isFinite(ln.px) || ln.px <= 0) continue;
    const colOverride = ln.color != null && String(ln.color).trim() ? String(ln.color) : null;
    let col: string;
    if (colOverride) {
      col = colOverride;
    } else if (ln.kind === "st_activation" || ln.kind === "st_tier_activation") {
      col = amberTrailSoft;
    } else if (ln.kind === "trail_tier_activated" || ln.kind === "trail_tier_lock") {
      // Already-crossed tiers — show as muted green to distinguish from active SL
      col = isDark ? "#6ee7b7" : "#059669";
    } else if (ln.kind === "trail_tier_next") {
      // Next target tier — amber target
      col = amberTrailSoft;
    } else {
      col = amberTrail;
    }
    const ls =
      ln.kind === "st_activation" ||
      ln.kind === "st_tier_activation" ||
      ln.kind === "trail_tier_activation"
        ? LineStyle.Dashed
        : LineStyle.Solid;
    bracketSpecs.push({ px: ln.px, title: ln.title, color: col, lineStyle: ls });
  }
  return mergeBracketLineSpecsByPrice(bracketSpecs);
}

function parseTierIndexFromTrailLine(l: ChartStTrailPreviewLine): number {
  const fromLabel = String(l.tierLabel ?? "").match(/^T(\d+)/i);
  if (fromLabel) return Number(fromLabel[1]);
  const fromTitle = String(l.title ?? "").match(/\bT(\d+)\b/i);
  if (fromTitle) return Number(fromTitle[1]);
  if (l.kind === "st_activation") return 0;
  return 999;
}

function isForwardSlTnLockKind(k: ChartStTrailPreviewLine["kind"]): boolean {
  return (
    k === "trail_tier_next" ||
    k === "trail_tier_lock" ||
    k === "st_tier_activation" ||
    k === "st_activation"
  );
}

/**
 * Lower-right chart legend: exactly three rows for upcoming SL tier locks (Tn), fixed layout.
 * Pads with placeholders when fewer than three forward tiers exist (e.g. fee ladder).
 */
function pickNextThreeSlTnLockLegendRows(
  trailLines: ChartStTrailPreviewLine[],
  isDark: boolean,
): HorzBracketLineSpec[] {
  const amberSoft = isDark ? "#fbbf24" : "#f59e0b";
  const greenLock = isDark ? "#6ee7b7" : "#059669";
  const muted = isDark ? "#64748b" : "#94a3b8";

  const forward = trailLines.filter((l) => isForwardSlTnLockKind(l.kind));
  const byTier = new Map<number, ChartStTrailPreviewLine>();
  for (const l of forward) {
    const ti = parseTierIndexFromTrailLine(l);
    const prev = byTier.get(ti);
    if (!prev) {
      byTier.set(ti, l);
      continue;
    }
    const rank = (k: ChartStTrailPreviewLine["kind"]) =>
      k === "trail_tier_next" ? 4 : k === "st_tier_activation" ? 3 : k === "trail_tier_lock" ? 2 : 1;
    if (rank(l.kind) > rank(prev.kind)) byTier.set(ti, l);
  }
  const sorted = [...byTier.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);

  const picked = sorted.slice(0, 3);
  const out: HorzBracketLineSpec[] = [];
  for (let i = 0; i < 3; i++) {
    const L = picked[i];
    if (!L) {
      out.push({ px: -1, title: "—", color: muted });
      continue;
    }
    const col = L.kind === "trail_tier_lock" ? greenLock : amberSoft;
    let shortTitle: string;
    if (L.kind === "trail_tier_lock" && L.tierLabel) shortTitle = `${L.tierLabel} lock`;
    else if (L.kind === "st_tier_activation" && L.tierLabel) shortTitle = `ST gate · ${L.tierLabel} lock`;
    else if (L.kind === "trail_tier_next" && L.tierLabel) shortTitle = `Next ${L.tierLabel} lock`;
    else if (L.kind === "st_activation") shortTitle = "ST activation";
    else shortTitle = L.tierLabel ? `Next ${L.tierLabel} lock` : L.title;
    out.push({ px: L.px, title: shortTitle, color: col });
  }
  return out;
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

function metaTrailTrailedFromPosition(pos: Record<string, unknown>): { trailed: boolean; tierLabel: string | null } {
  const meta = (pos.meta || {}) as Record<string, unknown>;
  const ts = Number(meta.trailStep);
  const trailed = Number.isFinite(ts) && Math.floor(ts) >= 1;
  /** Prefer server-side label; fall back to computing T{trailStep-1}. */
  const labelStyle =
    meta.trailStepLabelStyle === "tiered_st_fee_entry" || Number(meta.trailTierSchemaVersion) >= 2
      ? ("tiered_st_fee_entry" as const)
      : ("classic" as const);
  const rawLabel =
    pos.trailTierLabel ??
    meta.trailTierLabel ??
    (trailed ? trailStepToTierLabel(Math.floor(ts), labelStyle) : null);
  const tierLabel = rawLabel != null ? String(rawLabel) : null;
  return { trailed, tierLabel };
}

/** Initial horizontal zoom window (seconds of bar time). */
const INITIAL_VISIBLE_RANGE_SEC = 3600;
/**
 * Right-side gap before the price scale: empty logical bar slots ≈ this fraction of one hour’s bar count
 * (matches TradingView-style padding; see `timeScale.rightOffset`).
 */
const INITIAL_RIGHT_MARGIN_BAR_FRAC = 0.3;

function initialRightOffsetBars(tf: string | undefined | null): number {
  const ms = binanceIntervalMs(tf ?? "1m");
  const sec = Math.max(1, Math.round(ms / 1000));
  const barsInHour = Math.max(1, Math.round(INITIAL_VISIBLE_RANGE_SEC / sec));
  return Math.max(1, Math.round(INITIAL_RIGHT_MARGIN_BAR_FRAC * barsInHour));
}

function tryApplyAutoFit(
  chart: IChartApi | null,
  ohlcLen: number,
  pendingAutoFit: { current: boolean },
  fitAfterRest: { current: boolean },
  skipUntilBulk: { current: boolean },
  lastBarTimeSec?: number | null,
  timeframe?: string | null,
) {
  const canFit = !skipUntilBulk.current || fitAfterRest.current || ohlcLen >= 20;
  const shouldFit = pendingAutoFit.current && canFit && ohlcLen > 0;
  if (!shouldFit || !chart) return;
  try {
    const anchorSec =
      lastBarTimeSec != null && Number.isFinite(Number(lastBarTimeSec)) && Number(lastBarTimeSec) > 0
        ? Math.floor(Number(lastBarTimeSec))
        : Math.floor(Date.now() / 1000);
    const fromSec = anchorSec - INITIAL_VISIBLE_RANGE_SEC;
    const toSec = anchorSec;
    chart.timeScale().applyOptions({ rightOffset: initialRightOffsetBars(timeframe) });
    chart.timeScale().setVisibleRange({ from: fromSec as Time, to: toSec as Time });
  } catch {
    // Fall back to full fit if the time range is not available in the loaded data
    try {
      chart.timeScale().fitContent();
    } catch {
      /* ignore */
    }
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
  /** Tier line specs (label + price) for left-side overlay labels; updated when chartTrailingPreview changes. */
  const tierLinePricesRef = useRef<{ label: string; px: number }[]>([]);
  /** Y-coordinate positions (in pixels) for the tier label overlay; recomputed on chart pan/zoom. */
  const [tierLabelPositions, setTierLabelPositions] = useState<{ label: string; y: number }[]>([]);

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
  /** One expanded row at a time in the signal list under the chart. */
  const [openSignalAccordionKey, setOpenSignalAccordionKey] = useState<string | null>(null);

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

  /**
   * Only use Zustand `candles` when they belong to the chart’s symbol (see `mergeMarketIntoState`).
   * Without this, switching multi-coin tab back to primary left `candles` on the old pair while
   * `isAltChartView` became false → `buildOhlc` mixed wrong OHLC with the new symbol and broke the chart.
   */
  const chartSymNorm = useMemo(() => normalizeSym(effectiveSym), [effectiveSym]);
  const marketSymNorm = useMemo(() => normalizeSym(market?.symbol), [market?.symbol]);
  const wsStoreAligned = Boolean(chartSymNorm && candles.length && marketSymNorm === chartSymNorm);

  const baseCandles = useMemo(() => {
    if (isAltChartView) {
      if (wsStoreAligned && candles.length > 0) {
        return mergeAltRestWithLiveWs(altCandles, candles);
      }
      if (altCandles.length) return altCandles;
      return candles;
    }
    if (wsStoreAligned) return candles;
    if (chartSymNorm && marketSymNorm && marketSymNorm !== chartSymNorm) return [];
    return candles;
  }, [isAltChartView, wsStoreAligned, candles, altCandles, chartSymNorm, marketSymNorm]);

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
    const symCh = normalizeSymTf(effectiveSym) || "";
    const tfCh = normalizeSymTf(bot?.timeframe) || "";
    const detail: ClientSupertrendChimeDetail = {
      side: last.side,
      barTimeSec: Number(last.time),
      symbol: symCh,
      timeframe: tfCh,
    };
    window.dispatchEvent(new CustomEvent(CLIENT_SUPERTREND_CHIME_EVENT, { detail }));
  }, [safeMarkers, supertrendSoundCtx, effectiveSym, bot?.timeframe]);

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

    // Recompute tier label y-positions when the user pans or zooms the chart
    function refreshTierLabelPositions() {
      const specs = tierLinePricesRef.current;
      if (!specs.length) return;
      const positions = specs
        .map((s) => {
          try {
            const y = series.priceToCoordinate(s.px);
            return y != null ? { label: s.label, y } : null;
          } catch {
            return null;
          }
        })
        .filter((x): x is { label: string; y: number } => x != null);
      setTierLabelPositions(positions);
    }

    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshTierLabelPositions);

    if (cur.length) {
      try {
        const st = useAppStore.getState();
        const sym0 = canonicalChartSymbol(st.chartDisplaySymbol ?? st.bot?.symbol);
        const filtered = cur.filter((bar, i) => isOhlcBarRenderable(bar, i > 0 ? cur[i - 1]! : null, sym0));
        if (filtered.length) {
          series.setData(filtered);
          chartOhlcAppliedRef.current = filtered.slice();
          const lastSec =
            filtered.length > 0 ? Number(filtered[filtered.length - 1]!.time) : undefined;
          const tfInit = normalizeSymTf(useAppStore.getState().bot?.timeframe);
          tryApplyAutoFit(
            chart,
            filtered.length,
            pendingAutoFitRef,
            fitAfterRestSnapshotRef,
            skipFitUntilBulkRef,
            lastSec,
            tfInit || null,
          );
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
      tierLinePricesRef.current = [];
      setTierLabelPositions([]);
      try {
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshTierLabelPositions);
      } catch {
        /* ignore */
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
      trailHud: null,
    });
    if (bot?.trailingStopLossAuto !== true) return none("trail-off");
    if (!inferFuturesBracketLinesActive(bot)) return none("trail-venue");

    const pos = pickChartFuturesPositionRow(positions, effectiveSym, isMultiCoinMode, bot);
    if (!pos) return none("trail-nopos");
    const q = Number(pos.qty ?? pos.positionAmt);
    if (!Number.isFinite(q) || Math.abs(q) <= 1e-8) return none("trail-flat");
    const isLong = futuresPositionIsLong(pos as Record<string, unknown>);
    const { trailed: trailedPersist, tierLabel: trailedTierLabel } = metaTrailTrailedFromPosition(pos);
    const trailSlConfirm = (pos.meta as Record<string, unknown> | undefined)?.trailSlConfirm as
      | { status?: string }
      | undefined;
    const trailExchangePending = trailSlConfirm?.status === "REQUESTED";
    const mkBadge = (trailing: boolean): ChartTrailingBadge => ({
      trailing,
      trailed: trailedPersist && !trailExchangePending,
      tierLabel: trailedTierLabel,
      trailExchangePending,
    });
    const ladderSnap = (pos.meta as Record<string, unknown> | undefined)?.trailLadderSnapshotV1 as
      | {
          entryPx?: number;
          feeBeSt?: number;
          buf?: number;
          postT02SpacingFrac?: number | null;
          roundTripFeeR?: number;
        }
      | undefined;
    const useFrozenLadder =
      ladderSnap != null &&
      Number.isFinite(Number(ladderSnap.entryPx)) &&
      Number(ladderSnap.entryPx) > 0;
    const entry = useFrozenLadder ? Number(ladderSnap.entryPx) : Number(pos.entryPrice);
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
    const openFeeR = Number.isFinite(Number(bot?.trailOpenFeeRate)) && Number(bot?.trailOpenFeeRate) > 0
      ? Number(bot.trailOpenFeeRate) : feeR;
    const closeFeeR = Number.isFinite(Number(bot?.trailCloseFeeRate)) && Number(bot?.trailCloseFeeRate) > 0
      ? Number(bot.trailCloseFeeRate) : feeR;
    const feeBeMultiplierChart = Number.isFinite(Number(bot?.trailFeeBeMultiplier)) && Number(bot?.trailFeeBeMultiplier) >= 1
      ? Number(bot.trailFeeBeMultiplier)
      : DEFAULT_TRAIL_FEE_BE_MULTIPLIER;
    const bufferRate = Number.isFinite(Number(bot?.trailBufferRate)) && Number(bot?.trailBufferRate) >= 0
      ? Number(bot.trailBufferRate) : 0.0005;
    const slipFracChart = Math.max(0, Math.min(0.01, Number(bot?.trailActivationSlippageFrac ?? 0)));
    const t01LockSlipChart = Math.max(0, Math.min(0.01, Number(bot?.trailT01LockSlippageFrac ?? 0)));
    const atrPctChart = Number(
      bot && typeof bot === "object" && (bot as { lastRegime?: { atrPct?: number } }).lastRegime?.atrPct,
    );
    const bufEffective = computeEffectiveTrailBuffer({
      bufferRate,
      trailBufferMode:
        bot && typeof bot === "object"
          ? (bot as { trailBufferMode?: string }).trailBufferMode
          : undefined,
      trailBufferAtrMult: bot?.trailBufferAtrMult,
      atrPct: atrPctChart,
    });
    const maintenanceMarginRate = Number.isFinite(Number(bot?.trailMaintMarginRate)) && Number(bot?.trailMaintMarginRate) >= 0
      ? Number(bot.trailMaintMarginRate) : 0.005;

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
        activationBufferRate: bufEffective,
        feeRate: feeR,
        openFeeRate: openFeeR,
        closeFeeRate: closeFeeR,
        feeBeMultiplier: feeBeMultiplierChart,
        extraScalpingPctsOfEntry: extras,
      });

      if (adv.advanced && adv.proposedSl != null && Number.isFinite(adv.proposedSl)) {
        const merged = mergeStopWithTrail(isLong, prevSlForCompute, adv.proposedSl);
        if (merged != null && Number.isFinite(merged) && merged > 0) displayPx = merged;
      }
      if (displayPx == null) {
        const levels = buildTrailLockPrices(entry, isLong, feeR, extras, {
          openFeeRate: openFeeR, closeFeeRate: closeFeeR, feeBeMultiplier: feeBeMultiplierChart,
        });
        const next = levels[adv.trailStep];
        if (next && Number.isFinite(next.lockPx) && next.lockPx > 0) displayPx = next.lockPx;
      }
      const feeTrailingLive = adv.trailStep >= 1;

      // Build all tier lock prices to show tier history lines (last 3 activated + next target)
      const allLevels = buildTrailLockPrices(entry, isLong, feeR, extras, {
        openFeeRate: openFeeR,
        closeFeeRate: closeFeeR,
        feeBeMultiplier: feeBeMultiplierChart,
      });
      const nextPalette = chartTheme === "dark"
        ? ["#fbbf24", "#a78bfa", "#34d399"]
        : ["#f59e0b", "#7c3aed", "#059669"];

      const tierLines: ChartStTrailPreviewLine[] = [];
      const currentStep = adv.trailStep;

      // Activated tiers: show last 3 crossed (from defined levels + continuation labels)
      const activatedIndices: number[] = [];
      for (let i = 0; i < currentStep; i++) activatedIndices.push(i);
      const lastThreeActivated = activatedIndices.slice(-3);
      for (const idx of lastThreeActivated) {
        const L = allLevels[idx]; // undefined for continuation tiers beyond defined levels
        // For continuation tiers, compute lock price from last interval
        let lPx: number | null = null;
        let tl = `T${idx}`;
        if (L && Number.isFinite(L.lockPx) && L.lockPx > 0) {
          lPx = L.lockPx;
          tl = L.tierLabel ?? tl;
        } else if (allLevels.length > 0) {
          // Continuation tier: extrapolate from last defined level
          const lastDef = allLevels[allLevels.length - 1]!;
          const interval =
            allLevels.length >= 2
              ? Math.abs(allLevels[allLevels.length - 1]!.lockPx - allLevels[allLevels.length - 2]!.lockPx)
              : Math.max(lastDef.lockPx * 0.001, Math.abs(lastDef.lockPx - entry));
          if (interval > 0) {
            const contSteps = idx - (allLevels.length - 1);
            lPx = isLong ? lastDef.lockPx + contSteps * interval : lastDef.lockPx - contSteps * interval;
          }
        }
        if (lPx == null || !Number.isFinite(lPx) || lPx <= 0) continue;
        if (!futuresBracketLevelSane(symPlausible, lPx, ohlcLastClose)) continue;
        if (slDup(lPx)) continue;
        tierLines.push({ px: lPx, title: `SL trail ${tl}`, kind: "trail_tier_activated", tierLabel: tl });
      }

      // Next target tier: defined level if available, otherwise computed continuation
      {
        const nextDefined = allLevels[currentStep];
        let nextPx: number | null = null;
        let nextTl = `T${currentStep}`;
        if (nextDefined && Number.isFinite(nextDefined.lockPx) && nextDefined.lockPx > 0) {
          nextPx = nextDefined.lockPx;
          nextTl = nextDefined.tierLabel ?? nextTl;
        } else if (allLevels.length > 0) {
          // Continuation tier
          const lastDef = allLevels[allLevels.length - 1]!;
          const interval =
            allLevels.length >= 2
              ? Math.abs(allLevels[allLevels.length - 1]!.lockPx - allLevels[allLevels.length - 2]!.lockPx)
              : Math.max(lastDef.lockPx * 0.001, Math.abs(lastDef.lockPx - entry));
          if (interval > 0) {
            const contSteps = currentStep - (allLevels.length - 1);
            nextPx = isLong ? lastDef.lockPx + contSteps * interval : lastDef.lockPx - contSteps * interval;
          }
        }
        if (
          nextPx != null &&
          Number.isFinite(nextPx) &&
          nextPx > 0 &&
          !slDup(nextPx) &&
          futuresBracketLevelSane(symPlausible, nextPx, ohlcLastClose) &&
          !tierLines.some((l) => nearlySameTrailPx(l.px, nextPx!))
        ) {
          tierLines.push({ px: nextPx, title: `Next trail ${nextTl}`, kind: "trail_tier_next", tierLabel: nextTl });
        }
      }

      if (displayPx == null || !Number.isFinite(displayPx) || displayPx <= 0) {
        if (tierLines.length > 0) {
          const tierKey = tierLines.map((l) => l.px.toFixed(6)).join("|");
          return { key: `trail-FEE-tiers-${tierKey}|${symKey}`, lines: tierLines, badge: mkBadge(feeTrailingLive), trailHud: null };
        }
        return none("trail-nodisp", mkBadge(feeTrailingLive));
      }
      if (!futuresBracketLevelSane(symPlausible, displayPx, ohlcLastClose)) {
        return none("trail-insane", mkBadge(feeTrailingLive));
      }
      // Merge current displayPx into lines if not already captured as a tier
      const primaryLine: ChartStTrailPreviewLine = { px: displayPx, title: "Fee trail", kind: "fee_trail" };
      const allTierLines = tierLines.some((l) => nearlySameTrailPx(l.px, displayPx))
        ? tierLines
        : [...tierLines, primaryLine];

      // Fee ladder HUD: show current trailed tier, next activation, and the next two tier locks.
      const locksReachedBySl =
        allLevels.length > 0 && Number.isFinite(prevSlForCompute) && prevSlForCompute > 0
          ? trailLadderConsecutiveLocksReached(allLevels, prevSlForCompute, isLong)
          : 0;
      const uiTrailedStep = Math.min(step0, locksReachedBySl);
      const currentTrailedTierLabel = uiTrailedStep >= 1 ? `T${uiTrailedStep - 1}` : null;
      const nextIdx = Math.max(0, uiTrailedStep);
      const nextLockPx = extrapolateTrailTierLockPx(allLevels, nextIdx, isLong, entry);
      const nextActivationPx =
        nextLockPx != null && Number.isFinite(nextLockPx)
          ? isLong
            ? nextLockPx * (1 + bufEffective)
            : nextLockPx * (1 - bufEffective)
          : null;
      const nextTierLabel = tierLabelForTrailIndex(allLevels, nextIdx);
      const nextTwoTierLocks: { tierLabel: string; lockPx: number; activationPx: number }[] = [];
      for (let j = 1; j <= 2; j++) {
        const idx = nextIdx + j;
        const lockPx = extrapolateTrailTierLockPx(allLevels, idx, isLong, entry);
        if (lockPx != null && Number.isFinite(lockPx) && lockPx > 0) {
          const activationPx = isLong ? lockPx * (1 + bufEffective) : lockPx * (1 - bufEffective);
          nextTwoTierLocks.push({
            tierLabel: tierLabelForTrailIndex(allLevels, idx),
            lockPx,
            activationPx,
          });
        }
      }

      // Also render the next 3 upcoming lock+activation pairs directly on the chart.
      for (let j = 0; j < 3; j++) {
        const idx = nextIdx + j;
        const lockPx = extrapolateTrailTierLockPx(allLevels, idx, isLong, entry);
        if (lockPx == null || !Number.isFinite(lockPx) || lockPx <= 0) continue;
        const lab = tierLabelForTrailIndex(allLevels, idx);
        const col = nextPalette[j] ?? (chartTheme === "dark" ? "#fbbf24" : "#f59e0b");
        const actPx = isLong ? lockPx * (1 + bufEffective) : lockPx * (1 - bufEffective);
        if (futuresBracketLevelSane(symPlausible, lockPx, ohlcLastClose) && !slDup(lockPx)) {
          tierLines.push({ px: lockPx, title: `${lab} lock`, kind: "trail_tier_lock", tierLabel: lab, color: col });
        }
        if (Number.isFinite(actPx) && actPx > 0 && futuresBracketLevelSane(symPlausible, actPx, ohlcLastClose) && !slDup(actPx)) {
          tierLines.push({ px: actPx, title: `${lab} activation`, kind: "trail_tier_activation", tierLabel: lab, color: col });
        }
      }

      const tpHud = Number(pos.takeProfit);
      const trailHud: ChartTrailHud = {
        currentSl: Number.isFinite(prevSlChart) && prevSlChart > 0 ? prevSlChart : null,
        takeProfit: Number.isFinite(tpHud) && tpHud > 0 ? tpHud : null,
        nextActivationPx: nextActivationPx != null && Number.isFinite(nextActivationPx) && nextActivationPx > 0 ? nextActivationPx : null,
        nextTierLabel,
        liveTrailSlPx: displayPx,
        currentTrailedTierLabel,
        nextTwoTierLocks,
      };

      return {
        /** Omit mark `cur` from key — it changes every tick and was retriggering price-line workarounds. */
        key: `trail-FEE-${displayPx.toFixed(6)}|${symKey}`,
        lines: allTierLines,
        badge: mkBadge(feeTrailingLive),
        trailHud,
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

    /** Round-trip fee for SUPERTREND mode: openFee + closeFee × optional multiplier */
    const rtFeeChart = openFeeR + closeFeeR;
    const paddedFeeBeBase = feeRateBreakevenPadded(rtFeeChart, feeBeMultiplierChart);
    /** Matches `applyTrailingStopBinanceMemory`: padded fee + optional activation slippage (Supertrend only). */
    const paddedFeeSt = Math.min(0.02, paddedFeeBeBase + slipFracChart);
    const useFeeBeTrail = bot?.futuresTrailingStFeeBreakeven !== false;
    const useAdvancedTrail = bot?.futuresTrailingStAdvanced !== false;
    const tieredStMode = useFeeBeTrail && useAdvancedTrail;
    const extrasSt = Array.isArray(bot?.trailingStopExtraScalpingPcts)
      ? (bot.trailingStopExtraScalpingPcts as unknown[]).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
      : [];
    const stLevels = tieredStMode
      ? buildTrailLockPrices(entry, isLong, feeR, extrasSt, {
          openFeeRate: openFeeR,
          closeFeeRate: closeFeeR,
          feeBeMultiplier: feeBeMultiplierChart,
        })
      : [];
    const postT02SpacingUser =
      bot?.trailPostT02SpacingFrac != null && Number.isFinite(Number(bot.trailPostT02SpacingFrac))
        ? Number(bot.trailPostT02SpacingFrac)
        : null;
    const paddedFeeStActive =
      useFrozenLadder && ladderSnap != null && Number.isFinite(Number(ladderSnap.feeBeSt))
        ? Number(ladderSnap.feeBeSt)
        : paddedFeeSt;
    const bufTieredActive =
      useFrozenLadder && ladderSnap != null && Number.isFinite(Number(ladderSnap.buf)) ? Number(ladderSnap.buf) : bufEffective;
    const postT02SpacingActive =
      useFrozenLadder &&
      ladderSnap != null &&
      ladderSnap.postT02SpacingFrac != null &&
      Number.isFinite(Number(ladderSnap.postT02SpacingFrac))
        ? Number(ladderSnap.postT02SpacingFrac)
        : postT02SpacingUser;
    const rtFeeActive =
      useFrozenLadder && ladderSnap != null && Number.isFinite(Number(ladderSnap.roundTripFeeR))
        ? Number(ladderSnap.roundTripFeeR)
        : rtFeeChart;
    const feeBeLockRateActive = feeRateBreakevenPadded(rtFeeActive, feeBeMultiplierChart);
    const postT02MaxExtraTiers = Math.max(
      10,
      Math.min(500, Math.floor(Number(bot?.trailPostT02MaxExtraTiers ?? 150))),
    );
    const tieredGateOpts = { roundTripFeeRate: rtFeeActive, postT02SpacingFrac: postT02SpacingActive };
    const maxTieredActivationSteps = maxTrailStepsForConfig(extrasSt, postT02MaxExtraTiers);
    const tsMeta = Number((pos.meta as Record<string, unknown> | undefined)?.trailStep);
    const stepNow = Number.isFinite(tsMeta) && tsMeta >= 0 ? Math.floor(tsMeta) : 0;
    const locksReachedBySl =
      tieredStMode && stLevels.length > 0 && Number.isFinite(prevSlForCompute) && prevSlForCompute > 0
        ? trailLadderConsecutiveLocksReached(stLevels, prevSlForCompute, isLong)
        : 0;
    /**
     * Post‑T02 spacing is equidistant from the T02 lock (not the old fee-ladder interval); do not infer
     * trailed tier from SL vs T0/T1 locks. Use server `trailStep` for tiered preview.
     */
    const uiTrailedStep = tieredStMode ? stepNow : Math.min(stepNow, locksReachedBySl);

    let breakeven: number;
    let activation: number;
    let liquidation: number;
    if (isLong) {
      breakeven = entry * (1 + paddedFeeStActive);
      activation = entry * (1 + paddedFeeStActive + bufTieredActive);
      liquidation = entry * (1 - 1 / lev + maintenanceMarginRate);
      if (liquidation >= breakeven) return none("trail-reject", mkBadge(false));
    } else {
      breakeven = entry * (1 - paddedFeeStActive);
      activation = entry * (1 - paddedFeeStActive - bufTieredActive);
      liquidation = entry * (1 + 1 / lev - maintenanceMarginRate);
      if (liquidation <= breakeven) return none("trail-reject", mkBadge(false));
    }
    const tierAct = supertrendTieredActivationGate(
      entry,
      isLong,
      paddedFeeStActive,
      bufTieredActive,
      useFeeBeTrail,
      stepNow,
      stLevels,
      tieredStMode ? tieredGateOpts : undefined,
    );
    activation = tierAct.activationPx;
    const nextActivationTier = tierAct.nextRow;

    const minSlDist = Number.isFinite(Number(bot?.trailMinSlDistFrac)) ? Number(bot?.trailMinSlDistFrac) : 0.002;
    const minGapMark = Number.isFinite(Number(bot?.trailMinGapFromMarkFrac)) ? Number(bot?.trailMinGapFromMarkFrac) : 0;
    const metaRec = (pos.meta || {}) as Record<string, unknown>;
    const extremeHint = Number(metaRec.extremePx);
    let r: ReturnType<typeof computeSupertrendTrailingSlUpdate>;
    if (tieredStMode) {
      const hwm = isLong
        ? Math.max(Number.isFinite(extremeHint) ? extremeHint : cur, cur)
        : Math.min(Number.isFinite(extremeHint) ? extremeHint : cur, cur);
      const rawPriceStep = computeSupertrendTieredMaxTrailStepFromExtreme({
        hwm,
        entryPx: entry,
        isLong,
        feeBe: paddedFeeStActive,
        bufferRate: bufTieredActive,
        useFeeBeTrail,
        stLevels,
        maxActivationSteps: maxTieredActivationSteps,
        roundTripFeeRate: rtFeeActive,
        postT02SpacingFrac: postT02SpacingActive,
      });
      const maxCap = Math.max(maxTieredActivationSteps, 3);
      const priceStep = Math.min(rawPriceStep, maxCap);
      const nextTrailStep = Math.max(stepNow, priceStep);
      const t01ActivationPx = isLong ? entry * (1 + bufTieredActive) : entry * (1 - bufTieredActive);
      const t02ActivationPx = isLong
        ? entry * (1 + paddedFeeStActive + bufTieredActive)
        : entry * (1 - paddedFeeStActive - bufTieredActive);
      const entryLockBreakevenPx = isLong ? entry * (1 + t01LockSlipChart) : entry * (1 - t01LockSlipChart);
      const beEvtBase = isLong ? entry * (1 + feeBeLockRateActive) : entry * (1 - feeBeLockRateActive);
      if (nextTrailStep < 1) {
        r = { newSl: prevSlForCompute, status: "NO_TRAIL" };
      } else if (nextTrailStep >= 3) {
        const ladderRaw = tieredStLockPxForCompletedTrailStep(nextTrailStep, {
          entryPx: entry,
          isLong,
          feeBeLockRate: feeBeLockRateActive,
          feeBeSt: paddedFeeStActive,
          roundTripFeeR: rtFeeActive,
          postT02SpacingFrac: postT02SpacingActive,
          t01LockSlipFrac: t01LockSlipChart,
        });
        if (ladderRaw == null || !Number.isFinite(ladderRaw)) {
          r = { newSl: prevSlForCompute, status: "NO_TRAIL" };
        } else {
          const computeBreakevenPx = nextTrailStep === 1 ? entryLockBreakevenPx : beEvtBase;
          let ladderSl = applyMinTrailGapFromMark({
            isLong,
            cur: cur,
            prevSl: prevSlForCompute,
            newSl: ladderRaw,
            breakeven: computeBreakevenPx,
            useFeeBe: useFeeBeTrail,
            gapFrac: minGapMark,
          });
          if (Number.isFinite(minSlDist) && minSlDist > 0 && cur > 0) {
            const dist = Math.abs(cur - ladderSl) / cur;
            const tightening = isLong ? ladderSl > prevSlForCompute : ladderSl < prevSlForCompute;
            if (dist < minSlDist && !tightening) {
              ladderSl = prevSlForCompute;
            }
          }
          r = { newSl: ladderSl, status: "OK" };
        }
      } else {
        const gateForGeometry =
          nextTrailStep <= 1
            ? t01ActivationPx
            : nextTrailStep === 2
              ? t02ActivationPx
              : supertrendTieredActivationGate(
                  entry,
                  isLong,
                  paddedFeeStActive,
                  bufTieredActive,
                  useFeeBeTrail,
                  nextTrailStep - 1,
                  stLevels,
                  tieredGateOpts,
                ).activationPx;
        const pxForCompute = isLong ? Math.max(cur, gateForGeometry) : Math.min(cur, gateForGeometry);
        const computeBreakevenPx = nextTrailStep === 1 ? entryLockBreakevenPx : beEvtBase;
        r = computeSupertrendTrailingSlUpdate({
          entryPrice: entry,
          currentPrice: pxForCompute,
          supertrend: Number.NaN,
          previousSl: prevSlForCompute,
          isLong,
          leverage: lev,
          feeRate: paddedFeeStActive,
          bufferRate: bufTieredActive,
          maintenanceMarginRate,
          minSlDistanceFrac: minSlDist,
          minTrailGapFromMarkFrac: minGapMark,
          useFeeBreakeven: useFeeBeTrail,
          useAdvancedTrail: false,
          activationPrice: gateForGeometry,
          breakevenPrice: computeBreakevenPx,
        });
      }
    } else {
      r = computeSupertrendTrailingSlUpdate({
        entryPrice: entry,
        currentPrice: cur,
        supertrend: stPx,
        previousSl: prevSlForCompute,
        isLong,
        leverage: lev,
        feeRate: paddedFeeStActive,
        bufferRate: bufTieredActive,
        maintenanceMarginRate,
        minSlDistanceFrac: minSlDist,
        minTrailGapFromMarkFrac: minGapMark,
        useFeeBreakeven: useFeeBeTrail,
        useAdvancedTrail: useAdvancedTrail,
        activationPrice: tierAct.activationPx,
        breakevenPrice: breakeven,
      });
    }

    if (r.status === "NO_SUPERTREND" || r.status === "INVALID" || r.status === "REJECT_TRADE") {
      return none(`trail-${r.status}`, mkBadge(false));
    }

    /** Only after activation does the server merge SL toward ST; do not preview ST-as-trail before that. */
    const trailPx = r.status === "OK" ? r.newSl : null;
    const stTrailingLive = r.status === "OK";

    const lines: ChartStTrailPreviewLine[] = [];
    const pushUnique = (px: number, title: string, kind: ChartStTrailPreviewLine["kind"], tierLabel?: string) => {
      if (!Number.isFinite(px) || px <= 0 || !futuresBracketLevelSane(symPlausible, px, ohlcLastClose)) return;
      if (slDup(px)) return;
      if (lines.some((l) => nearlySameTrailPx(l.px, px))) return;
      lines.push({ px, title, kind, tierLabel });
    };
    /** Tier ladder reference prices — do not hide when they equal the chart SL (`slDup`), or "(trailed)" looks inconsistent. */
    const pushTierRef = (px: number, title: string, kind: ChartStTrailPreviewLine["kind"], tierLabel?: string) => {
      if (!Number.isFinite(px) || px <= 0 || !futuresBracketLevelSane(symPlausible, px, ohlcLastClose)) return;
      if (lines.some((l) => nearlySameTrailPx(l.px, px))) return;
      lines.push({ px, title, kind, tierLabel });
    };

    if (tieredStMode) {
      const nextPalette = chartTheme === "dark"
        ? ["#fbbf24", "#a78bfa", "#34d399"]
        : ["#f59e0b", "#7c3aed", "#059669"];
      for (let gi = 0; gi < 2; gi++) {
        const gateIdx = stepNow + gi;
        if (gateIdx > maxTieredActivationSteps) break;
        const g = supertrendTieredActivationGate(
          entry,
          isLong,
          paddedFeeStActive,
          bufTieredActive,
          useFeeBeTrail,
          gateIdx,
          stLevels,
          tieredGateOpts,
        );
        const ap = g.activationPx;
        const lab = g.activationTierLabel ?? `G${gateIdx}`;
        if (!Number.isFinite(ap) || ap <= 0) break;
        const title =
          gi === 0
            ? isLong
              ? `Next ${lab} activation (mark ≥)`
              : `Next ${lab} activation (mark ≤)`
            : isLong
              ? `Then ${lab} activation (mark ≥)`
              : `Then ${lab} activation (mark ≤)`;
        pushTierRef(ap, title, "st_tier_activation", lab);
      }

      // Next 3 post‑gate lock+activation pairs (T01/T02/T1…): show lock (solid) + activation (dashed) in same color.
      for (let gi = 0; gi < 3; gi++) {
        const gateIdx = stepNow + gi;
        if (gateIdx > maxTieredActivationSteps) break;
        const g = supertrendTieredActivationGate(
          entry,
          isLong,
          paddedFeeStActive,
          bufTieredActive,
          useFeeBeTrail,
          gateIdx,
          stLevels,
          tieredGateOpts,
        );
        const ap = Number(g.activationPx);
        const lab = g.activationTierLabel ?? `T${Math.max(0, gateIdx)}`;
        if (!Number.isFinite(ap) || ap <= 0) continue;
        let lockPx = Number.NaN;
        if (g.nextRow != null && Number.isFinite(Number(g.nextRow.lockPx)) && Number(g.nextRow.lockPx) > 0) {
          lockPx = Number(g.nextRow.lockPx);
        } else if (Number.isFinite(bufTieredActive) && bufTieredActive > 0) {
          lockPx = isLong ? ap / (1 + bufTieredActive) : ap / (1 - bufTieredActive);
        } else {
          lockPx = ap;
        }
        const col = nextPalette[gi] ?? (chartTheme === "dark" ? "#fbbf24" : "#f59e0b");
        if (Number.isFinite(lockPx) && lockPx > 0) {
          pushTierRef(lockPx, `${lab} lock`, "trail_tier_lock", lab);
          lines[lines.length - 1]!.color = col;
        }
        pushTierRef(ap, `${lab} activation`, "trail_tier_activation", lab);
        lines[lines.length - 1]!.color = col;
      }
    } else {
      if (nextActivationTier && futuresBracketLevelSane(symPlausible, activation, ohlcLastClose) && !slDup(activation)) {
        const nextTierLabel = nextActivationTier.tierLabel ?? null;
        lines.push({
          px: activation,
          title: nextTierLabel
            ? isLong ? `ST trail opens ${nextTierLabel} (mark ≥)` : `ST trail opens ${nextTierLabel} (mark ≤)`
            : isLong ? "ST trail opens (mark ≥)" : "ST trail opens (mark ≤)",
          kind: "st_activation",
          tierLabel: nextTierLabel ?? undefined,
        });
      }
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
        const { trailed, tierLabel: serverTierLabel } = metaTrailTrailedFromPosition(pos);
        const trailTitle = trailed && serverTierLabel ? `ST trail · ${serverTierLabel}` : "ST trail";
        lines.push({ px: trailPx, title: trailTitle, kind: "st_trail", tierLabel: serverTierLabel ?? undefined });
      }
    }

    const tpHud = Number(pos.takeProfit);
    const tierLabelStyleHud =
      ((pos.meta || {}) as Record<string, unknown>).trailStepLabelStyle === "tiered_st_fee_entry" ||
      Number(((pos.meta || {}) as Record<string, unknown>).trailTierSchemaVersion) >= 2 ||
      tieredStMode
        ? ("tiered_st_fee_entry" as const)
        : ("classic" as const);
    const currentTrailedTierLabel =
      uiTrailedStep >= 1 ? trailStepToTierLabel(uiTrailedStep, tierLabelStyleHud) : null;
    const nextTwoTierLocks: { tierLabel: string; lockPx: number; activationPx: number }[] = [];
    if (tieredStMode) {
      const buf = bufTieredActive;
      for (let gi = 0; gi < 2; gi++) {
        const gateIdx = stepNow + gi;
        if (gateIdx > maxTieredActivationSteps) break;
        const g = supertrendTieredActivationGate(
          entry,
          isLong,
          paddedFeeStActive,
          bufTieredActive,
          useFeeBeTrail,
          gateIdx,
          stLevels,
          tieredGateOpts,
        );
        const ap = g.activationPx;
        const lab = g.activationTierLabel ?? `G${gateIdx}`;
        if (Number.isFinite(ap) && ap > 0) {
          let lockPx = Number.NaN;
          if (g.nextRow != null && Number.isFinite(Number(g.nextRow.lockPx)) && Number(g.nextRow.lockPx) > 0) {
            lockPx = Number(g.nextRow.lockPx);
          } else if (Number.isFinite(buf) && buf > 0) {
            lockPx = isLong ? ap / (1 + buf) : ap / (1 - buf);
          } else {
            lockPx = ap;
          }
          if (!Number.isFinite(lockPx) || lockPx <= 0) lockPx = ap;
          nextTwoTierLocks.push({ tierLabel: lab, lockPx, activationPx: ap });
        }
      }
    }
    const trailHud: ChartTrailHud = {
      currentSl: Number.isFinite(prevSlChart) && prevSlChart > 0 ? prevSlChart : null,
      takeProfit: Number.isFinite(tpHud) && tpHud > 0 ? tpHud : null,
      nextActivationPx: Number.isFinite(activation) && activation > 0 ? activation : null,
      nextTierLabel:
        tieredStMode
          ? tierAct.activationTierLabel != null
            ? String(tierAct.activationTierLabel)
            : `T${stepNow}`
          : nextActivationTier?.tierLabel != null
            ? String(nextActivationTier.tierLabel)
            : `T${stepNow}`,
      liveTrailSlPx: trailPx != null && Number.isFinite(trailPx) && trailPx > 0 ? trailPx : null,
      currentTrailedTierLabel,
      nextTwoTierLocks,
    };

    if (!lines.length) {
      return { key: `trail-empty|${symKey}`, lines: [], badge: mkBadge(stTrailingLive), trailHud };
    }

    return {
      /** Coarser px in key so mark-driven micro jitter does not retrigger the price-line effect every tick. */
      key: `trail-ST-${lines.map((l) => `${l.kind}:${l.px.toFixed(2)}`).join("|")}|${symKey}`,
      lines,
      badge: mkBadge(stTrailingLive),
      trailHud,
    };
  }, [
    bot?.trailingStopLossAuto,
    bot?.futuresTrailingStopMode,
    bot?.trailingStopExtraScalpingPcts,
    bot?.trailBufferRate,
    bot?.trailActivationSlippageFrac,
    bot?.trailT01LockSlippageFrac,
    bot?.trailBufferAtrMult,
    bot?.trailBufferMode,
    bot?.lastRegime,
    bot?.trailOpenFeeRate,
    bot?.trailCloseFeeRate,
    bot?.trailFeeBeMultiplier,
    bot?.futuresTrailingStFeeBreakeven,
    bot?.futuresTrailingStAdvanced,
    bot?.trailMinSlDistFrac,
    bot?.trailMinGapFromMarkFrac,
    bot?.trailMaintMarginRate,
    bot?.trailPostT02SpacingFrac,
    bot?.trailPostT02MaxExtraTiers,
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

  // Keep tierLinePricesRef in sync with chartTrailingPreview so the pan/zoom handler
  // always has fresh tier prices when computing y-coordinates for the overlay labels.
  useEffect(() => {
    const specs = chartTrailingPreview.lines
      .filter(
        (l) =>
          l.tierLabel &&
          (l.kind === "trail_tier_activated" ||
            l.kind === "trail_tier_next" ||
            l.kind === "st_trail" ||
            l.kind === "trail_tier_lock" ||
            l.kind === "st_tier_activation"),
      )
      .map((l) => ({ label: l.tierLabel!, px: l.px }));
    tierLinePricesRef.current = specs;
    // Immediately recompute positions with the current series scale
    if (!specs.length) {
      setTierLabelPositions([]);
      return;
    }
    const ser = seriesRef.current;
    if (!ser) return;
    const positions = specs
      .map((s) => {
        try {
          const y = ser.priceToCoordinate(s.px);
          return y != null ? { label: s.label, y } : null;
        } catch {
          return null;
        }
      })
      .filter((x): x is { label: string; y: number } => x != null);
    setTierLabelPositions(positions);
  }, [chartTrailingPreview.lines]);

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
    chartTrailingPreview.badge?.trailExchangePending === true ||
    Boolean(symKey && chartTrailedSessionBySymbol[symKey]);

  /**
   * Single stable key for the SL/TP/trail price-line effect.
   * **Do not** key that effect on `chartTrailingPreview.lines` — it is a fresh array every memo run (e.g. every
   * positions WS tick), so React re-ran the effect constantly; rapid `createPriceLine` without reliable `remove`
   * stacked identical axis labels (same price, column of badges).
   */
  const chartBracketPriceLayerKey = useMemo(
    () =>
      `${futuresBracket.key}|${chartTrailingPreview.key}|${chartTheme}|${chartInstanceKey}|${chartTrailingPreview.badge?.trailing ? 1 : 0}${chartTrailingPreview.badge?.trailed ? 1 : 0}${chartTrailingPreview.badge?.trailExchangePending ? 1 : 0}`,
    [
      futuresBracket.key,
      chartTrailingPreview.key,
      chartTheme,
      chartInstanceKey,
      chartTrailingPreview.badge?.trailing,
      chartTrailingPreview.badge?.trailed,
      chartTrailingPreview.badge?.trailExchangePending,
    ],
  );

  /** Lower-right panel: fixed size, always three rows for next SL · Tn lock (see `pickNextThreeSlTnLockLegendRows`). */
  const shouldShowFuturesBracketLegend = useMemo(() => {
    if (!inferFuturesBracketLinesActive(bot)) return false;
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
      return false;
    }
    return true;
  }, [bot, positions, effectiveSym, isMultiCoinMode, ohlcLastClose, chartTrailingPreview.lines.length]);

  const chartNextSlLockLegendRows = useMemo(
    () => pickNextThreeSlTnLockLegendRows(chartTrailingPreview.lines, chartTheme === "dark"),
    [chartTrailingPreview.lines, chartTheme],
  );

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
    const lineOpts = (price: number, title: string, color: string, lineStyle: number = LineStyle.Dashed) => ({
      price,
      color,
      lineWidth: 1,
      lineStyle: lineStyle as 0 | 1 | 2 | 3,
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

    // Entry price line for the open position
    const primaryPos = filterChartSymbolFuturesOpenRows(live.positions, eff);
    const primaryRow = selectPrimaryFuturesPositionForChart(primaryPos);
    const entryPx = primaryRow ? Number(primaryRow.entryPrice) : NaN;

    try {
      for (const m of mergedBracketLines) {
        bracketPriceLinesRef.current.push(series.createPriceLine(lineOpts(m.px, m.title, m.color, m.lineStyle ?? LineStyle.Dashed)));
      }
      // Draw entry price as a solid, distinct line (not dashed) so it's clearly the position anchor
      if (Number.isFinite(entryPx) && entryPx > 0 && lastClose != null) {
        const entryCol = isDark ? "#818cf8" : "#6366f1"; // indigo
        bracketPriceLinesRef.current.push(
          series.createPriceLine({
            price: entryPx,
            color: entryCol,
            lineWidth: 1,
            lineStyle: 0 as const, // solid
            axisLabelVisible: false,
            title: `Entry ${entryPx.toLocaleString("en-US", { maximumFractionDigits: 6 })}`,
          }),
        );
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
      /** Store can clear `candles` (e.g. WS `state` rekey) before new bars arrive — must wipe LWC or old pair sticks on canvas. */
      if (chartOkRef.current && seriesRef.current) {
        try {
          seriesRef.current.setData([]);
        } catch {
          /* ignore */
        }
      }
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
    /** Match `buildOhlc` / exchange keys — slashes in UI symbol must not skip `EXACT_CLOSE_RANGE` in sanity checks. */
    const sym = canonicalChartSymbol(effectiveSym);

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
        if (!sanitized.length) {
          try {
            series.setData([]);
          } catch {
            /* ignore */
          }
          chartOhlcAppliedRef.current = null;
          return;
        }
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
      const appliedFit = chartOhlcAppliedRef.current;
      const lastBarSec =
        appliedFit?.length && appliedFit[appliedFit.length - 1]
          ? Number(appliedFit[appliedFit.length - 1]!.time)
          : Number(last.time);
      tryApplyAutoFit(
        chart,
        chartOhlcAppliedRef.current?.length ?? ohlc.length,
        pendingAutoFitRef,
        fitAfterRestSnapshotRef,
        skipFitUntilBulkRef,
        Number.isFinite(lastBarSec) ? lastBarSec : undefined,
        normalizeSymTf(bot?.timeframe) || null,
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
  }, [ohlc, effectiveSym, bot?.timeframe]);

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
      const appliedBulk = chartOhlcAppliedRef.current;
      const rawBulk = ohlcRef.current;
      const len = appliedBulk?.length ?? rawBulk.length;
      let lastBulkSec: number | undefined;
      if (appliedBulk?.length) {
        lastBulkSec = Number(appliedBulk[appliedBulk.length - 1]!.time);
      } else if (rawBulk.length) {
        lastBulkSec = Number(rawBulk[rawBulk.length - 1]!.time);
      }
      if (chartOkRef.current && chart && len > 0) {
        tryApplyAutoFit(
          chart,
          len,
          pendingAutoFitRef,
          fitAfterRestSnapshotRef,
          skipFitUntilBulkRef,
          Number.isFinite(lastBulkSec) ? lastBulkSec : undefined,
          tf,
        );
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

  /** Tab back to foreground: rAF/microtask backlog while hidden can leave the last candle minutes stale; snap from REST once. */
  useEffect(() => {
    const sym = normalizeSymTf(bot?.symbol);
    const tf = normalizeSymTf(bot?.timeframe);
    if (!sym || !tf) return;
    if (normalizeSymTf(effectiveSym) !== sym) return;
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
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
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
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
          <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-400">
            Chart: <span className="font-mono">{effectiveSym}</span>
            {" · "}
            live multiplex feed + WS <span className="font-mono">market</span> (bot trades{" "}
            <span className="font-mono">{normalizeSymTf(bot?.symbol) || "—"}</span>).
          </p>
        ) : null}
        <div className="relative w-full shrink-0">
          <div
            key={chartInstanceKey}
            ref={containerRef}
            className="w-full min-h-[240px]"
            style={{ height: "min(390px, 45vh)" }}
          />
          {/* Tier label overlay: left-side T0/T1/T2 labels positioned at the trailing tier price lines */}
          {tierLabelPositions.length > 0 ? (
            <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
              {tierLabelPositions.map(({ label, y }) =>
                y >= 8 && y <= 375 ? (
                  <div
                    key={label}
                    className="absolute left-1 flex items-center"
                    style={{ top: y - 8 }}
                  >
                    <span className="rounded px-1 py-0.5 text-[9px] font-bold leading-none bg-emerald-600/85 text-white dark:bg-emerald-500/85 dark:text-slate-950 shadow-sm">
                      {label}
                    </span>
                  </div>
                ) : null,
              )}
            </div>
          ) : null}
          {/* Trail summary + next locks moved below the chart (prevents overlap on small screens). */}
          {trailingStatusChipsVisible ? (
            <div
              className="pointer-events-none absolute left-2 top-2 z-10 flex flex-col items-start gap-0.5"
              aria-label="Futures trailing status"
            >
              <div className="flex flex-row items-center gap-1.5">
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
                  className={`rounded-md px-1.5 py-0.5 text-[10px] font-semibold tracking-wide shadow-sm ${
                    trailingChipTrailedHighlight
                      ? "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-slate-950"
                      : "border border-slate-400/60 bg-slate-900/55 text-slate-400 dark:border-slate-600 dark:bg-slate-950/70 dark:text-slate-500"
                  }`}
                >
                  {chartTrailingPreview.badge?.trailExchangePending
                    ? "Confirming…"
                    : trailingChipTrailedHighlight && chartTrailingPreview.badge?.tierLabel
                      ? `Trailed · ${chartTrailingPreview.badge.tierLabel}`
                      : "Trailed"}
                </span>
              </div>
              {chartTrailingPreview.badge?.trailExchangePending ? (
                <div className="max-w-[14rem] rounded border border-amber-600/40 bg-slate-950/80 px-1.5 py-0.5 text-[9px] font-medium text-amber-100/95 shadow-sm">
                  Waiting for exchange to confirm the new stop…
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        {shouldShowFuturesBracketLegend || (chartTrailingPreview.trailHud && inferFuturesBracketLinesActive(bot)) ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {chartTrailingPreview.trailHud && inferFuturesBracketLinesActive(bot) ? (
              <div
                className="max-w-full space-y-0.5 rounded-md border border-amber-700/40 bg-slate-950/88 px-2 py-1.5 text-[10px] leading-tight text-amber-100/95 shadow-lg backdrop-blur-sm dark:border-amber-600/35 dark:bg-slate-950/90"
                aria-label="Trail summary"
              >
                <div className="text-[9px] font-semibold uppercase tracking-wide text-amber-200/90">Trail</div>
                {chartTrailingPreview.trailHud.currentSl != null ? (
                  <div className="font-mono text-slate-100">
                    SL now: {chartTrailingPreview.trailHud.currentSl.toLocaleString("en-US", { maximumFractionDigits: 6 })}
                  </div>
                ) : (
                  <div className="text-slate-400">SL now: —</div>
                )}
                {chartTrailingPreview.trailHud.takeProfit != null ? (
                  <div className="font-mono text-slate-100">
                    TP: {chartTrailingPreview.trailHud.takeProfit.toLocaleString("en-US", { maximumFractionDigits: 6 })}
                  </div>
                ) : (
                  <div className="text-slate-400">TP: —</div>
                )}
                {chartTrailingPreview.trailHud.currentTrailedTierLabel ? (
                  <div className="font-mono text-emerald-200/90">
                    Trailed at: {chartTrailingPreview.trailHud.currentTrailedTierLabel}
                  </div>
                ) : null}
                {chartTrailingPreview.trailHud.nextActivationPx != null &&
                chartTrailingPreview.trailHud.nextTierLabel &&
                !(Array.isArray(chartTrailingPreview.trailHud.nextTwoTierLocks) && chartTrailingPreview.trailHud.nextTwoTierLocks.length) ? (
                  <div className="font-mono text-amber-100/90">
                    Next {chartTrailingPreview.trailHud.nextTierLabel} activation:{" "}
                    {chartTrailingPreview.trailHud.nextActivationPx.toLocaleString("en-US", { maximumFractionDigits: 6 })}
                  </div>
                ) : null}
                {Array.isArray(chartTrailingPreview.trailHud.nextTwoTierLocks) && chartTrailingPreview.trailHud.nextTwoTierLocks.length ? (
                  <div className="space-y-0.5">
                    {chartTrailingPreview.trailHud.nextTwoTierLocks.slice(0, 2).map((r, i) => {
                      const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 6 });
                      return (
                        <div key={`${r.tierLabel}-${i}`} className="font-mono text-slate-100/95">
                          {i === 0 ? "Next" : "Then"} {r.tierLabel}: lock {fmt(r.lockPx)} · activation {fmt(r.activationPx)}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {chartTrailingPreview.trailHud.liveTrailSlPx != null ? (
                  <div className="font-mono text-emerald-200/90">
                    Live trail SL:{" "}
                    {chartTrailingPreview.trailHud.liveTrailSlPx.toLocaleString("en-US", { maximumFractionDigits: 6 })}
                  </div>
                ) : (
                  <div className="text-slate-500">Live trail SL: (not in trail zone)</div>
                )}
              </div>
            ) : (
              <div />
            )}
            {shouldShowFuturesBracketLegend ? (
              <div
                className="flex max-w-full flex-col rounded-md border border-slate-600/50 bg-slate-950/85 px-2 py-1.5 text-[10px] leading-tight shadow-lg backdrop-blur-sm dark:border-slate-500/40 dark:bg-slate-950/90"
                aria-label="Next SL tier lock levels"
              >
                <div className="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-slate-400">Next SL · Tn lock</div>
                <div className="mt-1 flex min-h-0 flex-1 flex-col justify-between gap-0.5">
                  {chartNextSlLockLegendRows.map((row, idx) => (
                    <div key={idx} className="flex min-h-0 flex-nowrap items-baseline justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium" style={{ color: row.color }}>
                        {row.title}
                      </span>
                      <span className="shrink-0 font-mono tabular-nums text-slate-100">
                        {Number.isFinite(row.px) && row.px > 0
                          ? row.px.toLocaleString("en-US", { maximumFractionDigits: 6 })
                          : "—"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div />
            )}
          </div>
        ) : null}
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
                  ({normalizeSymTf(effectiveSym) || "—"} · newest first · AI/SS/SP/MQ = gates & move-quality; times {CHART_TIMEZONE})
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
                const mq =
                  h.mqScore != null && Number.isFinite(Number(h.mqScore)) ? Number(h.mqScore).toFixed(2) : "—";
                const mqV = h.mqVerdict != null && String(h.mqVerdict).trim() ? String(h.mqVerdict).trim() : "—";
                const act = h.stAction != null ? String(h.stAction) : "—";
                const nAll = supertrendSignalHistoryNewestFirst.length;
                const chronoIdx = nAll - 1 - i;
                const verdict = supertrendSignalVerdictsChrono[chronoIdx];
                const sec = Math.floor(Number(h.ts) / 1000);
                const displayTs =
                  h.signalBarCloseTs != null && Number.isFinite(Number(h.signalBarCloseTs)) && Number(h.signalBarCloseTs) > 0
                    ? Number(h.signalBarCloseTs)
                    : Number(h.ts) +
                      binanceIntervalMs(String(h.timeframe || bot?.timeframe || "1m"));
                const fromServer =
                  h.signalBarClose != null &&
                  Number.isFinite(Number(h.signalBarClose)) &&
                  Number(h.signalBarClose) > 0
                    ? Number(h.signalBarClose)
                    : undefined;
                const entryPx =
                  fromServer ??
                  (Number.isFinite(sec) ? signalListCloseBySec.get(sec) : undefined);
                const entryStr =
                  entryPx != null && Number.isFinite(entryPx) && entryPx > 0 ? entryPx.toFixed(5) : "—";
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
                const rowKey = `${pair}-${h.ts}-${h.side}-${i}`;
                const mdSnap =
                  h.marketDecisionSnapshot != null && typeof h.marketDecisionSnapshot === "object"
                    ? (h.marketDecisionSnapshot as Record<string, unknown>)
                    : null;
                const mdVerdict = displayMarketDecisionVerdict(mdSnap);
                const ssGateMin = signalListSsGateMin(bot);
                const mqGateMin = signalListMqGateMin(bot);
                const mdPt =
                  mdSnap?.passThresholds != null && typeof mdSnap.passThresholds === "object"
                    ? (mdSnap.passThresholds as Record<string, unknown>)
                    : null;
                const mdPassBr = signalListMdPassBracketCompact(mdPt);
                return (
                  <li
                    key={rowKey}
                    className={
                      h.side === "BUY"
                        ? "border-l-2 border-emerald-500/60 pl-1 text-emerald-100/95"
                        : "border-l-2 border-rose-500/60 pl-1 text-rose-100/95"
                    }
                  >
                    <button
                      type="button"
                      className="w-full rounded px-0.5 py-0.5 text-left hover:bg-slate-200/40 dark:hover:bg-slate-800/50"
                      onClick={() => setOpenSignalAccordionKey((k) => (k === rowKey ? null : rowKey))}
                      aria-expanded={openSignalAccordionKey === rowKey}
                      title={
                        mdEnforcementOff(mdSnap)
                          ? "Click to expand. Engine master switch off: MD verdict is what would apply if enabled (for monitoring). Supertrend Action is authoritative for trades. Brackets = min to pass each gate when that gate is on."
                          : "Click to expand: signal strength, move quality, market decision (ADX/RSI/EMA) + verdict when engine is on. Brackets = min threshold to pass that filter layer."
                      }
                    >
                      <span className="inline-block w-4 shrink-0 text-[10px] text-slate-500">
                        {openSignalAccordionKey === rowKey ? "▾" : "▸"}
                      </span>
                      <span
                        className="text-slate-600 dark:text-slate-500"
                        title="Bar close (order window); was bar open — aligns with execution on 1m+ TF"
                      >
                        {formatHistTimeIst(displayTs)}
                      </span>{" "}
                      <span className="font-mono text-[10px] font-semibold text-slate-700 dark:text-slate-300">{pair}</span>{" "}
                      <span className="font-semibold">{h.side}</span>
                      <span className="text-slate-600 dark:text-slate-400"> · @ {entryStr}</span>
                      <span className="text-slate-600 dark:text-slate-400"> · AI {ai}</span>
                      <span className="text-slate-600 dark:text-slate-400"> · SS {ss}</span>
                      {ssGateMin != null ? (
                        <span
                          className="text-slate-500 dark:text-slate-500"
                          title="Min composite signal strength to pass the signal-strength gate (when enabled in Trading)"
                        >
                          {" "}
                          [≥{ssGateMin}]
                        </span>
                      ) : null}
                      <span className="text-slate-600 dark:text-slate-400"> · SP {sp}</span>
                      <span
                        className="text-slate-600 dark:text-slate-400"
                        title="Move quality: ATR vs SL, ADX, body vs avg, ATR expansion — composite 0–1 + PASS/BORDER/WEAK"
                      >
                        {" "}
                        · MQ {mq} {mqV !== "—" ? `(${mqV})` : ""}
                      </span>
                      {mqGateMin != null ? (
                        <span
                          className="text-slate-500 dark:text-slate-500"
                          title="Min move-quality score to pass the move-quality gate (when enabled in Trading)"
                        >
                          {" "}
                          [≥{mqGateMin.toFixed(2)}]
                        </span>
                      ) : null}
                      <span className="text-slate-600 dark:text-slate-500"> · {act}</span>
                      <span className={`font-medium ${vCls}`}> · {vLabel}</span>
                      {mdVerdict ? (
                        <span
                          className="text-violet-600/95 dark:text-violet-300/90"
                          title={
                            mdEnforcementOff(mdSnap)
                              ? "Verdict if engine were enabled (monitoring when master switch is off). Not a trade permit by itself — compare to supertrend Action."
                              : "Market decision engine verdict at this bar (when enabled, enforced with other gates). Bracket = min thresholds for regime/score/fee/chop layers from snapshot."
                          }
                        >
                          {" "}
                          · MD <span className="font-mono">{mdVerdict}</span>
                          {mdPassBr ? (
                            <span className="text-slate-500 dark:text-slate-500"> {mdPassBr}</span>
                          ) : null}
                        </span>
                      ) : null}
                    </button>
                    {openSignalAccordionKey === rowKey ? (
                      <div className="mt-1 pl-5 pr-1 pb-1">
                        <SupertrendSignalAccordionDetails h={h} />
                      </div>
                    ) : null}
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
