/**
 * Production feed health for Binance public streams (USDT-M / spot klines + optional aggTrade).
 *
 * Semantics:
 * - "Stale" means we are not receiving usable fresh market data in time — not merely "HTTP 200".
 * - A WebSocket can stay **open** while bytes or klines stop (zombie / silent freeze). Detection must use
 *   **last inbound activity** and **last accepted primary kline** (sanitized into our buffer), not `readyState` alone.
 *
 * Threshold (when `FEED_STALE_MS` is unset): **2 × bar duration** for the bot timeframe, clamped by
 * `FEED_STALE_MIN_MS` / `FEED_STALE_MAX_MS`. Override entirely with `FEED_STALE_MS` if you need a fixed window.
 *
 * @see https://binance-docs.github.io/apidocs/futures/en/#kline-candlestick-streams
 */

/** @param {string} timeframe e.g. 1m, 5m, 1h */
export function timeframeToBarDurationMs(timeframe) {
  const s = String(timeframe || "1m").trim().toLowerCase();
  if (s.endsWith("ms")) return Math.max(1, Number(s.slice(0, -2)) || 1);
  if (s.endsWith("m")) return Math.max(60_000, Number(s.slice(0, -1)) * 60_000);
  if (s.endsWith("h")) return Math.max(60_000, Number(s.slice(0, -1)) * 3600_000);
  if (s.endsWith("d")) return Math.max(60_000, Number(s.slice(0, -1)) * 86400_000);
  return 60_000;
}

/**
 * Wall-clock threshold: how long without progress before we pause execution / consider recovery.
 * @param {string} timeframe
 */
export function resolveExecutionStaleThresholdMs(timeframe) {
  /** Default 25s: avoids flaky "Feed: stale" under WS jitter while staying below a single 1m bar. */
  const minT = Math.max(5000, Number(process.env.FEED_STALE_MIN_MS ?? 25_000));
  const maxT = Math.max(minT, Number(process.env.FEED_STALE_MAX_MS ?? 600_000));
  const fixed = Number(process.env.FEED_STALE_MS);
  if (Number.isFinite(fixed) && fixed >= minT) {
    return Math.min(maxT, fixed);
  }
  const bar = timeframeToBarDurationMs(timeframe);
  const doubled = 2 * bar;
  return Math.min(maxT, Math.max(minT, doubled));
}

/**
 * @param {object} p
 * @param {number} p.now
 * @param {string} p.timeframe
 * @param {boolean} p.inTradingGrace e.g. post–coin-switch grace: do not pause on stale
 * @param {boolean} p.combinedWsOk kline multiplex socket `open` and not in local error state
 * @param {number | null | undefined} p.lastKlineSocketInboundAt wall-clock ms of last **raw** `message` on kline WS
 * @param {number | null | undefined} p.lastPrimaryAcceptedKlineAt wall-clock ms of last kline **accepted** into primary buffer
 * @param {boolean | undefined} p.deltaWsOk
 * @param {number | null | undefined} p.lastDeltaInboundAt wall-clock last aggTrade message (optional cross-check)
 */
