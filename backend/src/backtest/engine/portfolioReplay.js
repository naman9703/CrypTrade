/**
 * Shared-account portfolio replay for multi-coin backtests.
 *
 * Modes (see `portfolioPositionSizing.js`):
 * - EQUAL_SLICE_FULL_MARGIN — equal capital split; margin = per-coin slice (legacy default).
 * - EQUAL_SLICE_RISK_AT_SL — equal capital split; preserve RISK_AT_SL margin from unit sims.
 * - TOTAL_CAPITAL_RISK_AT_SL — unit sims sized vs full capital; skip overlapping later entries.
 *
 * **Legacy research:** `portfolioReplay` — R-multiple replay (risk% of total equity).
 */

import { resolvePortfolioPositionSizing } from "./portfolioPositionSizing.js";

/**
 * Chronological merge events (no R-multiple conversion).
 * @param {string} symbol
 * @param {object[]} simTrades
 * @returns {Array<{ ts: number, symbol: string, rawTrade: object }>}
 */
export function tradesToTimelineEvents(symbol, simTrades) {
  const out = [];
  for (const t of simTrades || []) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const ts = Number(t.exitTs ?? t.entryTs);
    if (!Number.isFinite(ts)) continue;
    out.push({ ts, symbol, rawTrade: { ...t, symbol } });
  }
  return out;
}

/**
 * Drop later entries that overlap an already-accepted open trade (first by entry time wins).
 * @param {Array<{ ts: number, symbol: string, rawTrade: object }>} events
 * @returns {{ kept: typeof events, skipped: number }}
 */
export function filterOverlappingEntriesFirstWins(events) {
  const candidates = [...(events || [])].sort((a, b) => {
    const ae = Number(a.rawTrade?.entryTs ?? a.ts);
    const be = Number(b.rawTrade?.entryTs ?? b.ts);
    if (ae !== be) return ae - be;
    const ax = Number(a.rawTrade?.exitTs ?? a.ts);
    const bx = Number(b.rawTrade?.exitTs ?? b.ts);
    if (ax !== bx) return ax - bx;
    return String(a.symbol).localeCompare(String(b.symbol));
  });

  /** @type {Array<{ entryTs: number, exitTs: number }>} */
  const open = [];
  const kept = [];
  let skipped = 0;

  for (const ev of candidates) {
    const orig = ev.rawTrade;
    if (!orig) continue;
    const entryTs = Number(orig.entryTs ?? ev.ts);
    const exitTs = Number(orig.exitTs ?? ev.ts);
    if (!Number.isFinite(entryTs) || !Number.isFinite(exitTs)) continue;

    for (let i = open.length - 1; i >= 0; i--) {
      if (open[i].exitTs <= entryTs) open.splice(i, 1);
    }

    const overlaps = open.some((o) => o.entryTs < exitTs && o.exitTs > entryTs);
    if (overlaps) {
      skipped += 1;
      continue;
    }
    open.push({ entryTs, exitTs });
    kept.push(ev);
  }

  return { kept, skipped };
}

/**
 * Equal-split / shared-capital portfolio replay.
 *
 * @param {Object} args
 * @param {Array<{ ts: number, symbol: string, rawTrade: object }>} args.events
 * @param {number} args.startingUsdt Shared account starting capital.
 * @param {number} args.coinCount Number of portfolio coins (equal split divisor).
 * @param {number} [args.perCoinUnitStart] Per-coin unit-sim start.
 * @param {number} [args.startTs] Equity curve anchor timestamp.
 * @param {string} [args.mode] Portfolio position sizing mode.
 * @returns {{ trades: object[], equityCurve: object[], finalEquity: number, maxDrawdownPct: number, perCoin: Record<string, { n: number, wins: number, netPnl: number }>, skippedOverlap: number, mode: string }}
 */
