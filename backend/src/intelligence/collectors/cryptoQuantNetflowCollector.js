import axios from 'axios';
import { getResolvedMarketIntelApis } from '../marketIntelResolvedApis.js';

const CQ_BASE = 'https://api.cryptoquant.com/v1';

/** Futures symbols → CryptoQuant asset slug for `/v1/{slug}/exchange-flows/netflow`. */
const ASSET_BY_SYMBOL = {
  BTCUSDT: 'btc',
  ETHUSDT: 'eth',
};

/**
 * Latest daily exchange netflow from CryptoQuant, scaled to USD using Binance spot last price.
 * Requires `CRYPTOQUANT_API_KEY` (Bearer). No key → empty object (caller keeps taker-only flow).
 *
 * @param {string[]} symbols e.g. ['BTCUSDT']
 * @returns {Promise<Record<string, number>>}
 */
export async function fetchCryptoQuantNetflowUsdBySymbol(symbols) {
  const key = getResolvedMarketIntelApis().cryptoquantApiKey;
  if (!key) return {};

  const exchange = process.env.CRYPTOQUANT_EXCHANGE_ENTITY?.trim() || 'all_exchange';
  const out = {};

  for (const symbol of symbols) {
    const sym = String(symbol || '').trim().toUpperCase();
    const asset = ASSET_BY_SYMBOL[sym];
    if (!asset) continue;

    try {
      const [cqRes, pxRes] = await Promise.all([
        axios.get(`${CQ_BASE}/${asset}/exchange-flows/netflow`, {
          headers: { Authorization: `Bearer ${key}` },
          params: { exchange, window: 'day', limit: 2 },
          timeout: 15000,
        }),
        axios.get('https://api.binance.com/api/v3/ticker/price', {
          params: { symbol: sym },
          timeout: 8000,
        }),
      ]);

      const rows = cqRes.data?.result?.data;
      const last = Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null;
      const native = last?.netflow_total != null ? Number(last.netflow_total) : NaN;
      const px = parseFloat(pxRes.data?.price);

      if (Number.isFinite(native) && Number.isFinite(px) && px > 0) {
        out[sym] = native * px;
      }
    } catch (err) {
      console.warn(`[cryptoquant] ${sym}:`, err.message);
    }
  }

  return out;
}
