/**
 * Build CSV string for backtest trades (table columns + ML/TA features).
 */
import { computeFeaturesForTrades } from "./tradeCsvFeatures.js";
import { formatTsIST, resolveTradeEntryFillMs, resolveTradeExitFillMs } from "./tradeCsvTime.js";

const MIN_REL_RISK = 1e-5;

/** Core columns always exported (Liq* appended only when any trade has liq context). */
export const CSV_COLUMNS = [
  "#",
  "Coin",
  "Side",
  "Entry (IST)",
  "Exit (IST)",
  "Bars",
  "Margin",
  "Equity",
  "Gross",
  "Funding",
  "Net",
  "RR",
  "MAE %",
  "MFE %",
  "Reason",
  "Entry price",
  "Exit price",
  "Initial SL",
  "Initial TP",
  "Qty",
  "Fees",
  "Slippage",
  "Trail tier",
  "Gate",
  "Structure",
  "Pattern",
  "Entry reason",
  "Intel score at entry",
  "ATR14",
  "ATR14 %",
  "ATR percentile (100)",
  "ADX14",
  "RSI14",
  "EMA20",
  "EMA50",
  "EMA200",
  "Dist to EMA20 %",
  "Dist to EMA50 %",
  "Dist to EMA200 %",
  "EMA stack",
  "Volume",
  "Volume vs 20-avg",
  "Body %",
  "Upper wick %",
  "Lower wick %",
  "Swing high",
  "Dist to swing high %",
  "Swing low",
  "Dist to swing low %",
  "Entry hour (UTC)",
  "Entry hour (IST)",
  "Entry weekday",
  "Session",
  "Range lowest price",
  "Range highest price",
  "Bars to SL touch",
];

export const LIQ_CSV_COLUMNS = ["Liq ADX", "Liq ATR %", "Liq regime", "Liq confidence"];

function resolveInitialStopPrice(trade, entry) {
  const initial = Number(trade.initialSlPrice);
  if (Number.isFinite(initial) && initial > 0) return initial;
  const sl = Number(trade.slPrice);
  if (Number.isFinite(sl) && sl > 0 && Math.abs(entry - sl) / entry > MIN_REL_RISK) return sl;
  return null;
}

export function computeTradePriceRr(trade) {
  const entry = Number(trade.entryPrice);
  const exit = Number(trade.exitPrice);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exit)) return null;
  const isLong = String(trade.direction || "BUY").toUpperCase() === "BUY";
  const stop = resolveInitialStopPrice(trade, entry);
  if (stop == null) return null;
  const riskDist = isLong ? entry - stop : stop - entry;
  if (!Number.isFinite(riskDist) || riskDist <= entry * MIN_REL_RISK) return null;
  const rewardDist = isLong ? exit - entry : entry - exit;
  if (!Number.isFinite(rewardDist)) return null;
  return rewardDist / riskDist;
}

export function formatTradeRr(rr) {
  if (rr == null || !Number.isFinite(rr)) return "";
  const sign = rr > 0 ? "+" : "";
  return `${sign}${rr.toFixed(2)}`;
}

export function marginForTrade(trade, lev) {
  if (trade.marginUsdt != null && Number.isFinite(Number(trade.marginUsdt))) {
    return Number(trade.marginUsdt);
  }
  const ep = Number(trade.entryPrice);
  const qty = Number(trade.qty);
  if (!Number.isFinite(ep) || !Number.isFinite(qty) || ep <= 0 || qty <= 0) return null;
  const notional = Math.abs(qty) * ep;
  return lev > 0 ? notional / lev : notional;
}

function fmtNum(n, digits = 4) {
  if (n == null || !Number.isFinite(Number(n))) return "";
  return Number(n).toFixed(digits);
}

function fmtPrice(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  if (v >= 1000) return v.toFixed(2);
  if (v >= 1) return v.toFixed(4);
  return v.toFixed(6);
}

function fmtPct(n, digits = 1) {
  if (n == null || !Number.isFinite(Number(n))) return "";
  return Number(n).toFixed(digits);
}

