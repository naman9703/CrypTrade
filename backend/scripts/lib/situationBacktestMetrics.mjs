/**
 * Consistent SITUATION_INTRADAY metrics — matches UI backtest worker (no date pad, equity return %).
 */

/** One exit leg's return as % of equity at entry (additive approx for attribution). */
export function tradeLegReturnPct(trade) {
  const eq = Number(trade.equityAtEntry);
  const net = Number(trade.netPnl ?? 0);
  return eq > 0 ? (net / eq) * 100 : 0;
}

/**
 * Group partial exits into one logical entry; pnlPct sums leg returns vs equity at entry.
 * @param {object[]} trades
 * @param {number} fromMs
 * @param {number} toMs
 */
export function aggregateSituationEntries(trades, fromMs, toMs) {
  const entries = new Map();
  for (const t of trades.filter((tr) => tr.entryTs >= fromMs && tr.entryTs < toMs)) {
    const k = `${t.entryTs}_${t.direction}`;
    if (!entries.has(k)) {
      entries.set(k, {
        ts: t.entryTs,
        dir: t.direction,
        pnlPct: 0,
        pnlUsdt: 0,
        reason: t.entryReason,
        situation: t.situation || "UNKNOWN",
        trigger: t.trigger || "unknown",
      });
    }
    const e = entries.get(k);
    e.pnlUsdt += Number(t.netPnl ?? 0);
    e.pnlPct += tradeLegReturnPct(t);
  }
  return [...entries.values()].sort((a, b) => a.ts - b.ts);
}
