/**
 * Per-trade trailing replay.
 *
 * - `replayTradeTrailingMicro` — backtest-aligned 1m mark OHLC via `simulateTrailingForParentBar`
 * - `replayTradeTrailingTicks` — live-style `applyTrailingStopBinanceMemory` on tick marks (aggTrade audit)
 */

import { applyTrailingStopBinanceMemory } from "../../lib/trailingStopLoss.js";
import { trailStepToTierLabel } from "../../lib/supertrendTrailingSl.js";
import { buildTrailingOptsFromCfg } from "../../lib/trailingOptsFromCfg.js";
import { applySlippage, resolveCostModel } from "./costModel.js";
import { classifyStopExitReason, resolveTrailingOpts } from "./trailingSim.js";
import { simulateTrailingForParentBar, simulateTrailingSingleBar } from "./trailMicroSim.js";

const SKIP_EXIT_REASONS = new Set([
  "flip",
  "tp",
  "tp2",
  "tp1_partial",
  "liq",
  "time_stop",
  "signal",
  "manual",
  "of_exit",
  "gate",
]);

/** @returns {boolean} */
export function isTrailReplaySkipped(exitReason) {
  const r = String(exitReason ?? "").toLowerCase();
  return SKIP_EXIT_REASONS.has(r);
}

function slBreached(isLong, sl, markPx) {
  const stop = Number(sl);
  const px = Number(markPx);
  if (!Number.isFinite(stop) || stop <= 0 || !Number.isFinite(px)) return false;
  return isLong ? px <= stop : px >= stop;
}

function alignDown1m(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return 0;
  return Math.floor(n / 60_000) * 60_000;
}

/** First parent bar where trailing is evaluated (entry fills at prior bar close in backtest). */
export function computeTrailReplayStartMs(entryTs, tfMs) {
  const step = Math.max(60_000, Number(tfMs) || 60_000);
  const entry = Number(entryTs);
  if (!Number.isFinite(entry)) return 0;
  return Math.floor(entry / step) * step + step;
}

function finalizeReplayExit({ trade, pos, exit, exitTs, cfg, costModel, leverage }) {
  const direction = String(trade.direction || "").toUpperCase();
  const isLong = direction === "BUY";
  const entryPrice = Number(trade.entryPrice);
  const qty = Number(trade.qty ?? trade.quantity ?? 0);
  const cm = resolveCostModel(cfg, costModel && typeof costModel === "object" ? costModel : {});
  const closeSide = isLong ? "SELL" : "BUY";
  const fillPx = applySlippage(closeSide, exit.price, cm.slippagePct);
  const gross = isLong ? (fillPx - entryPrice) * qty : (entryPrice - fillPx) * qty;
  const openFee = entryPrice * qty * (cm.useMakerEntries ? cm.makerOpenFeeRate : cm.takerOpenFeeRate);
  const closeFee = fillPx * qty * (cm.useMakerExits ? cm.makerCloseFeeRate : cm.takerCloseFeeRate);
  const netPnl = gross - openFee - closeFee;
  const reason =
    exit.reason ??
    classifyStopExitReason({
      side: direction,
      entryFill: entryPrice,
      initialSl: trade.initialSlPrice,
      sl: pos.sl,
      trailStep: pos.trailStep,
      beLocked: pos.beLocked,
    });
  return {
    ok: true,
    replaySkipped: false,
    exitReason: reason,
    exitPrice: fillPx,
    exitTs,
    trailStep: Math.max(0, Math.floor(Number(pos.trailStep) || 0)),
    trailTierLabel: pos.trailTierLabel ?? null,
    grossPnl: gross,
    netPnl,
    fees: openFee + closeFee,
    leverage: Math.max(1, Math.floor(Number(leverage ?? cm.leverage) || 1)),
  };
}

/**
 * Backtest-aligned replay: step 1m mark OHLC inside each parent strategy bar
 * (same path as `trailMicroSim.simulateTrailingForParentBar`).
 *
 * @param {object} args
 * @param {object} args.trade
 * @param {Record<string, unknown>} args.cfg
 * @param {object} [args.costModel]
 * @param {Array<{ ts: number, open: number, high: number, low: number, close: number }>} args.markBars
 * @param {Array<{ ts: number, open: number, high: number, low: number, close: number }>} args.parentCandles
 * @param {Array<{ line?: number, trend?: number, ready?: boolean }>} args.stSeries
 * @param {number} args.tfMs
 * @param {number|null} [args.tickSize]
 */
