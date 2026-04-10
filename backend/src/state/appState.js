import { broadcastActivity } from "../lib/activityLog.js";
import { mergePersistedTradesWithExchange } from "../lib/activityPersistence.js";
import { setTradingModePersistenceSlug } from "../lib/tradingModePersistence.js";
import { createBot } from "./bot.js";
import { createAiClient } from "../svc/aiClient.js";
import { createExchange } from "./exchangeFactory.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

export function createAppState({ log }) {
  let mode = String(process.env.TRADING_MODE || "PAPER").toUpperCase();
  if (mode === "BINANCE_DEMO") {
    log?.warn?.("trading_mode_binance_demo_removed", {
      detail: "BINANCE_DEMO was removed; using PAPER. For a separate ledger, set PAPER_STORE_DIR (e.g. former BINANCE_DEMO_STORE_DIR path).",
    });
    mode = "PAPER";
  }
  if (mode === "BINANCE_DEMO_FUTURES") {
    log?.warn?.("trading_mode_binance_demo_futures_removed", {
      detail:
        "BINANCE_DEMO_FUTURES was removed; using BINANCE_DEMO_API (spot + demo futures / local futures sim). Set TRADING_MODE=BINANCE_DEMO_API.",
    });
    mode = "BINANCE_DEMO_API";
  }
  if (mode === "BINANCE_FUTURES_TESTNET") {
    log?.warn?.("trading_mode_binance_futures_testnet_merged", {
      detail:
        "BINANCE_FUTURES_TESTNET was merged into BINANCE_TESTNET (spot + futures testnet). Set TRADING_MODE=BINANCE_TESTNET.",
    });
    mode = "BINANCE_TESTNET";
  }
  setTradingModePersistenceSlug(mode);
  const ai = createAiClient({ baseUrl: process.env.AI_BASE_URL || "http://localhost:8001" });
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = path.resolve(__dirname, "..", "..", ".env");

  let exchange;
  try {
    exchange = createExchange({ mode, log });
  } catch (e) {
    log?.error?.("exchange_init_failed", { mode, error: String(e?.message || e) });
    if (mode === "BINANCE_LIVE") {
      log?.warn?.("exchange_init_fallback_paper", { fromMode: "BINANCE_LIVE" });
      mode = "PAPER";
      setTradingModePersistenceSlug(mode);
      exchange = createExchange({ mode: "PAPER", log });
    } else {
      throw e;
    }
  }

  const bot = createBot({
    log,
    ai,
    exchange,
    getTradingMode: () => mode,
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
      const requested = String(nextMode || "PAPER").toUpperCase();
      try {
        bot.saveTradingConfigToDisk?.();
      } catch {
        // ignore
      }
      const nextEx = createExchange({ mode: requested, log });
      setTradingModePersistenceSlug(requested);
      const prev = exchange;
      mode = requested;
      exchange = nextEx;
      bot.setExchange(exchange);
      try {
        bot.reloadTradingConfigFromDisk?.();
      } catch {
        // ignore
      }
      try {
        await prev?.close?.();
      } catch {
        // ignore
      }
      try {
        const acct = await exchange.getAccount().catch(() => null);
        const pos = await exchange.getPositions().catch(() => []);
        this.wsHub?.broadcast("state", { mode, ...this.bot.getPublicState(), account: acct, positions: pos });
        try {
          const tr = await exchange.getTrades().catch(() => []);
          const merged = mergePersistedTradesWithExchange(mode, tr || []);
          this.wsHub?.broadcast("trades_snapshot", { replace: true, trades: merged });
        } catch {
          /* ignore */
        }
        broadcastActivity(this.wsHub, {
          level: "info",
          msg: `Trading mode active · ${mode}`,
          category: "trading_mode",
          reason: "mode_changed",
          detail: { mode },
        });
      } catch {
        this.wsHub?.broadcast("state", { mode, ...this.bot.getPublicState(), account: null, positions: [] });
        broadcastActivity(this.wsHub, {
          level: "warn",
          msg: `Trading mode active · ${mode} (account/positions unavailable)`,
          category: "trading_mode",
          reason: "mode_changed_partial",
          detail: { mode },
        });
      }
      return { ok: true, mode };
    },
  };
}

