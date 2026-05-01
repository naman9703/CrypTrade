import { broadcastActivity } from "../lib/activityLog.js";
import { mergePersistedTradesWithExchange } from "../lib/activityPersistence.js";
import { setTradingModePersistenceSlug, tradingModeToPersistenceSlug } from "../lib/tradingModePersistence.js";
import { createBot } from "./bot.js";
import { createAiClient } from "../svc/aiClient.js";
import { createExchange } from "./exchangeFactory.js";
import { getPaperSystemAccountId } from "../db/services/walletService.js";
import { getPool } from "../db/pool.js";
import * as strategyService from "../db/services/strategyService.js";
import * as instanceService from "../db/services/instanceService.js";
import { mergeInstanceIntoCfgRaw } from "../lib/strategyInstanceSplit.js";
import { getIntelligenceScore as _getIntelligenceScore } from "../intelligence/index.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

/** Modes that can run as isolated engines (parallel bot + exchange). */
export const ENGINE_TRADING_MODES = ["PAPER", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_LIVE"];

/** Persistence slug → TRADING_MODE (for invalidating engines when UI selects a DB account). */
const SLUG_TO_TRADING_MODE = {
  paper: "PAPER",
  demo_api: "BINANCE_DEMO_API",
  testnet: "BINANCE_TESTNET",
  live: "BINANCE_LIVE",
};

export function normalizeTradingMode(raw) {
  let m = String(raw || "PAPER").toUpperCase();
  if (m === "BINANCE_DEMO") m = "PAPER";
  if (m === "BINANCE_DEMO_FUTURES") m = "BINANCE_DEMO_API";
  if (m === "BINANCE_FUTURES_TESTNET") m = "BINANCE_TESTNET";
  return m;
}

/** `paper` never uses API accounts; other slugs need a selected DB account before bot/start (HTTP guard). */
export function modeSlugRequiresSelectedAccount(slug) {
  return String(slug || "").toLowerCase() !== "paper";
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

  /** Which credential source the engine row was built with: `paper` | `env` | account UUID */
  const engineCredentialBinding = new Map();

  const activeAccountByMode = {
    paper: null,
    demo_api: null,
    testnet: null,
    live: null,
  };

  /** Active strategy_versions.id per persistence slug; null = use bot-trading-config.json only. */
  const activeStrategyVersionByMode = {
    paper: null,
    demo_api: null,
    testnet: null,
    live: null,
  };

  /** Active bot_instances.id per persistence slug (Phase 3C); drives engine account + strategy when set. */
  const activeInstanceByMode = {
    paper: null,
    demo_api: null,
    testnet: null,
    live: null,
  };

  function credentialBindingKey(tradingMode) {
    const m = normalizeTradingMode(tradingMode);
    const slug = tradingModeToPersistenceSlug(m);
    const sv = activeStrategyVersionByMode[slug] || "file";
    const inst = activeInstanceByMode[slug] || "none";
    if (slug === "paper") return `paper:${sv}:${inst}`;
    const id = activeAccountByMode[slug];
    return `${id || "env"}:${sv}:${inst}`;
  }

  /**
   * @param {string} tradingMode
   */
  async function ensureEngine(tradingMode) {
    const m = normalizeTradingMode(tradingMode);
    if (!ENGINE_TRADING_MODES.includes(m)) {
      throw new Error(`unsupported_trading_mode:${m}`);
    }
    const wantBind = credentialBindingKey(m);
    if (engines.has(m) && engineCredentialBinding.get(m) === wantBind) {
      return engines.get(m);
    }
    if (engines.has(m)) {
      try { engines.get(m)?.exchange?.dispose?.(); } catch { /* ignore */ }
      try { engines.get(m)?.bot?.destroy?.(); } catch { /* ignore */ }
      engines.delete(m);
      engineCredentialBinding.delete(m);
    }
    const slug = tradingModeToPersistenceSlug(m);
    let exchangeAccountId = slug === "paper" ? null : activeAccountByMode[slug] || null;
    let dbAccountId = null;
    if (slug === "paper") {
      dbAccountId = await getPaperSystemAccountId();
    } else {
      dbAccountId = activeAccountByMode[slug] || null;
    }
    let strategyVersionId = activeStrategyVersionByMode[slug];
    /** Operational overrides from active instance (`inst_*` columns) merged into strategy cfg_raw at hydrate time. */
    let instanceOperationalConfig = null;
    const instId = activeInstanceByMode[slug];
    if (instId && getPool()) {
      try {
        const bind = await instanceService.getInstanceEngineBinding(String(instId));
        if (bind && !bind.isDeleted && bind.accountModeSlug === slug) {
          if (slug !== "paper") exchangeAccountId = bind.accountId;
          dbAccountId = bind.accountId;
          strategyVersionId = bind.strategyVersionId;
          instanceOperationalConfig = bind.operationalConfig ?? null;
        }
      } catch (e) {
        log?.warn?.("active_instance_binding_failed", { slug, error: String(e?.message || e) });
      }
    }
    const exchange = await createExchange({ mode: m, log, accountId: exchangeAccountId });
    const persistenceSlug = tradingModeToPersistenceSlug(m);
    let initialPersistedConfig = null;
    if (getPool()) {
      const vid = strategyVersionId;
      if (vid) {
        try {
          const ver = await strategyService.getVersion(vid);
          if (ver?.cfgRaw && typeof ver.cfgRaw === "object") initialPersistedConfig = ver.cfgRaw;
        } catch (e) {
          log?.warn?.("strategy_version_hydrate_failed", { slug, error: String(e?.message || e) });
        }
      }
    }
    // Merge instance operational overrides INTO the strategy's flat cfg before
    // handing it to the bot. The bot continues to consume a single flat config;
    // the split lives in the persistence/UI layer only.
    if (instanceOperationalConfig) {
      initialPersistedConfig = mergeInstanceIntoCfgRaw(
        initialPersistedConfig ?? {},
        instanceOperationalConfig,
      );
    }
    const bot = createBot({
      log,
      ai,
      exchange,
      getTradingMode: () => m,
      getActiveInstanceId: () => activeInstanceByMode[tradingModeToPersistenceSlug(m)] ?? null,
      persistenceSlug,
      dbAccountId,
      initialPersistedConfig,
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
    engineCredentialBinding.set(m, wantBind);
    try {
      if (wsHubHolder.hub) bot.setWsHub?.(wsHubHolder.hub);
    } catch {
      /* ignore */
    }
    return row;
  }

  async function ensureInitialEngine() {
    try {
      await ensureEngine(mode);
    } catch (e) {
      log?.error?.("exchange_init_failed", { mode, error: String(e?.message || e) });
      if (mode === "BINANCE_LIVE") {
        log?.warn?.("exchange_init_fallback_paper", { fromMode: "BINANCE_LIVE" });
        mode = "PAPER";
        setTradingModePersistenceSlug(mode);
        await ensureEngine(mode);
      } else {
        throw e;
      }
    }
  }

  function setActiveAccount(slug, accountId, opts = {}) {
    const s = String(slug || "").toLowerCase();
    if (s === "paper") return;
    if (!Object.prototype.hasOwnProperty.call(activeAccountByMode, s)) return;
    activeAccountByMode[s] = accountId && String(accountId).trim() ? String(accountId).trim() : null;
    const rebuildEngine = opts?.rebuildEngine !== false;
    const tm = SLUG_TO_TRADING_MODE[s];
    if (!rebuildEngine) {
      // Refresh the stored binding key so ensureEngine() doesn't rebuild the live engine.
      if (tm && engines.has(tm)) engineCredentialBinding.set(tm, credentialBindingKey(tm));
      return;
    }
    if (tm && engines.has(tm)) {
      try { engines.get(tm)?.exchange?.dispose?.(); } catch { /* ignore */ }
      try { engines.get(tm)?.bot?.destroy?.(); } catch { /* ignore */ }
      engines.delete(tm);
      engineCredentialBinding.delete(tm);
    }
  }

  function getActiveAccount(slug) {
    const s = String(slug || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(activeAccountByMode, s)) return null;
    return activeAccountByMode[s];
  }

  /** @param {Record<string, unknown>} prefs `users.ui_prefs.activeAccountByMode` slice or full prefs */
  function hydrateActiveAccountByMode(prefs) {
    const src = prefs?.activeAccountByMode && typeof prefs.activeAccountByMode === "object" ? prefs.activeAccountByMode : prefs;
    if (!src || typeof src !== "object") return;
    for (const slug of Object.keys(activeAccountByMode)) {
      const v = src[slug];
      activeAccountByMode[slug] = typeof v === "string" && v.length > 0 ? v : null;
    }
    for (const row of engines.values()) {
      try { row.exchange?.dispose?.(); } catch { /* ignore */ }
      try { row.bot?.destroy?.(); } catch { /* ignore */ }
    }
    engines.clear();
    engineCredentialBinding.clear();
  }

  function getActiveAccountByModeSnapshot() {
    return { ...activeAccountByMode };
  }

  function setActiveStrategyVersion(slug, versionId, opts = {}) {
    const s = String(slug || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(activeStrategyVersionByMode, s)) return;
    activeStrategyVersionByMode[s] = versionId && String(versionId).trim() ? String(versionId).trim() : null;
    const rebuildEngine = opts?.rebuildEngine !== false;
    const tm = SLUG_TO_TRADING_MODE[s];
    if (!rebuildEngine) {
      if (tm && engines.has(tm)) engineCredentialBinding.set(tm, credentialBindingKey(tm));
      return;
    }
    if (tm && engines.has(tm)) {
      try { engines.get(tm)?.exchange?.dispose?.(); } catch { /* ignore */ }
      try { engines.get(tm)?.bot?.destroy?.(); } catch { /* ignore */ }
      engines.delete(tm);
      engineCredentialBinding.delete(tm);
    }
  }

  function getActiveStrategyVersion(slug) {
    const s = String(slug || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(activeStrategyVersionByMode, s)) return null;
    return activeStrategyVersionByMode[s];
  }

  /** @param {Record<string, unknown>} prefs */
  function hydrateActiveStrategyVersionByMode(prefs) {
    const src =
      prefs?.activeStrategyVersionByMode && typeof prefs.activeStrategyVersionByMode === "object"
        ? prefs.activeStrategyVersionByMode
        : null;
    if (!src) return;
    for (const slug of Object.keys(activeStrategyVersionByMode)) {
      const v = src[slug];
      activeStrategyVersionByMode[slug] = typeof v === "string" && v.length > 0 ? v : null;
    }
    for (const row of engines.values()) {
      try { row.exchange?.dispose?.(); } catch { /* ignore */ }
      try { row.bot?.destroy?.(); } catch { /* ignore */ }
    }
    engines.clear();
    engineCredentialBinding.clear();
  }

  function getActiveStrategyVersionByModeSnapshot() {
    return { ...activeStrategyVersionByMode };
  }

  function setActiveInstance(slug, instanceId, opts = {}) {
    const s = String(slug || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(activeInstanceByMode, s)) return;
    activeInstanceByMode[s] = instanceId && String(instanceId).trim() ? String(instanceId).trim() : null;
    const rebuildEngine = opts?.rebuildEngine !== false;
    const tm = SLUG_TO_TRADING_MODE[s];
    if (!rebuildEngine) {
      if (tm && engines.has(tm)) engineCredentialBinding.set(tm, credentialBindingKey(tm));
      return;
    }
    if (tm && engines.has(tm)) {
      try { engines.get(tm)?.exchange?.dispose?.(); } catch { /* ignore */ }
      try { engines.get(tm)?.bot?.destroy?.(); } catch { /* ignore */ }
      engines.delete(tm);
      engineCredentialBinding.delete(tm);
    }
  }

  function getActiveInstance(slug) {
    const s = String(slug || "").toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(activeInstanceByMode, s)) return null;
    return activeInstanceByMode[s];
  }

  /** @param {Record<string, unknown>} prefs */
  function hydrateActiveInstanceByMode(prefs) {
    const src =
      prefs?.activeInstanceByMode && typeof prefs.activeInstanceByMode === "object" ? prefs.activeInstanceByMode : null;
    if (!src) return;
    for (const slug of Object.keys(activeInstanceByMode)) {
      const v = src[slug];
      activeInstanceByMode[slug] = typeof v === "string" && v.length > 0 ? v : null;
    }
    for (const row of engines.values()) {
      try { row.exchange?.dispose?.(); } catch { /* ignore */ }
      try { row.bot?.destroy?.(); } catch { /* ignore */ }
    }
    engines.clear();
    engineCredentialBinding.clear();
  }

  function getActiveInstanceByModeSnapshot() {
    return { ...activeInstanceByMode };
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
    ensureInitialEngine,
    setActiveAccount,
    getActiveAccount,
    hydrateActiveAccountByMode,
    getActiveAccountByModeSnapshot,
    setActiveStrategyVersion,
    getActiveStrategyVersion,
    hydrateActiveStrategyVersionByMode,
    getActiveStrategyVersionByModeSnapshot,
    setActiveInstance,
    getActiveInstance,
    hydrateActiveInstanceByMode,
    getActiveInstanceByModeSnapshot,
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
    getIntelligenceScore: (symbol) => _getIntelligenceScore(symbol),
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
          row = await ensureEngine(mode);
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
          const slug = tradingModeToPersistenceSlug(requested);
          let persisted = null;
          let instOpCfg = null;
          if (getPool()) {
            let vid = activeStrategyVersionByMode[slug];
            const iid = activeInstanceByMode[slug];
            if (iid) {
              try {
                const bind = await instanceService.getInstanceEngineBinding(String(iid));
                if (bind && !bind.isDeleted && bind.accountModeSlug === slug) {
                  vid = bind.strategyVersionId;
                  instOpCfg = bind.operationalConfig ?? null;
                }
              } catch {
                /* ignore */
              }
            }
            if (vid) {
              try {
                const ver = await strategyService.getVersion(vid);
                persisted = ver?.cfgRaw && typeof ver.cfgRaw === "object" ? ver.cfgRaw : null;
              } catch {
                persisted = null;
              }
            }
          }
          if (instOpCfg) persisted = mergeInstanceIntoCfgRaw(persisted ?? {}, instOpCfg);
          if (persisted) row.bot.reloadTradingConfigFromPersisted?.(persisted);
          else row.bot.reloadTradingConfigFromDisk?.();
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
          tradingMode: mode,
          detail: { mode, parallelEngines: true },
        });
      } catch {
        this.wsHub?.broadcast("state", { mode, ...row.bot.getPublicState(), account: null, positions: [] });
        broadcastActivity(this.wsHub, {
          level: "warn",
          msg: `Trading mode active · ${mode} (account/positions unavailable)`,
          category: "trading_mode",
          reason: "mode_changed_partial",
          tradingMode: mode,
          detail: { mode },
        });
      }
      return { ok: true, mode };
    },
  };
}
