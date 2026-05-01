// Reads from the existing in-memory order book — no external API call
export const orderBookCollector = {
  collect(symbols, cache) {
    const results = {};
    for (const symbol of symbols) {
      try {
        const book = cache.depthSnapshots?.[symbol];
        if (!book || !Array.isArray(book.bids) || !Array.isArray(book.asks)) continue;

        const bids20 = book.bids.slice(0, 20);
        const asks20 = book.asks.slice(0, 20);
        if (!bids20.length && !asks20.length) continue;

        const bidTotal = bids20.reduce((s, [, qty]) => s + parseFloat(qty), 0);
        const askTotal = asks20.reduce((s, [, qty]) => s + parseFloat(qty), 0);
        const total = bidTotal + askTotal;

        const bigBid = bids20.length ? Math.max(...bids20.map(([, q]) => parseFloat(q))) : 0;
        const bigAsk = asks20.length ? Math.max(...asks20.map(([, q]) => parseFloat(q))) : 0;
        const price  = parseFloat(bids20[0]?.[0] ?? asks20[0]?.[0] ?? 0);

        results[symbol] = {
          imbalanceRatio: total > 0 ? bidTotal / total : 0.5,
          bidWallUsdt:    bigBid * price,
          askWallUsdt:    bigAsk * price,
          pressure:
            total <= 0 ? 'neutral' :
            bidTotal / total > 0.65 ? 'strong_buy'  :
            bidTotal / total < 0.35 ? 'strong_sell' : 'neutral',
        };
      } catch (err) {
        console.warn(`[book] ${symbol}:`, err.message);
      }
    }
    return results;
  }
};
