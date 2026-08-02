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
import { evaluateLiveBinanceFeedExecutionGate } from "../lib/binanceFeedHealth.js";

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

function oiGateActive(ctx) {
  const mode = String(ctx.liqCascadeOiGateMode ?? "window").toLowerCase();
  const minDrop = Number(ctx.liqCascadeMinOiDropPct ?? 0);
  return mode !== "off" && mode !== "backtest_off" && minDrop > 0;
}

/**
 * Kline readiness: WS `ok` flag OR fresh buffered klines (backfill / brief reconnect).
 * Strict `feedStatus.ok` alone false-negatives during USD-M multiplex reconnects.
 */
export function resolveLiqCascadeKlinesOk(marketFeedLive, feedStatus, timeframe = "1m") {
  const fs = feedStatus ?? {};
  const source = fs.source ?? null;
  const buffer = Number(fs.buffer ?? 0);
  const now = Date.now();
  const lastInbound = fs.lastMsgAt != null ? Number(fs.lastMsgAt) : null;
  const lastAccepted = fs.lastPrimaryBufferPushAt != null ? Number(fs.lastPrimaryBufferPushAt) : null;

  if (!marketFeedLive) {
    return {
      ok: false,
      reason: source === "SYNTH" ? "synth_feed" : "not_live",
      source,
      error:
        source === "SYNTH"
          ? "Synthetic klines — set PAPER_MARKET_FEED=BINANCE_FUTURES in backend .env and restart"
          : "Live Binance kline feed not configured",
      buffer,
      lastMessageAt: lastInbound,
      lastAcceptedAt: lastAccepted,
    };
  }

  if (fs.ok === true) {
    return {
      ok: true,
      reason: "ws_live",
      source,
      buffer,
      lastMessageAt: lastInbound,
      lastAcceptedAt: lastAccepted,
      error: fs.error ?? null,
    };
  }

  const gate = evaluateLiveBinanceFeedExecutionGate({
    now,
    timeframe: String(timeframe || "1m"),
    inTradingGrace: false,
    combinedWsOk: fs.ok === true,
    lastKlineSocketInboundAt: lastInbound,
    lastPrimaryAcceptedKlineAt: lastAccepted,
    deltaWsOk: fs.delta?.ok,
    lastDeltaInboundAt: fs.delta?.lastMsgAt,
  });

  if (buffer > 0 && !gate.dataStale) {
    return {
      ok: true,
      reason: gate.wsUnhealthy ? "ws_reconnect" : "data_fresh",
      source,
      buffer,
      lastMessageAt: lastInbound,
      lastAcceptedAt: lastAccepted,
      error: fs.error ?? null,
    };
  }

  if (buffer > 0) {
    return {
      ok: false,
      reason: "stale",
      source,
      buffer,
      lastMessageAt: lastInbound,
      lastAcceptedAt: lastAccepted,
      error: fs.error ?? "Kline data stale — waiting for live WS",
    };
  }

  return {
    ok: false,
    reason: gate.wsUnhealthy ? "ws_down" : fs.error ? "error" : "connecting",
    source,
    buffer,
    lastMessageAt: lastInbound,
    lastAcceptedAt: lastAccepted,
    error: fs.error ?? null,
  };
}

/**
 * @param {{
 *   symbol?: string,
 *   timeframe?: string,
 *   feedStatus?: { ok?: boolean, source?: string, error?: string | null, buffer?: number, lastMsgAt?: number | null, lastPrimaryBufferPushAt?: number | null, delta?: object } | null,
 *   marketFeedLive?: boolean,
 *   liqCascadeLiveTickEnabled?: boolean,
 *   liqCascadeOiGateMode?: string,
 *   liqCascadeMinOiDropPct?: number,
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
  const oiRequired = oiGateActive(ctx);

  const klinesResolved = resolveLiqCascadeKlinesOk(marketFeedLive, feedStatus, ctx.timeframe);

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
  const tickHealthReason = !tickEnabled
    ? "off"
    : !botRunning
      ? "bot_stopped"
      : tickEngineRunning
        ? "running"
        : "starting";

  const requiredOk =
    klinesResolved.ok && liquidationsOk && (!oiRequired || oiOk) && tickEngineOk;

  return {
    symbol: sym,
    allOk: requiredOk,
    updatedAt: Date.now(),
    feeds: {
      klines: {
        ok: klinesResolved.ok,
        label: "OHLC / klines",
        source: klinesResolved.source ?? feedStatus?.source ?? null,
        error: klinesResolved.error ?? feedStatus?.error ?? null,
        buffer: klinesResolved.buffer ?? null,
        lastMessageAt: klinesResolved.lastMessageAt ?? null,
        healthReason: klinesResolved.reason,
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
        required: oiRequired,
      },
      tickEngine: {
        ok: tickEngineOk,
        label: "Tick executor",
        enabled: tickEnabled,
        running: tickEngineRunning,
        botRunning,
        required: tickEnabled,
        healthReason: tickHealthReason,
      },
    },
  };
}
