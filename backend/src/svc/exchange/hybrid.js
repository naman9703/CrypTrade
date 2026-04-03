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

      // Primary account fields remain for backward compatibility with UI.
      // Prefer spot as "primary" if present.
      const primary = spotAcc || futAcc || { equity: 0, freeBalance: 0, dailyStartEquity: null, dailyPnlPct: 0 };
      return {
        ...primary,
        venues: {
          spot: spotAcc,
          futures: futAcc,
        },
      };
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
    async placeOrder() {
      throw new Error("hybrid_place_order_not_supported_directly");
    },
    async closePosition(args) {
      if (spot?.closePosition) {
        try {
          const r = await spot.closePosition(args);
          if (r?.ok) return r;
        } catch (e) {
          log?.warn?.("hybrid_spot_close_failed", { error: String(e?.message || e) });
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

