import axios from 'axios';

const FAPI = 'https://fapi.binance.com';

export const fundingCollector = {
  async collect(symbols) {
    const results = {};
    for (const symbol of symbols) {
      try {
        const [rateRes, histRes, premRes] = await Promise.all([
          axios.get(`${FAPI}/fapi/v1/fundingRate`,
            { params: { symbol, limit: 1 }, timeout: 5000 }),
          axios.get(`${FAPI}/fapi/v1/fundingRate`,
            { params: { symbol, limit: 90 }, timeout: 5000 }),
          axios.get(`${FAPI}/fapi/v1/premiumIndex`,
            { params: { symbol }, timeout: 5000 }),
        ]);

        const rates   = histRes.data.map(r => parseFloat(r.fundingRate));
        const current = parseFloat(rateRes.data[0].fundingRate);
        const mean    = rates.reduce((a, b) => a + b, 0) / rates.length;
        const std     = Math.sqrt(
          rates.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / rates.length
        );

        results[symbol] = {
          current,
          avg30d:    mean,
          zscore:    std > 0 ? (current - mean) / std : 0,
          predicted: parseFloat(premRes.data.lastFundingRate ?? current),
          nextTime:  new Date(premRes.data.nextFundingTime),
          bias:
            current > mean * 2   ? 'extremely_long'  :
            current > mean * 1.5 ? 'crowded_long'    :
            current < mean * -1  ? 'crowded_short'   : 'neutral',
        };
      } catch (err) {
        console.warn(`[funding] ${symbol}:`, err.message);
      }
    }
    return results;
  }
};
