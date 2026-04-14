import { buildHybridAccountSnapshot } from "../../lib/hybridAccountEquity.js";

export function createHybridExchange({ spot, futures, log }) {
  return {
    name: "hybrid",
    supportsAutoTrading: Boolean(spot?.supportsAutoTrading) || Boolean(futures?.supportsAutoTrading),
    spot,
    futures,
    async getAccount() {
      let spotAcc = null;
      let futAcc = null;
      try {
        if (spot?.getAccount) spotAcc = await spot.getAccount();
      } catch (e) {
        log?.warn?.("hybrid_spot_account_failed", { error: String(e?.message || e) });
      }
      try {
        if (futures?.getAccount) futAcc = await futures.getAccount();
      } catch (e) {
        log?.warn?.("hybrid_futures_account_failed", { error: String(e?.message || e) });
      }

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
      });
    },
    async getPositions() {
      const out = [];
      try {
        if (spot?.getPositions) out.push(...(await spot.getPositions()).map((p) => ({ ...p, venue: "SPOT" })));
      } catch (e) {
        log?.warn?.("hybrid_spot_positions_failed", { error: String(e?.message || e) });
      }
      try {
        if (futures?.getPositions) out.push(...(await futures.getPositions()).map((p) => ({ ...p, venue: "FUTURES" })));
      } catch (e) {
        log?.warn?.("hybrid_futures_positions_failed", { error: String(e?.message || e) });
      }
      return out;
    },
    async getTrades() {
      const out = [];
      try {
        if (spot?.getTrades) out.push(...(await spot.getTrades()).map((t) => ({ ...t, venue: "SPOT" })));
      } catch (e) {
        log?.warn?.("hybrid_spot_trades_failed", { error: String(e?.message || e) });
      }
      try {
        if (futures?.getTrades) out.push(...(await futures.getTrades()).map((t) => ({ ...t, venue: "FUTURES" })));
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
    getStatus() {
      return {
        spot: spot?.getStatus?.() || null,
        futures: futures?.getStatus?.() || null,
      };
    },
  };
}

