import axios from 'axios';
import { fetchCryptoQuantNetflowUsdBySymbol } from './cryptoQuantNetflowCollector.js';

export const onChainCollector = {
  async collect(symbols) {
    const cqUsdBySym = await fetchCryptoQuantNetflowUsdBySymbol(symbols);
    const results = {};
    for (const symbol of symbols) {
      try {
        const [takerRes] = await Promise.all([
          axios.get('https://fapi.binance.com/futures/data/takerlongshortRatio', {
            params: { symbol, period: '1h', limit: 24 },
            timeout: 5000,
          }),
        ]);

        const data = takerRes.data;
        const latest = data[data.length - 1];

        const buyRatioNow = parseFloat(latest?.buyVol ?? 0);
        const sellRatioNow = parseFloat(latest?.sellVol ?? 0);
        const total = buyRatioNow + sellRatioNow;
        /** Binance taker buy–sell imbalance as % of volume (~[-100,100]). */
        const takerImbalancePct = total > 0 ? ((buyRatioNow - sellRatioNow) / total) * 100 : 0;

        const ratios = data.map(d => parseFloat(d.buyVol) - parseFloat(d.sellVol));
        const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
        const std = Math.sqrt(
          ratios.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / ratios.length,
        );
        const takerFlowZscore = std > 0 ? (ratios[ratios.length - 1] - mean) / std : 0;

        const cqUsd = cqUsdBySym[symbol];
        results[symbol] = {
          takerFlowImbalancePct: takerImbalancePct,
          takerFlowZscore,
          takerBuyRatio: total > 0 ? buyRatioNow / total : 0.5,
          cryptoQuantNetflowUsd24h:
            cqUsd != null && Number.isFinite(cqUsd) ? cqUsd : null,
          stablecoinInflow24h: 0,
        };
      } catch (err) {
        console.warn(`[onchain] ${symbol}:`, err.message);
      }
    }
    return results;
  },
};
