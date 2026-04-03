import { createBot } from "./bot.js";
import { createAiClient } from "../svc/aiClient.js";
import { createExchange } from "./exchangeFactory.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

export function createAppState({ log }) {
  let mode = process.env.TRADING_MODE || "PAPER";
  const ai = createAiClient({ baseUrl: process.env.AI_BASE_URL || "http://localhost:8001" });
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = path.resolve(__dirname, "..", "..", ".env");

  let exchange = createExchange({ mode, log });

  const bot = createBot({
    log,
    ai,
    exchange,
    defaults: {
      symbol: process.env.DEFAULT_SYMBOL || "BTCUSDT",
      timeframe: process.env.DEFAULT_TIMEFRAME || "1m",
      aiThreshold: Number(process.env.AI_THRESHOLD || 0.55),
      riskPerTrade: Number(process.env.RISK_PER_TRADE || 0.01),
      maxDailyLoss: Number(process.env.MAX_DAILY_LOSS || 0.05),
    },
  });

  return {
    get mode() {
      return mode;
    },
    log,
    ai,
    get exchange() {
      return exchange;
    },
    bot,
    // WebSocket hub is attached later
    wsHub: null,
    async setMode(nextMode) {
      // Reload backend/.env so keys edited on disk take effect without restart.
      // This is safe in personal-use setups, but avoid in multi-tenant servers.
      dotenv.config({ path: envPath, override: true });
      mode = String(nextMode || "PAPER").toUpperCase();
      try {
        await exchange?.close?.();
      } catch {
        // ignore
      }
      exchange = createExchange({ mode, log });
      bot.setExchange(exchange);
      try {
        const acct = await exchange.getAccount().catch(() => null);
        const pos = await exchange.getPositions().catch(() => []);
        this.wsHub?.broadcast("state", { mode, ...this.bot.getPublicState(), account: acct, positions: pos });
        this.wsHub?.broadcast("log", { level: "warn", msg: "Trading mode switched", mode });
      } catch {
        this.wsHub?.broadcast("state", { mode, ...this.bot.getPublicState(), account: null, positions: [] });
      }
      return { ok: true, mode };
    },
  };
}

