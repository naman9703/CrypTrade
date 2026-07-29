import { buildHybridAccountSnapshot } from "../../lib/hybridAccountEquity.js";

/** Error substrings that mean "credentials are wrong / missing" — not a transient network blip. */
const AUTH_ERR_PATTERNS = ["missing_keys", "-2014", "-2015", "api-key format", "invalid api-key", "invalid signature"];
function isAuthError(msg) {
  const m = String(msg || "").toLowerCase();
  return AUTH_ERR_PATTERNS.some((p) => m.includes(p));
}

export function createHybridExchange({ spot, futures, log }) {
  /** Keep last good leg snapshots so transient REST hiccups don't halve portfolio/equity in UI. */
  let lastSpotAcc = null;
  let lastFutAcc = null;
  /** Persistent auth-failure tracking so we surface a clear error instead of silent "—". */
  let futuresAuthErr = null;    // last auth-class error string
  let futuresAuthFailCount = 0; // consecutive auth failures (reset on success)
  /** Same idea for positions: avoid empty leg flips when one venue errors transiently. */
  let lastSpotPos = [];
  let lastFutPos = [];
  /**
   * Combined last-known-good positions array. Used when one or more legs fail AND the combined
   * result is empty — this prevents a transient 401/network error from wiping the positions table.
   * Updated whenever a combined result is non-empty, or when all legs succeed (even if empty).
   */
  let lastCombinedPositions = null;
  return {
    name: "hybrid",
    supportsAutoTrading: Boolean(spot?.supportsAutoTrading) || Boolean(futures?.supportsAutoTrading),
    spot,
    futures,
    async getAccount() {
      let spotAcc = null;
      let futAcc = null;
      try {
        if (spot?.getAccount) {
          spotAcc = await spot.getAccount();
          if (spotAcc != null) lastSpotAcc = spotAcc;
        }
      } catch (e) {
        log?.warn?.("hybrid_spot_account_failed", { error: String(e?.message || e) });
      }
      try {
        if (futures?.getAccount) {
          futAcc = await futures.getAccount();
          if (futAcc != null) {
            lastFutAcc = futAcc;
            futuresAuthErr = null;       // clear on success
            futuresAuthFailCount = 0;
          }
        }
      } catch (e) {
        const errStr = String(e?.message || e);
        log?.warn?.("hybrid_futures_account_failed", { error: errStr });
        if (isAuthError(errStr)) {
          futuresAuthFailCount++;
          // Only surface as permanent after 3 consecutive auth failures (avoids noise on transient 401s).
          if (futuresAuthFailCount >= 3) futuresAuthErr = errStr;
        }
      }

      /** Transient leg failure: reuse last known-good leg to avoid portfolio flicker/jumps. */
      if (spotAcc == null && lastSpotAcc != null) spotAcc = lastSpotAcc;
      if (futAcc == null && lastFutAcc != null) futAcc = lastFutAcc;

      const needSpot = typeof spot?.getAccount === "function";
      const needFut = typeof futures?.getAccount === "function";
      const spotOk = spotAcc != null;
      const futOk = futAcc != null;
      const primaryFieldsFrom =
        spotOk && futOk ? spotAcc : spotOk ? spotAcc : futOk ? futAcc : null;

      return buildHybridAccountSnapshot({
        spotAcc,
        futAcc,
        needSpot,
        needFut,
        primaryFieldsFrom: primaryFieldsFrom || {},
        futuresError: !futOk && futuresAuthErr ? futuresAuthErr : null,
      });
    },
    async getPositions() {
      const out = [];
      let spotPs = null;
      let futPs = null;
      let spotOk = false;
      let futOk = false;
      try {
        if (spot?.getPositions) {
          spotPs = await spot.getPositions();
          spotOk = true;
          if (Array.isArray(spotPs)) lastSpotPos = spotPs;
        }
      } catch (e) {
        log?.warn?.("hybrid_spot_positions_failed", { error: String(e?.message || e) });
      }
      try {
        if (futures?.getPositions) {
          futPs = await futures.getPositions();
          futOk = true;
          if (Array.isArray(futPs)) lastFutPos = futPs;
        }
      } catch (e) {
        log?.warn?.("hybrid_futures_positions_failed", { error: String(e?.message || e) });
      }
      if (!spotOk && lastSpotPos.length) spotPs = lastSpotPos;
      if (!futOk && lastFutPos.length) futPs = lastFutPos;
      if (Array.isArray(spotPs)) out.push(...spotPs.map((p) => ({ ...p, venue: "SPOT" })));
      if (Array.isArray(futPs)) out.push(...futPs.map((p) => ({ ...p, venue: "FUTURES" })));

      // Determine if any expected leg had a transient failure (didn't produce data this call).
      const futExpected = typeof futures?.getPositions === "function";
      const spotExpected = typeof spot?.getPositions === "function";
      const anyLegFailed = (futExpected && !futOk) || (spotExpected && !spotOk);

      if (out.length > 0) {
        // Always update combined cache whenever we have real data.
        lastCombinedPositions = out.slice();
      } else if (!anyLegFailed) {
        // All legs succeeded with genuinely empty result — update cache to reflect real empty.
        lastCombinedPositions = [];
      }
      // else: all legs failed or partial failure with empty result → keep lastCombinedPositions as-is.

      // If combined result is empty but a leg failed and we have a prior known-good snapshot, use it.
      const result = (out.length === 0 && anyLegFailed && lastCombinedPositions !== null && lastCombinedPositions.length > 0)
        ? lastCombinedPositions
        : out;

      return result;
    },
    async getTrades(opts = {}) {
      const out = [];
      try {
        if (spot?.getTrades) out.push(...(await spot.getTrades(opts)).map((t) => ({ ...t, venue: "SPOT" })));
      } catch (e) {
        log?.warn?.("hybrid_spot_trades_failed", { error: String(e?.message || e) });
      }
      try {
        if (futures?.getTrades) out.push(...(await futures.getTrades(opts)).map((t) => ({ ...t, venue: "FUTURES" })));
      } catch (e) {
        log?.warn?.("hybrid_futures_trades_failed", { error: String(e?.message || e) });
      }
      // Must not cap to a fixed small window — ingestClosedTrades uses trades.length vs lastTradeCount.
      return out.slice(-2000);
    },
    async getSymbolOrderConstraints({ symbol, venue }) {
      const sym = String(symbol || "").toUpperCase();
      const v = String(venue || "").toUpperCase();
      if (!sym) return { ok: false, error: "symbol_required" };
      if (v === "BOTH") {
        const legs = {};
        if (spot?.getSymbolOrderConstraints) {
          try {
            legs.spot = await spot.getSymbolOrderConstraints(sym);
          } catch (e) {
            legs.spot = { ok: false, error: String(e?.message || e) };
          }
        } else {
          legs.spot = { ok: false, error: "spot_leg_unavailable" };
        }
        if (futures?.getSymbolOrderConstraints) {
          try {
            legs.futures = await futures.getSymbolOrderConstraints(sym);
          } catch (e) {
            legs.futures = { ok: false, error: String(e?.message || e) };
          }
        } else {
          legs.futures = { ok: false, error: "futures_leg_unavailable" };
        }
        return { ok: true, symbol: sym, venue: "BOTH", legs };
      }
      if (v === "SPOT") {
        if (!spot?.getSymbolOrderConstraints) return { ok: false, symbol: sym, venue: "SPOT", error: "spot_unavailable" };
        try {
          return await spot.getSymbolOrderConstraints(sym);
        } catch (e) {
          return { ok: false, symbol: sym, venue: "SPOT", error: String(e?.message || e) };
        }
      }
      if (v === "FUTURES") {
        if (!futures?.getSymbolOrderConstraints) return { ok: false, symbol: sym, venue: "FUTURES", error: "futures_unavailable" };
        try {
          return await futures.getSymbolOrderConstraints(sym);
        } catch (e) {
          return { ok: false, symbol: sym, venue: "FUTURES", error: String(e?.message || e) };
        }
      }
      return { ok: false, error: "bad_venue", detail: "use SPOT, FUTURES, or BOTH" };
    },
    async placeOrder() {
      throw new Error("hybrid_place_order_not_supported_directly");
    },
    async closePosition(args) {
      if (spot?.closePosition) {
        try {
          const r = await spot.closePosition(args);
          if (r?.ok) return r;
          // Demo spot resolves by id; if missing here, try futures (different venue/id scheme).
          if (r?.error && r.error !== "not_found") return r;
        } catch (e) {
          log?.warn?.("hybrid_spot_close_failed", { error: String(e?.message || e) });
          return { ok: false, error: String(e?.message || e) };
        }
      }
      if (futures?.closePosition) {
        return await futures.closePosition(args);
      }
      return { ok: false, error: "close_not_supported" };
    },
    async markToMarket(args) {
      try {
        await spot?.markToMarket?.(args);
      } catch {
        // ignore
      }
      try {
        await futures?.markToMarket?.(args);
      } catch {
        // ignore
      }
    },
    recoverTrailingExtremeFromCandles(candlesBySymbol) {
      try {
        futures?.recoverTrailingExtremeFromCandles?.(candlesBySymbol);
      } catch {
        // ignore
      }
    },
    startRealtimeTrailingPoll(intervalMs) {
      try { futures?.startRealtimeTrailingPoll?.(intervalMs); } catch { /* ignore */ }
    },
    stopRealtimeTrailingPoll() {
      try { futures?.stopRealtimeTrailingPoll?.(); } catch { /* ignore */ }
    },
    updateRealtimeTrailingConfig(opts) {
      try { futures?.updateRealtimeTrailingConfig?.(opts); } catch { /* ignore */ }
    },
    async runRealtimePollOnce(opts) {
      try { await futures?.runRealtimePollOnce?.(opts); } catch { /* ignore */ }
    },
    async close() {
      try {
        await spot?.close?.();
      } catch {
        // ignore
      }
      try {
        await futures?.close?.();
      } catch {
        // ignore
      }
    },
    dispose() {
      try {
        spot?.dispose?.();
      } catch {
        /* ignore */
      }
      try {
        futures?.dispose?.();
      } catch {
        /* ignore */
      }
    },
    /** Futures USD-M user stream → bot can refresh positions table without waiting for tick interval. */
    subscribeAccountPush(cb) {
      if (typeof futures?.subscribeAccountPush === "function") return futures.subscribeAccountPush(cb);
      return () => {};
    },
    getStatus() {
      return {
        spot: spot?.getStatus?.() || null,
        futures: futures?.getStatus?.() || null,
      };
    },
    async reset({ confirm } = {}) {
      if (confirm !== true) return { ok: false, error: "confirm_required" };
      const out = { ok: true, spot: null, futures: null };
      if (typeof spot?.reset === "function") out.spot = await spot.reset({ confirm: true });
      if (typeof futures?.reset === "function") out.futures = await futures.reset({ confirm: true });
      log?.warn?.("hybrid_paper_reset", { dir: "spot+futures" });
      return out;
    },
  };
}