export function replayTradeTrailingMicro({
  trade,
  cfg,
  costModel,
  markBars,
  parentCandles,
  stSeries,
  tfMs,
  tickSize = null,
}) {
  const direction = String(trade.direction || "").toUpperCase();
  const isLong = direction === "BUY";
  const entryPrice = Number(trade.entryPrice);
  const qty = Number(trade.qty ?? trade.quantity ?? 0);
  const entryTs = new Date(trade.entryTs ?? trade.entry_time).getTime();
  const exitTsBound = new Date(trade.exitTs ?? trade.exit_time).getTime();
  const trailStartMs =
    trade.trailReplayStartMs != null && Number.isFinite(Number(trade.trailReplayStartMs))
      ? Number(trade.trailReplayStartMs)
      : computeTrailReplayStartMs(entryTs, tfMs);
  const initialSl =
    trade.initialSlPrice != null && Number.isFinite(Number(trade.initialSlPrice))
      ? Number(trade.initialSlPrice)
      : trade.slPrice != null && Number.isFinite(Number(trade.slPrice))
        ? Number(trade.slPrice)
        : null;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(qty) || qty <= 0) {
    return { ok: false, error: "invalid_trade", replaySkipped: true };
  }
  if (isTrailReplaySkipped(trade.exitReason)) {
    return { ok: true, replaySkipped: true, reason: String(trade.exitReason) };
  }
  if (initialSl == null || !Number.isFinite(initialSl) || initialSl <= 0) {
    return { ok: false, error: "missing_initial_sl", replaySkipped: true };
  }

  const cm = resolveCostModel(cfg, costModel && typeof costModel === "object" ? costModel : {});
  const step = Math.max(60_000, Number(tfMs) || 60_000);
  const mode = String(cfg.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
  const trailOpts = resolveTrailingOpts(cfg, cm, null);
  const tick =
    tickSize != null && Number.isFinite(Number(tickSize)) && Number(tickSize) > 0
      ? Number(tickSize)
      : trailOpts.tickSize ?? null;

  const parentByTs = new Map();
  for (let i = 0; i < (parentCandles?.length ?? 0); i++) {
    const c = parentCandles[i];
    const ts = Number(c?.ts);
    if (!Number.isFinite(ts)) continue;
    parentByTs.set(ts, { candle: c, stBar: stSeries?.[i] ?? null });
  }

  const pos = {
    side: isLong ? "BUY" : "SELL",
    entryFill: entryPrice,
    sl: initialSl,
    trailStep: 0,
    extremePx: entryPrice,
    trailTierLabel: null,
    beLocked: false,
  };

  const startParent = trailStartMs;
  for (let parentTs = startParent; parentTs <= exitTsBound; parentTs += step) {
    const meta = parentByTs.get(parentTs);
    const parentBar = meta?.candle ?? {
      ts: parentTs,
      open: entryPrice,
      high: entryPrice,
      low: entryPrice,
      close: entryPrice,
    };
    const stBar = meta?.stBar ?? null;
    const microFrom = Math.max(parentTs, alignDown1m(trailStartMs));
    const microTo = parentTs + step;
    const microBars = (markBars ?? []).filter((b) => {
      const ts = Number(b.ts);
      return Number.isFinite(ts) && ts >= microFrom && ts < microTo;
    });

    const sim =
      microBars.length === 0
        ? simulateTrailingSingleBar({
            pos,
            bar: parentBar,
            stBar,
            opts: trailOpts,
            mode,
            leverage: cm.leverage,
            tickSize: tick,
          })
        : simulateTrailingForParentBar({
            pos,
            parentBar,
            microBars,
            stBar,
            opts: trailOpts,
            mode,
            leverage: cm.leverage,
            tickSize: tick,
          });

    if (sim.exit) {
      return finalizeReplayExit({
        trade,
        pos: sim.pos,
        exit: sim.exit,
        exitTs: sim.exit.ts != null && Number.isFinite(Number(sim.exit.ts)) ? Number(sim.exit.ts) : parentTs,
        cfg,
        costModel,
        leverage: cm.leverage,
      });
    }
  }

  return {
    ok: true,
    replaySkipped: false,
    noExitInWindow: true,
    exitReason: null,
    exitPrice: null,
    exitTs: null,
    trailStep: Math.max(0, Math.floor(Number(pos.trailStep) || 0)),
    trailTierLabel: pos.trailTierLabel ?? null,
  };
}