export function portfolioSliceReplay({
  events,
  startingUsdt,
  coinCount,
  perCoinUnitStart = null,
  startTs = null,
  mode = null,
}) {
  const sizingMode = resolvePortfolioPositionSizing({ portfolioPositionSizing: mode });
  const nCoins = Math.max(1, Math.floor(Number(coinCount) || 1));
  const startEq = Math.max(1, Number(startingUsdt) || 100);
  const unitStart =
    perCoinUnitStart != null && Number.isFinite(Number(perCoinUnitStart)) && Number(perCoinUnitStart) > 0
      ? Number(perCoinUnitStart)
      : sizingMode === "TOTAL_CAPITAL_RISK_AT_SL"
        ? startEq
        : startEq / nCoins;

  let working = events || [];
  let skippedOverlap = 0;
  if (sizingMode === "TOTAL_CAPITAL_RISK_AT_SL") {
    const filtered = filterOverlappingEntriesFirstWins(working);
    working = filtered.kept;
    skippedOverlap = filtered.skipped;
  }

  const sorted = [...working].sort((a, b) => a.ts - b.ts);
  const forceFullSliceMargin = sizingMode === "EQUAL_SLICE_FULL_MARGIN";
  const useEqualSliceScale = sizingMode !== "TOTAL_CAPITAL_RISK_AT_SL";

  let eq = startEq;
  let peak = eq;
  let maxDD = 0;
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
    const sym = String(ev.symbol || "");
    const orig = ev.rawTrade;
    if (!orig) continue;

    const equityBefore = eq;
    const origEquity = Number(orig.equityAtEntry);
    const unitEq = Number.isFinite(origEquity) && origEquity > 0 ? origEquity : unitStart;
    const perCoinCap = equityBefore / nCoins;

    let scale;
    let eqRatio;
    if (useEqualSliceScale) {
      scale = unitEq > 0 ? perCoinCap / unitEq : 1;
      eqRatio = unitEq > 0 ? equityBefore / unitEq : 1;
    } else {
      scale = unitEq > 0 ? equityBefore / unitEq : 1;
      eqRatio = scale;
    }

    const origNet = Number(orig.netPnl) || 0;
    const scaledNet = origNet * scale;
    eq = equityBefore + scaledNet;
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDD) maxDD = dd;

    tradeNum += 1;
    if (!perCoin[sym]) perCoin[sym] = { n: 0, wins: 0, netPnl: 0 };
    perCoin[sym].n += 1;
    perCoin[sym].netPnl += scaledNet;
    if (scaledNet > 0) perCoin[sym].wins += 1;

    const origQty = Number(orig.qty);
    const scaledQty = Number.isFinite(origQty) ? origQty * scale : orig.qty;

    const origMargin = Number(orig.marginUsdt);
    let marginUsdt;
    if (forceFullSliceMargin) {
      marginUsdt = perCoinCap;
    } else if (Number.isFinite(origMargin) && origMargin > 0) {
      marginUsdt = origMargin * scale;
    } else {
      marginUsdt = useEqualSliceScale ? perCoinCap : Math.max(0, equityBefore * 0.01);
    }

    trades.push({
      ...orig,
      tradeNumber: tradeNum,
      symbol: sym,
      qty: scaledQty,
      netPnl: scaledNet,
      grossPnl: Number(orig.grossPnl ?? 0) * scale,
      fees: Number(orig.fees ?? 0) * scale,
      fundingPaid: Number(orig.fundingPaid ?? 0) * scale,
      slippageCost: Number(orig.slippageCost ?? 0) * scale,
      initialRiskUsd:
        orig.initialRiskUsd != null && Number.isFinite(Number(orig.initialRiskUsd))
          ? Number(orig.initialRiskUsd) * scale
          : orig.initialRiskUsd ?? null,
      equityAtEntry: equityBefore,
      marginUsdt,
      leverageCapped: orig.leverageCapped === true,
      allotmentCapped: orig.allotmentCapped === true,
      marginCapUsdt: forceFullSliceMargin
        ? perCoinCap
        : orig.marginCapUsdt != null
          ? Number(orig.marginCapUsdt) * scale
          : marginUsdt,
      allowedPoolUsdt: orig.allowedPoolUsdt != null ? Number(orig.allowedPoolUsdt) * eqRatio : null,
      portfolioSlice: {
        coinCount: nCoins,
        perCoinCap: useEqualSliceScale ? perCoinCap : equityBefore,
        unitEquityAtEntry: unitEq,
        scale,
        mode: sizingMode,
      },
    });

    const exitTs = Number(orig.exitTs ?? ev.ts);
    if (Number.isFinite(exitTs)) {
      equityCurve.push({ ts: exitTs, equity: eq, drawdownPct: dd });
    }
  }

  return {
    trades,
    equityCurve,
    finalEquity: eq,
    maxDrawdownPct: maxDD,
    perCoin,
    skippedOverlap,
    mode: sizingMode,
  };
}

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
