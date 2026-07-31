/**
 * LIQ_CASCADE — live data feed health for UI (read-only; does not affect signal timing).
 */
import {
  getLiquidationStreamStatus,
  getRecentLiquidations,
  getLiquidationPayloadForSymbol,
  ensureLiquidationStreamRunning,
} from "../intelligence/collectors/liquidationCollector.js";
import {
  getOpenInterestFetchedAt,
  intelligenceCache,
} from "../intelligence/index.js";
import { isLiqCascadeLiveEngineRunning } from "../svc/liqCascadeLiveEngine.js";

function streamOpts(ctx) {
  return {
    getTradingMode:
      typeof ctx.getTradingMode === "function"
        ? ctx.getTradingMode
        : () => process.env.TRADING_MODE || "PAPER",
  };
}

function resolveLiquidationsOk(sym, liqStream) {
  const recentTicks = getRecentLiquidations(sym, 15 * 60_000);
  const liqSnap = getLiquidationPayloadForSymbol(sym);

  // Event-driven feed: connected WS = ready (quiet markets are normal).
  if (liqStream.live) {
    return {
      ok: true,
      recentTicks,
      liqSnap,
      reason: recentTicks.length > 0 ? "recent_ticks" : liqStream.messageCount > 0 ? "stream_active" : "connected",
    };
  }
  if (recentTicks.length > 0) {
    return { ok: true, recentTicks, liqSnap, reason: "recent_ticks" };
  }
  if (liqStream.running && !liqStream.connected) {
    return { ok: false, recentTicks, liqSnap, reason: "connecting" };
  }
  if (liqStream.running) {
    return { ok: false, recentTicks, liqSnap, reason: "starting" };
  }
  return { ok: false, recentTicks, liqSnap, reason: "not_running" };
}

/**
 * @param {{
 *   symbol?: string,
 *   feedStatus?: { ok?: boolean, source?: string, error?: string | null } | null,
 *   marketFeedLive?: boolean,
 *   liqCascadeLiveTickEnabled?: boolean,
 *   botRunning?: boolean,
 *   getTradingMode?: () => string,
 *   ensureStream?: boolean,
 * }} ctx
 */
export function buildLiqCascadeFeedStatus(ctx = {}) {
  const sym = String(ctx.symbol || "BTCUSDT").trim().toUpperCase();
  const symKey = sym.replace(/[^A-Za-z0-9]/g, "");
  const feedStatus = ctx.feedStatus ?? null;
  const marketFeedLive = ctx.marketFeedLive !== false;
  const tickEnabled = ctx.liqCascadeLiveTickEnabled === true;
  const botRunning = ctx.botRunning === true;

  const klinesOk = Boolean(marketFeedLive && feedStatus?.ok);
  const klinesSource = feedStatus?.source ?? null;
  const klinesError = feedStatus?.error ?? null;

  const liqStream =
    ctx.ensureStream !== false
      ? ensureLiquidationStreamRunning(streamOpts(ctx))
      : getLiquidationStreamStatus();
  const liqResolved = resolveLiquidationsOk(sym, liqStream);
  const recentTicks = liqResolved.recentTicks;
  const liqSnap =
    liqResolved.liqSnap ?? intelligenceCache.liquidations?.[sym] ?? intelligenceCache.liquidations?.[symKey] ?? null;
  const liquidationsOk = liqResolved.ok;

  const oiRow =
    intelligenceCache.openInterest?.[sym] ??
    intelligenceCache.openInterest?.[symKey] ??
    null;
  const oiFetchedAt = getOpenInterestFetchedAt(sym) ?? getOpenInterestFetchedAt(symKey);
  const oiOk = oiRow != null && Number(oiRow.usdt) > 0;
  const oiPending = !oiOk && (oiFetchedAt == null || Date.now() - oiFetchedAt < 90_000);

  const tickEngineRunning = isLiqCascadeLiveEngineRunning();
  const tickEngineOk = !tickEnabled || (botRunning && tickEngineRunning);

  const requiredOk = klinesOk && liquidationsOk && oiOk && tickEngineOk;

  return {
    symbol: sym,
    allOk: requiredOk,
    updatedAt: Date.now(),
    feeds: {
      klines: {
        ok: klinesOk,
        label: "OHLC / klines",
        source: klinesSource,
        error: klinesError,
        required: true,
      },
      liquidations: {
        ok: liquidationsOk,
        label: "Liquidations (forceOrder)",
        connected: liqStream.connected,
        running: liqStream.running,
        live: liqStream.live,
        streamUrl: liqStream.streamUrl,
        lastMessageAt: liqStream.lastMessageAt,
        lastError: liqStream.lastError,
        messageCount: liqStream.messageCount,
        recentTickCount: recentTicks.length,
        window4hUsd: liqSnap?.totalUsd ?? null,
        healthReason: liqResolved.reason,
        required: true,
      },
      openInterest: {
        ok: oiOk,
        label: "Open interest",
        usdt: oiRow?.usdt ?? null,
        change4hPct: oiRow?.change4hPct ?? null,
        fetchedAt: oiFetchedAt,
        pending: oiPending,
        required: true,
      },
      tickEngine: {
        ok: tickEngineOk,
        label: "Tick executor",
        enabled: tickEnabled,
        running: tickEngineRunning,
        botRunning,
        required: tickEnabled,
      },
    },
  };
}
