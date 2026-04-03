import axios from "axios";

const BASE = "https://api.coingecko.com/api/v3";

export function createCoinGeckoClient({ log, baseUrl } = {}) {
  const http = axios.create({
    baseURL: baseUrl || process.env.COINGECKO_BASE_URL || BASE,
    timeout: 10_000,
    headers: { accept: "application/json" },
  });

  function mapSymbolToCoinId(symbol) {
    // Minimal mapping for common majors; extend as needed.
    const s = String(symbol || "").toUpperCase();
    const base = s.endsWith("USDT") ? s.slice(0, -4) : s;
    const m = {
      BTC: "bitcoin",
      ETH: "ethereum",
      SOL: "solana",
      BNB: "binancecoin",
      XRP: "ripple",
      DOGE: "dogecoin",
      ADA: "cardano",
      TRX: "tron",
      AVAX: "avalanche-2",
      LINK: "chainlink",
    };
    return m[base] || null;
  }

  return {
    async marketContext({ symbol }) {
      const id = mapSymbolToCoinId(symbol);
      if (!id) return { ok: false, error: "unknown_symbol_mapping" };
      try {
        const { data } = await http.get(`/coins/${encodeURIComponent(id)}`, {
          params: {
            localization: "false",
            tickers: "false",
            market_data: "true",
            community_data: "false",
            developer_data: "false",
            sparkline: "false",
          },
        });
        const md = data?.market_data || {};
        return {
          ok: true,
          source: "coingecko",
          coinId: id,
          symbol: String(symbol || "").toUpperCase(),
          asOf: new Date().toISOString(),
          market: {
            marketCapUsd: md?.market_cap?.usd ?? null,
            volume24hUsd: md?.total_volume?.usd ?? null,
            change24hPct: md?.price_change_percentage_24h_in_currency?.usd ?? md?.price_change_percentage_24h ?? null,
            athUsd: md?.ath?.usd ?? null,
          },
        };
      } catch (e) {
        log?.warn?.("coingecko_fetch_failed", { error: String(e?.message || e) });
        return { ok: false, error: "coingecko_fetch_failed" };
      }
    },
  };
}

