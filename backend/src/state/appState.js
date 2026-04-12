import { broadcastActivity } from "../lib/activityLog.js";
import { mergePersistedTradesWithExchange } from "../lib/activityPersistence.js";
import { setTradingModePersistenceSlug, tradingModeToPersistenceSlug } from "../lib/tradingModePersistence.js";
import { createBot } from "./bot.js";
import { createAiClient } from "../svc/aiClient.js";
import { createExchange } from "./exchangeFactory.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

/** Modes that can run as isolated engines (parallel bot + exchange). */
export const ENGINE_TRADING_MODES = ["PAPER", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_LIVE"];

export function normalizeTradingMode(raw) {
  let m = String(raw || "PAPER").toUpperCase();
  if (m === "BINANCE_DEMO") m = "PAPER";
  if (m === "BINANCE_DEMO_FUTURES") m = "BINANCE_DEMO_API";
  if (m === "BINANCE_FUTURES_TESTNET") m = "BINANCE_TESTNET";
  return m;
}

export function createAppState({ log }) {
  let mode = normalizeTradingMode(process.env.TRADING_MODE || "PAPER");
  setTradingModePersistenceSlug(mode);
  const ai = createAiClient({ baseUrl: process.env.AI_BASE_URL || "http://localhost:8001" });
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const envPath = path.resolve(__dirname, "..", "..", ".env");

  /** @type {{ hub: { broadcast?: (type: string, payload: unknown) => void } | null }} */
  const wsHubHolder = { hub: null };

  /** @type {Map<string, { bot: ReturnType<typeof createBot>; exchange: unknown }>} */
  const engines = new Map();

  function ensureEngine(tradingMode) {
    const m = normalizeTradingMode(tradingMode);
    if (!ENGINE_TRADING_MODES.includes(m)) {
      throw new Error(`unsupported_trading_mode:${m}`);
    }
    if (engines.has(m)) return engines.get(m);
    const exchange = createExchange({ mode: m, log });
    const persistenceSlug = tradingModeToPersistenceSlug(m);
    const bot = createBot({
      log,
      ai,
      exchange,
      getTradingMode: () => m,
      persistenceSlug,
      defaults: {
        symbol: process.env.DEFAULT_SYMBOL || "BTCUSDT",
        timeframe: process.env.DEFAULT_TIMEFRAME || "1m",
        aiThreshold: Number(process.env.AI_THRESHOLD || 0.55),
        riskPerTrade: Number(process.env.RISK_PER_TRADE || 0.01),
        maxDailyLoss: Number(process.env.MAX_DAILY_LOSS || 0.05),
      },
    });
    const row = { bot, exchange };
    engines.set(m, row);
    try {
      if (wsHubHolder.hub) bot.setWsHub?.(wsHubHolder.hub);
    } catch {
      /* ignore */
    }
    return row;
  }

  try {
    ensureEngine(mode);
  } catch (e) {
    log?.error?.("exchange_init_failed", { mode, error: String(e?.message || e) });
    if (mode === "BINANCE_LIVE") {
      log?.warn?.("exchange_init_fallback_paper", { fromMode: "BINANCE_LIVE" });
      mode = "PAPER";
      setTradingModePersistenceSlug(mode);
      ensureEngine(mode);
    } else {
      throw e;
    }
  }

  return {
    get mode() {
      return mode;
    },
    log,
    ai,
    get exchange() {
      return engines.get(mode)?.exchange;
    },
    get bot() {
      return engines.get(mode)?.bot;
    },
    wsHub: null,
    engines,
    ensureEngine,
    getEngine(m) {
      return engines.get(normalizeTradingMode(m)) ?? null;
    },
    getRunningByMode() {
      const out = {};
      for (const m of ENGINE_TRADING_MODES) {
        const row = engines.get(m);
        if (!row) continue;
        try {
          out[m] = Boolean(row.bot.getPublicState?.()?.running);
        } catch {
          out[m] = false;
        }
      }
      return out;
    },
    wireAllEnginesToWsHub(hub) {
      this.wsHub = hub;
      wsHubHolder.hub = hub;
      for (const { bot: b } of engines.values()) {
        try {
          b.setWsHub?.(hub);
        } catch {
          /* ignore */
        }
      }
    },
    async setMode(nextMode) {
      dotenv.config({ path: envPath, override: true });
      const requested = normalizeTradingMode(nextMode);
      try {
        this.bot.saveTradingConfigToDisk?.();
      } catch {
        // ignore
      }
      const prevMode = mode;
      setTradingModePersistenceSlug(requested);
      mode = requested;
      let row = engines.get(mode);
      if (!row) {
        try {
          row = ensureEngine(mode);
        } catch (e) {
          mode = prevMode;
          setTradingModePersistenceSlug(mode);
          if (requested === "BINANCE_LIVE") {
            log?.warn?.("mode_switch_live_failed", { error: String(e?.message || e) });
          }
          throw e;
        }
      } else {
        try {
          row.bot.reloadTradingConfigFromDisk?.();
        } catch {
          // ignore
        }
      }
      const exchange = row.exchange;
      try {
        const acct = await exchange.getAccount().catch(() => null);
        const pos = await exchange.getPositions().catch(() => []);
        this.wsHub?.broadcast("state", { mode, ...row.bot.getPublicState(), account: acct, positions: pos });
        try {
          const tr = await exchange.getTrades().catch(() => []);
          const merged = mergePersistedTradesWithExchange(mode, tr || []);
          this.wsHub?.broadcast("trades_snapshot", { replace: true, trades: merged, mode });
        } catch {
          /* ignore */
        }
        broadcastActivity(this.wsHub, {
          level: "info",
          msg: `Trading mode active · ${mode}`,
          category: "trading_mode",
          reason: "mode_changed",
          detail: { mode, parallelEngines: true },
        });
      } catch {
        this.wsHub?.broadcast("state", { mode, ...row.bot.getPublicState(), account: null, positions: [] });
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
