import axios from 'axios';

const FAPI = 'https://fapi.binance.com';

export const openInterestCollector = {
  async collect(symbols) {
    const results = {};
    for (const symbol of symbols) {
      try {
        const [current, hist4h, hist24h, lsRatio] = await Promise.all([
          axios.get(`${FAPI}/fapi/v1/openInterest`,
            { params: { symbol }, timeout: 5000 }),
          axios.get(`${FAPI}/futures/data/openInterestHist`,
            { params: { symbol, period: '1h', limit: 4 }, timeout: 5000 }),
          axios.get(`${FAPI}/futures/data/openInterestHist`,
            { params: { symbol, period: '1h', limit: 24 }, timeout: 5000 }),
          axios.get(`${FAPI}/futures/data/globalLongShortAccountRatio`,
            { params: { symbol, period: '1h', limit: 1 }, timeout: 5000 }),
        ]);

        const oiNow    = parseFloat(current.data.openInterest);
        const oi4hAgo  = parseFloat(hist4h.data[0]?.sumOpenInterest ?? oiNow);
        const oi24hAgo = parseFloat(hist24h.data[0]?.sumOpenInterest ?? oiNow);

        results[symbol] = {
          usdt:           oiNow,
          change4hPct:   ((oiNow - oi4hAgo)  / oi4hAgo)  * 100,
          change24hPct:  ((oiNow - oi24hAgo) / oi24hAgo) * 100,
          longShortRatio: parseFloat(lsRatio.data[0]?.longShortRatio ?? 1),
        };
      } catch (err) {
        console.warn(`[oi] ${symbol}:`, err.message);
      }
    }
    return results;
  }
};
