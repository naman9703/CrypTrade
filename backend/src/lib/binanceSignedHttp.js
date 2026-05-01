/**
 * Shared helpers for Binance signed REST (spot + USD-M futures).
 * Reduces -1021 recvWindow / timestamp skew failures and avoids duplicating logic across connectors.
 */

/** Binance allows recvWindow up to 60000 ms. */
export function binanceRecvWindowMs() {
  const n = Number(process.env.BINANCE_RECV_WINDOW_MS ?? 60_000);
  if (!Number.isFinite(n)) return 60_000;
  return Math.max(5_000, Math.min(60_000, Math.floor(n)));
}

export function isBinanceRecvWindowOrTimestampError(err) {
  const s = String(err?.message || err || "");
  return s.includes(":-1021:") || s.includes("-1021") || /recvWindow|timestamp.*outside/i.test(s);
}

/**
 * Keeps `Date.now() + offsetMs` aligned with Binance `serverTime` from a public `/time` endpoint.
 * @param {{ log?: { info?: Function, warn?: Function }, tag?: string }} opts
 */
export function createBinanceServerTimeSkew(opts = {}) {
  const { log, tag = "binance" } = opts;
  let offsetMs = 0;
  let lastSyncAt = 0;
  const intervalMs = Math.max(5_000, Number(process.env.BINANCE_TIME_SYNC_INTERVAL_MS ?? 120_000));

  return {
    timestampMs: () => Date.now() + offsetMs,

    /** Next `ensureFresh` will run even if inside the interval. */
    invalidateSyncClock() {
      lastSyncAt = 0;
    },

    /**
     * @param {() => Promise<number>} fetchServerTimeMs
     * @param {boolean} [force]
     */
    async ensureFresh(fetchServerTimeMs, force = false) {
      const now = Date.now();
      if (!force && lastSyncAt > 0 && now - lastSyncAt < intervalMs) return;
      lastSyncAt = now;
      try {
        const serverMs = await fetchServerTimeMs();
        if (Number.isFinite(serverMs) && serverMs > 0) {
          offsetMs = serverMs - Date.now();
          if (force || Math.abs(offsetMs) > 1_500) {
            log?.info?.("binance_server_time_sync", { tag, offsetMs });
          }
        }
      } catch (e) {
        log?.warn?.("binance_server_time_sync_failed", { tag, error: String(e?.message || e) });
      }
    },
  };
}
