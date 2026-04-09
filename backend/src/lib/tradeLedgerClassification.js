import { isStrictBinanceAccountMode } from "./tradingModePersistence.js";

/** Unmatched Binance REALIZED_PNL rows materialized as synthetic CLOSE trades (see binanceLiveFuturesUsdM). */
export function isUnmatchedIncomeLedgerTrade(t) {
  if (!t || String(t.type) !== "CLOSE") return false;
  if (t.ledgerEvent === true) return true;
  if (String(t.strategy ?? "").toUpperCase() === "INCOME_LEDGER") return true;
  const meta = t.meta && typeof t.meta === "object" ? t.meta : {};
  if (meta.note === "realized_pnl_ledger_row") return true;
  if (meta.localEnforcement === true) return false;
  return false;
}

export function mergeIncludesUnmatchedIncomeLedger() {
  return String(process.env.BINANCE_LIVE_INCOME_INCLUDE_UNMATCHED || "0") === "1";
}

/** Drop persisted WS-audit ledger shards for strict Binance modes when excluding unmatched income (default). */
export function filterStrictPortfolioTradesAfterMerge(mode, rows) {
  if (!isStrictBinanceAccountMode(mode)) return rows;
  if (mergeIncludesUnmatchedIncomeLedger()) return rows;
  return (rows || []).filter((t) => !isUnmatchedIncomeLedgerTrade(t));
}
