/**
 * Shared-account portfolio replay for multi-coin backtests.
 *
 * Per-coin simulations produce R-multiples (netPnl / initialRiskUsd). This module
 * merges them chronologically and compounds one shared equity curve — same pattern
 * as `backtest-portfolio-supertrend.mjs`.
 */

/**
 * @param {Object} args
 * @param {Array<{ ts: number, R: number, symbol: string, rawTrade: object }>} args.events Sorted by exit ts.
 * @param {number} args.startingUsdt
 * @param {number} args.riskFrac Risk fraction of equity per trade (e.g. 0.05 for 5%).
 * @param {number} [args.startTs] Equity curve anchor timestamp.
 * @returns {{ trades: object[], equityCurve: object[], finalEquity: number, maxDrawdownPct: number, perCoin: Record<string, { n: number, wins: number, netPnl: number }> }}
 */
export function portfolioReplay({ events, startingUsdt, riskFrac, startTs = null }) {
  const sorted = [...(events || [])].sort((a, b) => a.ts - b.ts);
  let eq = Math.max(1, Number(startingUsdt) || 1000);
  let peak = eq;
  let maxDD = 0;
  const rf = Math.max(0.0001, Number(riskFrac) || 0.01);
  const trades = [];
  const perCoin = {};
  const equityCurve = [];

  const anchorTs =
    startTs != null && Number.isFinite(Number(startTs))
      ? Number(startTs)
      : sorted[0]?.rawTrade?.entryTs != null
        ? Number(sorted[0].rawTrade.entryTs)
        : Date.now();
  equityCurve.push({ ts: anchorTs, equity: eq, drawdownPct: 0 });

  let tradeNum = 0;
  for (const ev of sorted) {
    const R = Number(ev.R);
    if (!Number.isFinite(R)) continue;
    const sym = String(ev.symbol || "");
    const orig = ev.rawTrade;
    if (!orig) continue;

    const equityBefore = eq;
    const scaledNet = equityBefore * R * rf;
    eq = equityBefore + scaledNet;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;

    const origNet = Number(orig.netPnl) || 0;
    const ratio = origNet !== 0 ? scaledNet / origNet : 1;

    tradeNum += 1;
    if (!perCoin[sym]) perCoin[sym] = { n: 0, wins: 0, netPnl: 0 };
    perCoin[sym].n += 1;
    perCoin[sym].netPnl += scaledNet;
    if (scaledNet > 0) perCoin[sym].wins += 1;

    const origEquity = Number(orig.equityAtEntry) || 1000;
    const eqRatio = origEquity > 0 ? equityBefore / origEquity : 1;

    trades.push({
      ...orig,
      tradeNumber: tradeNum,
      symbol: sym,
      netPnl: scaledNet,
      grossPnl: Number(orig.grossPnl ?? 0) * ratio,
      fees: Number(orig.fees ?? 0) * ratio,
      fundingPaid: Number(orig.fundingPaid ?? 0) * ratio,
      slippageCost: Number(orig.slippageCost ?? 0) * ratio,
      equityAtEntry: equityBefore,
      marginUsdt:
        orig.marginUsdt != null && Number.isFinite(Number(orig.marginUsdt))
          ? Number(orig.marginUsdt) * eqRatio
          : orig.marginUsdt ?? null,
    });

    const exitTs = Number(orig.exitTs ?? ev.ts);
    if (Number.isFinite(exitTs)) {
      equityCurve.push({ ts: exitTs, equity: eq, drawdownPct: dd });
    }
  }

  return { trades, equityCurve, finalEquity: eq, maxDrawdownPct: maxDD, perCoin };
}

/**
 * Dollar risk at entry for R-multiple conversion (portfolio replay).
 * Trail-only Supertrend exits often have initialRiskUsd=0 — fall back to equity × risk%.
 */
export function resolveTradeRiskUsd(t, riskPct = 5) {
  const slRisk = Number(t.initialRiskUsd) || 0;
  if (slRisk > 0) return slRisk;
  const entry = Number(t.entryPrice ?? t.entryFill);
  const stop = Number(t.initialSlPrice ?? t.slPrice);
  const qty = Math.abs(Number(t.qty) || 0);
  if (Number.isFinite(entry) && Number.isFinite(stop) && stop > 0 && qty > 0) {
    const distRisk = Math.abs(entry - stop) * qty;
    if (distRisk > 0) return distRisk;
  }
  const eq = Number(t.equityAtEntry) || 1000;
  return eq * (Math.max(0.01, Number(riskPct)) / 100);
}

/**
 * Convert per-coin simulation trades to R-multiple events.
 * @param {string} symbol
 * @param {object[]} simTrades
 * @param {number} [riskPct] — cfg riskPerTrade for fallback sizing
 * @returns {Array<{ ts: number, R: number, symbol: string, rawTrade: object }>}
 */
export function tradesToREvents(symbol, simTrades, riskPct = 5) {
  const out = [];
  for (const t of simTrades || []) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const risk = resolveTradeRiskUsd(t, riskPct);
    if (risk <= 0) continue;
    const R = Number(t.netPnl ?? 0) / risk;
    out.push({
      ts: Number(t.exitTs ?? t.entryTs),
      R,
      symbol,
      rawTrade: { ...t, symbol },
    });
  }
  return out;
}
