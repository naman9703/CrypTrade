/**
 * MLCTS — Binance-sourced feed health for layer UI indicators (OI, funding, order book).
 */
import { getOpenInterestFetchedAt, intelligenceCache } from "../intelligence/index.js";

/**
 * @param {{ symbol?: string }} ctx
 */
export function buildMlctsFeedStatus(ctx = {}) {
  const sym = String(ctx.symbol || "BTCUSDT").trim().toUpperCase();
  const symKey = sym.replace(/[^A-Za-z0-9]/g, "");

  const oiRow =
    intelligenceCache.openInterest?.[symKey] ??
    intelligenceCache.openInterest?.[sym] ??
    null;
  const oiFetchedAt = getOpenInterestFetchedAt(symKey) ?? getOpenInterestFetchedAt(sym);
  const oiOk = oiRow != null && Number(oiRow.usdt) > 0;
  const oiPending = !oiOk && (oiFetchedAt == null || Date.now() - oiFetchedAt < 90_000);

  const fundingRow =
    intelligenceCache.funding?.[symKey] ??
    intelligenceCache.funding?.[sym] ??
    null;
  const fundingOk = fundingRow != null && Number.isFinite(Number(fundingRow.current));
  const fundingPending = !fundingOk && fundingRow == null;

  const bookRow =
    intelligenceCache.orderBook?.[symKey] ??
    intelligenceCache.orderBook?.[sym] ??
    null;
  const bookOk = bookRow != null && Number.isFinite(Number(bookRow.imbalanceRatio));
  const bookPending = !bookOk && bookRow == null;

  return {
    symbol: sym,
    updatedAt: Date.now(),
    openInterest: {
      ok: oiOk,
      pending: oiPending,
      label: "Open interest",
      usdt: oiRow?.usdt ?? null,
      change4hPct: oiRow?.change4hPct ?? null,
      fetchedAt: oiFetchedAt,
    },
    funding: {
      ok: fundingOk,
      pending: fundingPending,
      label: "Funding rate",
      current: fundingRow?.current ?? null,
      zscore: fundingRow?.zscore ?? null,
    },
    orderBook: {
      ok: bookOk,
      pending: bookPending,
      label: "Order book",
      imbalanceRatio: bookRow?.imbalanceRatio ?? null,
    },
  };
}
