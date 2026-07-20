/**
 * Supertrend tiered trailing lock + activation lines (T01…T3 / T01a…T3a) for backtest trade chart.
 * Mirrors `TrailPreviewModal` / `trailingFeeLadder.ts` / backend tiered ST semantics.
 */
import { LineStyle } from "lightweight-charts";
import type { BacktestRunSummary, BacktestTrade } from "../../types/backtest";
import {
  buildTieredStEquidistantLockRows,
  clampFeeRate,
  computeDynamicT01LockFrac,
  computeDynamicTrailBuffer,
  computeEffectiveTrailBuffer,
  DEFAULT_TRAIL_FEE_BE_MULTIPLIER,
  defaultTieredPostT02SpacingFrac,
  dynamicPostT02SpacingFrac,
  feeRateBreakevenPadded,
  resolvePostT02ActivationBufferFrac,
  resolveTrailSizingMode,
} from "../../lib/trailingFeeLadder.ts";
import type { ChartPriceLineSpec } from "./backtestChartOverlays";

function botFromRun(run: BacktestRunSummary): Record<string, unknown> {
  const snap = run.configSnapshot as { bot?: Record<string, unknown> } | null | undefined;
  return snap?.bot && typeof snap.bot === "object" ? snap.bot : {};
}

const TIER_LABELS = ["T01", "T02", "T1", "T2", "T3"] as const;

const TIER_COLORS: Record<(typeof TIER_LABELS)[number], string> = {
  T01: "#fbbf24",
  T02: "#fb923c",
  T1: "#a3e635",
  T2: "#34d399",
  T3: "#22d3ee",
};

function tierActivationPx(
  label: (typeof TIER_LABELS)[number],
  entryPx: number,
  isLong: boolean,
  lockPx: number,
  paddedFeeSt: number,
  t01T02Buf: number,
  postT02Buf: number,
): number | null {
  if (label === "T01") {
    return isLong ? entryPx * (1 + t01T02Buf) : entryPx * (1 - t01T02Buf);
  }
  if (label === "T02") {
    return isLong
      ? entryPx * (1 + paddedFeeSt + t01T02Buf)
      : entryPx * (1 - paddedFeeSt - t01T02Buf);
  }
  if (!Number.isFinite(lockPx) || lockPx <= 0) return null;
  if (postT02Buf <= 0) return lockPx;
  return isLong ? lockPx * (1 + postT02Buf) : lockPx * (1 - postT02Buf);
}