/**
 * Map parent-bar open ts → supertrend line (last closed bar at or before tick).
 * @param {Array<{ ts: number, line?: number, ready?: boolean }>} stSeries
 * @param {Array<{ ts: number }>} parentCandles
 * @param {number} tfMs
 */
export function buildSupertrendAtTs(stSeries, parentCandles, tfMs) {
  const step = Math.max(60_000, Number(tfMs) || 60_000);
  const byOpen = new Map();
  for (let i = 0; i < (parentCandles?.length ?? 0); i++) {
    const ts = Number(parentCandles[i]?.ts);
    const st = stSeries?.[i];
    if (!Number.isFinite(ts) || !st) continue;
    const line = Number(st.line);
    byOpen.set(ts, Number.isFinite(line) && line > 0 ? line : null);
  }
  return (tickTs) => {
    const t = Number(tickTs);
    if (!Number.isFinite(t)) return null;
    const barOpen = Math.floor(t / step) * step;
    let best = null;
    for (const [open, line] of byOpen) {
      if (open <= barOpen && (best == null || open > best.open)) {
        best = { open, line };
      }
    }
    return best?.line ?? null;
  };
}

/**
 * @param {object} args
 * @param {object} args.trade
 * @param {Record<string, unknown>} args.cfg
 * @param {object} [args.costModel]
 * @param {Array<{ ts: number, markPx: number }>} args.ticks
 * @param {(ts: number) => number|null} [args.supertrendAtTs]
 * @param {number|null} [args.tickSize]
 * @param {number} [args.leverage]
 */
