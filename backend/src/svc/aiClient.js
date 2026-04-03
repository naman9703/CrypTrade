import axios from "axios";

export function createAiClient({ baseUrl }) {
  const defaultTimeout = Math.max(1000, Number(process.env.AI_HTTP_TIMEOUT_MS || 15_000));
  const predictTimeout = Math.max(
    defaultTimeout,
    Number(process.env.AI_PREDICT_TIMEOUT_MS || 60_000),
  );

  const http = axios.create({
    baseURL: baseUrl,
    timeout: defaultTimeout,
  });

  return {
    baseUrl,
    async health() {
      const { data } = await http.get("/health", {
        timeout: Math.max(defaultTimeout, Number(process.env.AI_HEALTH_TIMEOUT_MS || 30_000)),
      });
      return data;
    },
    async predict({ symbol, timeframe, candles }) {
      const { data } = await http.post(
        "/predict",
        { symbol, timeframe, candles },
        { timeout: predictTimeout },
      );
      return data;
    },
    async feedback(payload) {
      const { data } = await http.post("/feedback", payload, { timeout: predictTimeout });
      return data;
    },
    async retrainFromFeedback({ minRows = 200 } = {}) {
      const { data } = await http.post("/retrain/from-feedback", { min_rows: minRows });
      return data;
    },
    async trainFromBinance({
      symbols = [
        "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
        "DOGEUSDT", "ADAUSDT", "AVAXUSDT", "DOTUSDT", "LINKUSDT",
      ],
      interval = "1m",
      candlesPerSymbol = 35000,
      horizon = 90,
      atrMult,
      rr,
      labelProfile,
      feeBps = 10,
    } = {}) {
      const body = {
        symbols,
        interval,
        candles_per_symbol: candlesPerSymbol,
        horizon,
        fee_bps: feeBps,
      };
      if (atrMult != null) body.atr_mult = atrMult;
      if (rr != null) body.rr = rr;
      if (labelProfile != null) body.label_profile = labelProfile;
      const { data } = await http.post("/train/from-binance", body, { timeout: 900_000 });
      return data;
    },
    /** Synthetic OHLCV — no Binance; finishes in ~1–3 min. Good when cloud IP cannot reach Binance. */
    async trainBootstrap(opts = {}) {
      const body = {};
      if (opts.rows != null) body.rows = opts.rows;
      if (opts.horizon != null) body.horizon = opts.horizon;
      if (opts.seed != null) body.seed = opts.seed;
      const sp = opts.startPrice ?? opts.start_price;
      if (sp != null) body.start_price = sp;
      const { data } = await http.post("/train/bootstrap", body, { timeout: 300_000 });
      return data;
    },
  };
}