export function csvEscape(value) {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function structureLabel(trade) {
  const eq = trade.entryQuality;
  if (!eq || typeof eq !== "object") return "";
  const risk = eq.structuralRisk != null ? String(eq.structuralRisk) : "";
  const block = eq.wouldBlock === true ? " ⛔" : "";
  return `${risk}${block}`.trim();
}

function isLongTrade(trade) {
  return String(trade.direction ?? "BUY").toUpperCase() === "BUY";
}

/** BUY → highest before SL; SELL → lowest before SL (other column left blank). */
function rangeLowestForCsv(trade, f) {
  if (isLongTrade(trade)) return "";
  return fmtPrice(f.rangeLowestPrice);
}

function rangeHighestForCsv(trade, f) {
  if (!isLongTrade(trade)) return "";
  return fmtPrice(f.rangeHighestPrice);
}

function flattenLiqFromTrade(trade) {
  const ctx = trade.liqContext;
  if (!ctx || typeof ctx !== "object") {
    return { liqAdx: null, liqAtrPct: null, liqRegime: null, liqConfidence: null };
  }
  const features = ctx.features && typeof ctx.features === "object" ? ctx.features : ctx;
  const ms =
    features.marketState && typeof features.marketState === "object" ? features.marketState : features;
  return {
    liqAdx: ms.adx != null && Number.isFinite(Number(ms.adx)) ? Number(ms.adx) : null,
    liqAtrPct: ms.atrPct != null && Number.isFinite(Number(ms.atrPct)) ? Number(ms.atrPct) : null,
    liqRegime: ms.regime != null ? String(ms.regime) : null,
    liqConfidence:
      ms.confidence != null && Number.isFinite(Number(ms.confidence)) ? Number(ms.confidence) : null,
  };
}

function mergedLiqFeatures(trade, f) {
  const fromCtx = flattenLiqFromTrade(trade);
  return {
    liqAdx: f.liqAdx ?? fromCtx.liqAdx,
    liqAtrPct: f.liqAtrPct ?? fromCtx.liqAtrPct,
    liqRegime: f.liqRegime ?? fromCtx.liqRegime,
    liqConfidence: f.liqConfidence ?? fromCtx.liqConfidence,
  };
}

export function tradeHasLiqData(trade, features) {
  const f = mergedLiqFeatures(trade, features ?? {});
  if (f.liqAdx != null) return true;
  if (f.liqAtrPct != null) return true;
  if (f.liqRegime != null && String(f.liqRegime).trim() !== "") return true;
  if (f.liqConfidence != null) return true;
  return false;
}

/** @returns {Record<string, string|number>} column header → cell value (pre-escape) */
function rowValuesByColumn(trade, features, run) {
  const lev = Math.max(1, Number(run.futuresLeverage) || 5);
  const tf = String(run.timeframe || "1h");
  const engineType = run.engineType ?? null;
  const rr = computeTradePriceRr(trade);
  const margin = marginForTrade(trade, lev);
  const entryMs = resolveTradeEntryFillMs(trade, tf, engineType);
  const exitMs = resolveTradeExitFillMs(trade, tf);
  const f = features ?? {};
  const liq = mergedLiqFeatures(trade, f);
  const coin = trade.symbol != null ? String(trade.symbol).replace(/USDT$/i, "") : "";

  return {
    "#": trade.tradeNumber,
    Coin: coin,
    Side: trade.direction ?? "",
    "Entry (IST)": Number.isFinite(entryMs) ? formatTsIST(entryMs) : "",
    "Exit (IST)": Number.isFinite(exitMs) ? formatTsIST(exitMs) : "",
    Bars: trade.barsHeld ?? "",
    Margin: margin != null ? fmtNum(margin, 2) : "",
    Equity: trade.equityAtEntry != null ? fmtNum(trade.equityAtEntry, 2) : "",
    Gross: fmtNum(trade.grossPnl, 2),
    Funding: fmtNum(trade.fundingPaid, 2),
    Net: fmtNum(trade.netPnl, 2),
    RR: formatTradeRr(rr),
    "MAE %": fmtPct(trade.maePct, 1),
    "MFE %": fmtPct(trade.mfePct, 1),
    Reason: trade.exitReason ?? "",
    "Entry price": fmtPrice(trade.entryPrice),
    "Exit price": fmtPrice(trade.exitPrice),
    "Initial SL": fmtPrice(trade.initialSlPrice ?? trade.slPrice),
    "Initial TP": fmtPrice(trade.tpPrice),
    Qty: fmtNum(trade.qty, 6),
    Fees: fmtNum(trade.fees, 2),
    Slippage: fmtNum(trade.slippageCost, 2),
    "Trail tier": trade.trailTierLabel ?? "",
    Gate: trade.gateAction ?? "",
    Structure: structureLabel(trade),
    Pattern: trade.lossPattern && Number(trade.netPnl) < 0 ? trade.lossPattern : "",
    "Entry reason": trade.entryReason ?? "",
    "Intel score at entry": trade.intelScoreAtEntry != null ? fmtNum(trade.intelScoreAtEntry, 3) : "",
    ATR14: fmtPrice(f.atr14),
    "ATR14 %": fmtPct(f.atr14Pct, 3),
    "ATR percentile (100)": f.atrPercentile != null ? fmtPct(f.atrPercentile, 1) : "",
    ADX14: fmtPct(f.adx14, 1),
    RSI14: fmtPct(f.rsi14, 1),
    EMA20: fmtPrice(f.ema20),
    EMA50: fmtPrice(f.ema50),
    EMA200: fmtPrice(f.ema200),
    "Dist to EMA20 %": fmtPct(f.distToEma20Pct, 3),
    "Dist to EMA50 %": fmtPct(f.distToEma50Pct, 3),
    "Dist to EMA200 %": fmtPct(f.distToEma200Pct, 3),
    "EMA stack": f.emaStack ?? "",
    Volume: f.volume != null ? fmtNum(f.volume, 2) : "",
    "Volume vs 20-avg": f.volVsAvg20 != null ? fmtNum(f.volVsAvg20, 3) : "",
    "Body %": fmtPct(f.bodyPct, 1),
    "Upper wick %": fmtPct(f.upperWickPct, 1),
    "Lower wick %": fmtPct(f.lowerWickPct, 1),
    "Swing high": fmtPrice(f.swingHigh),
    "Dist to swing high %": fmtPct(f.distToSwingHighPct, 3),
    "Swing low": fmtPrice(f.swingLow),
    "Dist to swing low %": fmtPct(f.distToSwingLowPct, 3),
    "Entry hour (UTC)": f.entryHourUtc != null ? String(f.entryHourUtc) : "",
    "Entry hour (IST)": f.entryHourIst != null ? String(f.entryHourIst) : "",
    "Entry weekday": f.entryWeekday ?? "",
    Session: f.session ?? "",
    "Range lowest price": rangeLowestForCsv(trade, f),
    "Range highest price": rangeHighestForCsv(trade, f),
    "Bars to SL touch": f.barsToSlTouch != null ? String(f.barsToSlTouch) : "",
    "Liq ADX": liq.liqAdx != null ? fmtPct(liq.liqAdx, 1) : "",
    "Liq ATR %": liq.liqAtrPct != null ? fmtPct(liq.liqAtrPct, 3) : "",
    "Liq regime": liq.liqRegime ?? "",
    "Liq confidence": liq.liqConfidence != null ? fmtNum(liq.liqConfidence, 3) : "",
  };
}

export function resolveCsvColumns(trades, featuresByTrade) {
  const includeLiq = trades.some((t) =>
    tradeHasLiqData(t, featuresByTrade[t.tradeNumber] ?? {}),
  );
  return includeLiq ? [...CSV_COLUMNS, ...LIQ_CSV_COLUMNS] : [...CSV_COLUMNS];
}

function resolveMarketFromRun(run) {
  const snap = run.configSnapshot;
  const bot =
    snap?.bot && typeof snap.bot === "object" && !Array.isArray(snap.bot)
      ? snap.bot
      : snap && typeof snap === "object"
        ? snap
        : {};
  const mm = String(bot.marketMode ?? bot.market ?? "FUTURES").toUpperCase();
  return mm === "SPOT" ? "spot" : "futures";
}

function resolveFuturesLeverage(run) {
  const snap = run.configSnapshot;
  const bot =
    snap?.bot && typeof snap.bot === "object" && !Array.isArray(snap.bot)
      ? snap.bot
      : snap && typeof snap === "object"
        ? snap
        : {};
  const lev = Number(bot.futuresLeverage ?? bot.leverage);
  return Number.isFinite(lev) && lev > 0 ? lev : 5;
}

/**
 * @param {Record<string, unknown>} run — mapped run row (needs symbol, timeframe, configSnapshot, engineType)
 * @param {Array<Record<string, unknown>>} trades — mapped trade rows
 */
export async function buildTradesCsv(run, trades) {
  const runCtx = {
    timeframe: String(run.timeframe || "1h"),
    symbol: String(run.symbol || "BTCUSDT"),
    engineType: run.engineType ?? null,
    futuresLeverage: resolveFuturesLeverage(run),
  };

  const featuresByTrade = await computeFeaturesForTrades(trades, {
    timeframe: runCtx.timeframe,
    market: resolveMarketFromRun(run),
    symbol: runCtx.symbol,
  });

  const columns = resolveCsvColumns(trades, featuresByTrade);
  const header = columns.map(csvEscape).join(",");
  const lines = trades.map((t) => {
    const values = rowValuesByColumn(t, featuresByTrade[t.tradeNumber] ?? {}, runCtx);
    return columns.map((col) => csvEscape(values[col] ?? "")).join(",");
  });
  return [header, ...lines].join("\n");
}