export function replayTradeTrailingTicks({
  trade,
  cfg,
  costModel,
  ticks,
  supertrendAtTs,
  tickSize = null,
  leverage = 1,
}) {
  const sym = String(trade.symbol || cfg?.symbol || "").toUpperCase();
  const direction = String(trade.direction || "").toUpperCase();
  const isLong = direction === "BUY";
  const entryPrice = Number(trade.entryPrice);
  const qty = Number(trade.qty ?? trade.quantity ?? 0);
  const entryTs = new Date(trade.entryTs ?? trade.entry_time).getTime();
  const exitTsBound = new Date(trade.exitTs ?? trade.exit_time).getTime();
  const trailStartMs = computeTrailReplayStartMs(
    entryTs,
    trade.trailReplayTfMs != null ? Number(trade.trailReplayTfMs) : 60_000,
  );
  const initialSl =
    trade.initialSlPrice != null && Number.isFinite(Number(trade.initialSlPrice))
      ? Number(trade.initialSlPrice)
      : trade.slPrice != null && Number.isFinite(Number(trade.slPrice))
        ? Number(trade.slPrice)
        : null;

  if (!sym || !Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(qty) || qty <= 0) {
    return { ok: false, error: "invalid_trade", replaySkipped: true };
  }
  if (isTrailReplaySkipped(trade.exitReason)) {
    return { ok: true, replaySkipped: true, reason: String(trade.exitReason) };
  }
  if (initialSl == null || !Number.isFinite(initialSl) || initialSl <= 0) {
    return { ok: false, error: "missing_initial_sl", replaySkipped: true };
  }

  const cm = resolveCostModel(cfg, costModel && typeof costModel === "object" ? costModel : {});
  const lev = Math.max(1, Math.min(125, Math.floor(Number(leverage ?? cm.leverage) || 1)));

  const mem = {
    trailingBySymbol: {
      [sym]: {
        entryPrice,
        isLong,
        trailStep: 0,
        confirmedTrailStep: 0,
        extremePx: entryPrice,
        leverage: lev,
        _openedAt: entryTs,
      },
    },
    localBrackets: { [sym]: { stopLoss: initialSl } },
    placedBracketTargets: { [sym]: { stopLoss: initialSl } },
  };

  const tr = mem.trailingBySymbol[sym];
  let lastExit = null;

  for (const tick of ticks ?? []) {
    const ts = Number(tick.ts);
    const markPx = Number(tick.markPx);
    if (!Number.isFinite(ts) || ts < trailStartMs || ts > exitTsBound) continue;
    if (!Number.isFinite(markPx) || markPx <= 0) continue;

    const stPx = typeof supertrendAtTs === "function" ? supertrendAtTs(ts) : null;
    const trailingOpts = buildTrailingOptsFromCfg(cfg, cm, { supertrendPx: stPx });
    if (!trailingOpts) break;

    const curSl = Number(mem.placedBracketTargets[sym]?.stopLoss ?? initialSl);
    if (slBreached(isLong, curSl, markPx)) {
      const reason = classifyStopExitReason({
        side: isLong ? "BUY" : "SELL",
        entryFill: entryPrice,
        initialSl,
        sl: curSl,
        trailStep: tr.trailStep,
        beLocked: tr.beLocked,
      });
      lastExit = {
        exitReason: reason,
        exitPrice: curSl,
        exitTs: ts,
        trailStep: Math.max(0, Math.floor(Number(tr.trailStep) || 0)),
        trailTierLabel:
          tr.trailTierLabel ??
          trailStepToTierLabel(Math.max(0, Math.floor(Number(tr.trailStep) || 0)), "tiered_st_fee_entry"),
      };
      break;
    }

    applyTrailingStopBinanceMemory({
      symbol: sym,
      markPx,
      trailingOpts: {
        ...trailingOpts,
        supertrendPx: stPx != null ? stPx : trailingOpts.supertrendPx,
      },
      trailingBySymbol: mem.trailingBySymbol,
      localBrackets: mem.localBrackets,
      placedBracketTargets: mem.placedBracketTargets,
      tickSize: tickSize != null && Number.isFinite(Number(tickSize)) ? Number(tickSize) : null,
    });

    const newSl = Number(mem.placedBracketTargets[sym]?.stopLoss ?? curSl);
    if (slBreached(isLong, newSl, markPx)) {
      const reason = classifyStopExitReason({
        side: isLong ? "BUY" : "SELL",
        entryFill: entryPrice,
        initialSl,
        sl: newSl,
        trailStep: tr.trailStep,
        beLocked: tr.beLocked,
      });
      lastExit = {
        exitReason: reason,
        exitPrice: newSl,
        exitTs: ts,
        trailStep: Math.max(0, Math.floor(Number(tr.trailStep) || 0)),
        trailTierLabel:
          tr.trailTierLabel ??
          trailStepToTierLabel(Math.max(0, Math.floor(Number(tr.trailStep) || 0)), "tiered_st_fee_entry"),
      };
      break;
    }
  }

  if (!lastExit) {
    return {
      ok: true,
      replaySkipped: false,
      noExitInWindow: true,
      exitReason: null,
      exitPrice: null,
      exitTs: null,
      trailStep: Math.max(0, Math.floor(Number(tr.trailStep) || 0)),
      trailTierLabel: tr.trailTierLabel ?? null,
    };
  }

  const closeSide = isLong ? "SELL" : "BUY";
  const fillPx = applySlippage(closeSide, lastExit.exitPrice, cm.slippagePct);
  const gross = isLong ? (fillPx - entryPrice) * qty : (entryPrice - fillPx) * qty;
  const openFee = entryPrice * qty * (cm.useMakerEntries ? cm.makerOpenFeeRate : cm.takerOpenFeeRate);
  const closeFee = fillPx * qty * (cm.useMakerExits ? cm.makerCloseFeeRate : cm.takerCloseFeeRate);
  const netPnl = gross - openFee - closeFee;

  return {
    ok: true,
    replaySkipped: false,
    ...lastExit,
    exitPrice: fillPx,
    grossPnl: gross,
    netPnl,
    fees: openFee + closeFee,
  };
}