export function evaluateLiveBinanceFeedExecutionGate({
  now,
  timeframe,
  inTradingGrace,
  combinedWsOk,
  lastKlineSocketInboundAt,
  lastPrimaryAcceptedKlineAt,
  deltaWsOk,
  lastDeltaInboundAt,
}) {
  const thresholdMs = resolveExecutionStaleThresholdMs(timeframe);
  if (inTradingGrace) {
    return {
      shouldPauseExecution: false,
      wsUnhealthy: false,
      dataStale: false,
      thresholdMs,
      minActivityRef: null,
      maxActivityRef: null,
      stalenessRef: null,
      detail: { inTradingGrace: true },
    };
  }

  const inbound = lastKlineSocketInboundAt != null ? Number(lastKlineSocketInboundAt) : NaN;
  const accepted = lastPrimaryAcceptedKlineAt != null ? Number(lastPrimaryAcceptedKlineAt) : NaN;
  const deltaT = lastDeltaInboundAt != null ? Number(lastDeltaInboundAt) : NaN;

  const klineRefs = [];
  if (Number.isFinite(inbound)) klineRefs.push(inbound);
  if (Number.isFinite(accepted)) klineRefs.push(accepted);

  const requireDelta =
    String(process.env.FEED_STALE_REQUIRE_DELTA_ACTIVE ?? "").toLowerCase() === "1" ||
    String(process.env.FEED_STALE_REQUIRE_DELTA_ACTIVE ?? "").toLowerCase() === "true";

  const deltaRefs = [];
  if (requireDelta && deltaWsOk !== false && Number.isFinite(deltaT)) {
    deltaRefs.push(deltaT);
  }

  /**
   * Default: use **newest** kline evidence (max of inbound vs primary-accept) for staleness.
   * The old min() caused frequent false “Feed: stale” when one ref lagged a cycle behind the other on busy multiplex sockets.
   * Set `FEED_STALE_REQUIRE_ALL_KLINE_REFS_FRESH=1` to restore strict min() for both inbound + accepted.
   */
  const strictAllKlineFresh =
    String(process.env.FEED_STALE_REQUIRE_ALL_KLINE_REFS_FRESH ?? "").toLowerCase() === "1" ||
    String(process.env.FEED_STALE_REQUIRE_ALL_KLINE_REFS_FRESH ?? "").toLowerCase() === "true";
  const klineEvalRef =
    klineRefs.length === 0
      ? null
      : strictAllKlineFresh
        ? Math.min(...klineRefs)
        : Math.max(...klineRefs);

  /** Oldest evidence among kline + delta legs (debug / activity detail). */
  const minActivityRef =
    klineRefs.length && deltaRefs.length
      ? Math.min(Math.min(...klineRefs), Math.min(...deltaRefs))
      : klineRefs.length
        ? Math.min(...klineRefs)
        : deltaRefs.length
          ? Math.min(...deltaRefs)
          : null;

  const deltaMinRef = deltaRefs.length ? Math.min(...deltaRefs) : null;
  /** Timestamp used for `dataStale` — when delta is required, both kline-eval and delta must be fresh. */
  const stalenessRef =
    requireDelta && klineEvalRef != null && deltaMinRef != null
      ? Math.min(klineEvalRef, deltaMinRef)
      : klineEvalRef != null
        ? klineEvalRef
        : deltaMinRef;

  /** Best-case — used to detect recovery after a stall. */
  const maxActivityRef = (() => {
    const all = [...klineRefs, ...deltaRefs];
    if (!all.length) return null;
    return Math.max(...all);
  })();

  const wsUnhealthy = combinedWsOk === false;
  const dataStale = stalenessRef != null && now - stalenessRef > thresholdMs;
  const shouldPauseExecution = wsUnhealthy || dataStale;

  return {
    shouldPauseExecution,
    wsUnhealthy,
    dataStale,
    thresholdMs,
    minActivityRef,
    maxActivityRef,
    stalenessRef,
    detail: {
      lastKlineSocketInboundAt: Number.isFinite(inbound) ? inbound : null,
      lastPrimaryAcceptedKlineAt: Number.isFinite(accepted) ? accepted : null,
      lastDeltaInboundAt: Number.isFinite(deltaT) ? deltaT : null,
      requireDeltaActive: requireDelta,
      klineEvalRef: klineEvalRef != null && Number.isFinite(klineEvalRef) ? klineEvalRef : null,
    },
  };
}

/**
 * Bot auto-restart after feed stale stop: true when recent activity is back within threshold.
 */
export function feedRecoveredForAutoRestart({ now, maxActivityRef, thresholdMs }) {
  if (maxActivityRef == null || !Number.isFinite(Number(maxActivityRef))) return false;
  return now - Number(maxActivityRef) <= thresholdMs;
}