export function isBacktestTrailingChartEnabled(run: BacktestRunSummary | null): boolean {
  if (!run) return false;
  const bot = botFromRun(run);
  if (bot.trailingStopLossAuto !== true) return false;
  const mode = String(bot.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
  return mode !== "OFF" && mode !== "FEE_LADDER";
}

/** Tiered T01→T3 static ladder lines (fee-BE + advanced trail). */
export function isBacktestTrailTierLadderEnabled(run: BacktestRunSummary | null): boolean {
  if (!isBacktestTrailingChartEnabled(run)) return false;
  const bot = botFromRun(run);
  return bot.futuresTrailingStFeeBreakeven === true && bot.futuresTrailingStAdvanced === true;
}

/** @deprecated Use isBacktestTrailingChartEnabled */
export function isBacktestTrailTierChartEnabled(run: BacktestRunSummary | null): boolean {
  return isBacktestTrailingChartEnabled(run);
}

/** Lock + activation horizontal lines for tiered trailing (1m trade chart). */
export function buildBacktestTrailTierLines(
  run: BacktestRunSummary,
  trade: BacktestTrade,
): ChartPriceLineSpec[] {
  if (!isBacktestTrailTierLadderEnabled(run)) return [];

  const entryPx = Number(trade.entryPrice);
  if (!Number.isFinite(entryPx) || entryPx <= 0) return [];

  const bot = botFromRun(run);
  const isLong = trade.direction === "BUY";
  const openR = clampFeeRate(Number(bot.trailOpenFeeRate ?? 0.0004));
  const closeR = clampFeeRate(Number(bot.trailCloseFeeRate ?? 0.0004));
  const rtFee = openR + closeR;
  const feeBeMult = Number(bot.trailFeeBeMultiplier ?? DEFAULT_TRAIL_FEE_BE_MULTIPLIER);
  const feeBeLock = feeRateBreakevenPadded(rtFee, feeBeMult);
  const slipFrac = Math.max(0, Math.min(0.02, Number(bot.trailActivationSlippageFrac ?? 0)));
  const paddedFeeSt = Math.min(0.02, feeBeLock + slipFrac);
  const isDynamic = resolveTrailSizingMode(bot) === "DYNAMIC";
  const atrPctRaw = (trade as { atrPct?: number | null }).atrPct;
  const atrPct = atrPctRaw != null && Number.isFinite(Number(atrPctRaw)) ? Number(atrPctRaw) : null;
  const t01T02Buf = isDynamic
    ? computeDynamicTrailBuffer({
        entryAtrPct: atrPct,
        trailDynamicBeAtrMult: Number(bot.trailDynamicBeAtrMult ?? 0.5),
        trailDynamicBeRegimeAdjust: bot.trailDynamicBeRegimeAdjust === true,
        trailDynamicBeRegimeLowMult: Number(bot.trailDynamicBeRegimeLowMult ?? 0.85),
        trailDynamicBeRegimeHighMult: Number(bot.trailDynamicBeRegimeHighMult ?? 1.15),
        fallbackBufferRate: Number(bot.trailBufferRate ?? 0.0005),
      })
    : computeEffectiveTrailBuffer({
        bufferRate: Number(bot.trailBufferRate ?? 0.0005),
        trailBufferMode: String(bot.trailBufferMode ?? "PERCENT"),
        trailBufferAtrMult: Number(bot.trailBufferAtrMult ?? 0),
        atrPct: null,
      });
  const postT02BufRaw =
    bot.trailPostT02ActivationBufferRate != null &&
    Number.isFinite(Number(bot.trailPostT02ActivationBufferRate))
      ? Number(bot.trailPostT02ActivationBufferRate)
      : null;
  const postT02Buf = resolvePostT02ActivationBufferFrac(postT02BufRaw, t01T02Buf);
  const spRaw = bot.trailPostT02SpacingFrac != null ? Number(bot.trailPostT02SpacingFrac) : Number.NaN;
  const sp = isDynamic
    ? dynamicPostT02SpacingFrac(atrPct, Number(bot.trailDynamicAdvPostT02StepAtrMult ?? 0.5))
    : Number.isFinite(spRaw) && spRaw > 0
      ? Math.min(0.05, spRaw)
      : defaultTieredPostT02SpacingFrac(rtFee);
  const t01Slip = isDynamic
    ? computeDynamicT01LockFrac({
        entryAtrPct: atrPct,
        trailDynamicBeT01LockAtrMult: Number(bot.trailDynamicBeT01LockAtrMult ?? 0),
        fixedT01LockSlipFrac: Number(bot.trailT01LockSlippageFrac ?? 0),
      })
    : Math.max(0, Math.min(0.01, Number(bot.trailT01LockSlippageFrac ?? 0)));

  const rows = buildTieredStEquidistantLockRows(entryPx, isLong, feeBeLock, sp, 3, t01Slip);
  const want = new Set<string>(TIER_LABELS);
  const out: ChartPriceLineSpec[] = [];

  for (const label of TIER_LABELS) {
    const row = rows.find((r) => r.tierLabel === label);
    if (!row || !want.has(label)) continue;
    const color = TIER_COLORS[label] ?? "#94a3b8";
    out.push({
      price: row.lockPx,
      color,
      title: label,
      lineStyle: LineStyle.Dotted,
      lineWidth: 1,
      axisLabelVisible: false,
    });

    const activationPx = tierActivationPx(
      label,
      entryPx,
      isLong,
      row.lockPx,
      paddedFeeSt,
      t01T02Buf,
      postT02Buf,
    );
    if (activationPx != null && Number.isFinite(activationPx) && activationPx > 0) {
      out.push({
        price: activationPx,
        color,
        title: `${label}a`,
        lineStyle: LineStyle.Dashed,
        lineWidth: 1,
        axisLabelVisible: false,
      });
    }
  }

  return out;
}
