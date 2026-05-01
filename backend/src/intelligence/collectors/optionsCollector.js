import axios from 'axios';

const DERIBIT      = 'https://www.deribit.com/api/v2/public';
/** Keep in sync with `frontend/src/ui/intelligence/OptionsCard.tsx` (BTC/ETH only until Deribit lists more perps). */
const CURRENCY_MAP = { BTCUSDT: 'BTC', ETHUSDT: 'ETH' };

export const optionsCollector = {
  async collect(symbols) {
    const results = {};
    for (const symbol of symbols) {
      const currency = CURRENCY_MAP[symbol];
      if (!currency) continue;
      try {
        const [summary, ticker] = await Promise.all([
          axios.get(`${DERIBIT}/get_book_summary_by_currency`,
            { params: { currency, kind: 'option' }, timeout: 8000 }),
          axios.get(`${DERIBIT}/ticker`,
            { params: { instrument_name: `${currency}-PERPETUAL` }, timeout: 5000 }),
        ]);

        const options      = summary.data.result ?? [];
        const currentPrice = ticker.data.result?.mark_price ?? 0;
        if (!currentPrice || !options.length) continue;

        const maxPain = computeMaxPain(options);
        const puts    = options.filter(o => o.instrument_name.endsWith('-P'));
        const calls   = options.filter(o => o.instrument_name.endsWith('-C'));
        const putVol  = puts.reduce((s, o)  => s + (o.volume ?? 0), 0);
        const callVol = calls.reduce((s, o) => s + (o.volume ?? 0), 0);
        const pcRatio = callVol > 0 ? putVol / callVol : 1;
        const gex     = computeGEX(options, currentPrice);

        const strikes = options
          .map(o => parseFloat(o.instrument_name.split('-')[2]))
          .filter(s => !isNaN(s));
        if (!strikes.length) continue;
        const atmStrike = strikes.reduce((prev, curr) =>
          Math.abs(curr - currentPrice) < Math.abs(prev - currentPrice) ? curr : prev,
          strikes[0]
        );
        const atmOpt = options.find(o => o.instrument_name.includes(`-${atmStrike}-`));

        results[symbol] = {
          maxPain,
          maxPainDistance: ((maxPain - currentPrice) / currentPrice) * 100,
          putCallRatio:    pcRatio,
          impliedVol:      atmOpt?.mark_iv ?? null,
          gex,
          gexRegime: gex > 0 ? 'positive_stabilising' : 'negative_amplifying',
          bias:
            pcRatio > 0.7 ? 'bearish' :
            pcRatio < 0.4 ? 'bullish' : 'neutral',
        };
      } catch (err) {
        console.warn(`[options] ${symbol}:`, err.message);
      }
    }
    return results;
  }
};

function computeMaxPain(options) {
  const strikes = [...new Set(
    options
      .map(o => parseFloat(o.instrument_name.split('-')[2]))
      .filter(s => !isNaN(s))
  )].sort((a, b) => a - b);

  let minPain = Infinity, maxPainStrike = strikes[0] ?? 0;
  for (const strike of strikes) {
    let pain = 0;
    for (const opt of options) {
      const s   = parseFloat(opt.instrument_name.split('-')[2]);
      const oi  = opt.open_interest ?? 0;
      const isC = opt.instrument_name.endsWith('-C');
      const isP = opt.instrument_name.endsWith('-P');
      if (isC && strike > s) pain += (strike - s) * oi;
      if (isP && strike < s) pain += (s - strike) * oi;
    }
    if (pain < minPain) { minPain = pain; maxPainStrike = strike; }
  }
  return maxPainStrike;
}

function computeGEX(options, spot) {
  let gex = 0;
  for (const opt of options) {
    const gamma = opt.greeks?.gamma ?? 0;
    const oi    = opt.open_interest ?? 0;
    const isC   = opt.instrument_name.endsWith('-C');
    gex += (isC ? 1 : -1) * gamma * oi * spot * spot * 0.01;
  }
  return gex;
}
