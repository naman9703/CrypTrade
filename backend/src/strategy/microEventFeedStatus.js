/**
 * MICRO_EVENT feed health — liq WS, aggTrade, depth, OI, funding, tick engine.
 */
import { getLiquidationStreamStatus } from "../intelligence/collectors/liquidationCollector.js";
import { getAggTradeRollingMetrics } from "../intelligence/collectors/aggTradeRolling.js";
import { intelligenceCache, getOpenInterestFetchedAt } from "../intelligence/index.js";
import { isMicroEventLiveEngineRunning } from "../svc/microEventLiveEngine.js";

function ageMs(ts) {
  if (ts == null || !Number.isFinite(ts)) return null;
  return Date.now() - ts;
}

function okAge(ms, maxMs) {
  if (ms == null) return false;
  return ms <= maxMs;
}

/**
 * @param {object} params
 */
export function buildMicroEventFeedStatus(params = {}) {
  const {
    symbol,
    watchSymbols = [],
    depthStatusBySymbol = {},
    tickEngineRunning = isMicroEventLiveEngineRunning(),
    microEventLiveTickEnabled = true,
  } = params;

  const sym = String(symbol || "BTCUSDT").trim().toUpperCase();
  const liqSt = getLiquidationStreamStatus();
  const agg = getAggTradeRollingMetrics(sym);
  const oiAt = getOpenInterestFetchedAt(sym);
  const oiAge = ageMs(oiAt);
  const funding = intelligenceCache.funding?.[sym];
  const depthSt = depthStatusBySymbol[sym] ?? null;

  const rows = [
    {
      id: "liquidations",
      label: "Liquidations (forceOrder WS)",
      ok: liqSt.ok === true,
      detail: liqSt.ok ? "Connected" : liqSt.lastError || "Reconnecting…",
    },
    {
      id: "aggtrade",
      label: "AggTrade rolling CVD",
      ok: okAge(ageMs(agg.lastTickMs), 120_000) || agg.tickCount > 0,
      detail: agg.lastTickMs
        ? `Last tick ${Math.round((ageMs(agg.lastTickMs) ?? 0) / 1000)}s ago · ${agg.tickCount} ticks/3m`
        : "No aggTrade ticks yet — start bot on futures feed",
    },
    {
      id: "depth",
      label: `Order book (${sym})`,
      ok: depthSt?.ok === true,
      detail: depthSt?.ok ? "depth20@100ms" : depthSt?.error || "Depth WS missing",
    },
    {
      id: "oi",
      label: "Open interest",
      ok: okAge(oiAge, 90_000),
      detail: oiAge != null ? `${Math.round(oiAge / 1000)}s since poll` : "Not polled yet",
    },
    {
      id: "funding",
      label: "Funding rate",
      ok: funding?.current != null,
      detail: funding?.current != null ? `z=${Number(funding.zscore ?? 0).toFixed(2)} · ${funding.bias}` : "Pending",
    },
    {
      id: "tick_engine",
      label: "Tick executor",
      ok: !microEventLiveTickEnabled || tickEngineRunning,
      detail: microEventLiveTickEnabled
        ? tickEngineRunning
          ? "Running"
          : "Start bot to activate"
        : "Disabled (enable Live tick in config)",
    },
  ];

  const allOk = rows.every((r) => r.id === "tick_engine" || r.ok);
  const criticalOk = rows.filter((r) => r.id !== "funding" && r.id !== "oi").every((r) => r.ok || r.id === "tick_engine");

  return {
    symbol: sym,
    watchSymbols,
    ok: allOk,
    autotradeEligible: criticalOk && liqSt.ok,
    rows,
    liqStream: liqSt,
    updatedAt: Date.now(),
  };
}
