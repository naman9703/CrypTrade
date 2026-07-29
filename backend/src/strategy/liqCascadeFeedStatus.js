/**
 * LIQ_CASCADE — live data feed health for UI (green/red indicators).
 */
import {
  getLiquidationStreamStatus,
  getRecentLiquidations,
  getLiquidationPayloadForSymbol,
} from "../intelligence/collectors/liquidationCollector.js";
import {
  getOpenInterestFetchedAt,
  intelligenceCache,
} from "../intelligence/index.js";
import { isLiqCascadeLiveEngineRunning } from "../svc/liqCascadeLiveEngine.js";

/**
 * @param {{
 *   symbol?: string,
 *   feedStatus?: { ok?: boolean, source?: string, error?: string | null } | null,
 *   marketFeedLive?: boolean,
 *   liqCascadeLiveTickEnabled?: boolean,
 *   botRunning?: boolean,
 * }} ctx
 */
export function buildLiqCascadeFeedStatus(ctx = {}) {
  const sym = String(ctx.symbol || "BTCUSDT").trim().toUpperCase();
  const feedStatus = ctx.feedStatus ?? null;
  const marketFeedLive = ctx.marketFeedLive !== false;
  const tickEnabled = ctx.liqCascadeLiveTickEnabled === true;
  const botRunning = ctx.botRunning === true;

  const klinesOk = Boolean(marketFeedLive && feedStatus?.ok);
  const klinesSource = feedStatus?.source ?? null;
  const klinesError = feedStatus?.error ?? null;

  const liqStream = getLiquidationStreamStatus();
  const recentTicks = getRecentLiquidations(sym, 15 * 60_000);
  const liqSnap = getLiquidationPayloadForSymbol(sym) ?? intelligenceCache.liquidations?.[sym] ?? null;
  const liquidationsOk = Boolean(liqStream.ok);

  const oiRow = intelligenceCache.openInterest?.[sym] ?? null;
  const oiFetchedAt = getOpenInterestFetchedAt(sym);
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
        streamUrl: liqStream.streamUrl,
        lastMessageAt: liqStream.lastMessageAt,
        lastError: liqStream.lastError,
        messageCount: liqStream.messageCount,
        recentTickCount: recentTicks.length,
        window4hUsd: liqSnap?.totalUsd ?? null,
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
