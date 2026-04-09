/** Browser persistence for trading mode + bot config fields (survives server restarts / empty data dir). */

const STORAGE_KEY = "trading-ui-prefs-v1";

export type TradingModeSlug = "PAPER" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_LIVE";

export type TradingUiPersistedV1 = {
  v: 1;
  /** Last mode the operator selected (used to restore after server restarts). */
  lastMode?: TradingModeSlug;
  byMode: Record<string, Record<string, unknown>>;
};

/** Keys mirror backend `persistTradingConfigToDisk` + tradingFormDefaults + pin symbol. */
export const PERSIST_BOT_KEYS = [
  "symbol",
  "timeframe",
  "symbolMode",
  "universePinnedSymbol",
  "aiThreshold",
  "riskPerTrade",
  "maxDailyLoss",
  "riskPerTradeUnit",
  "maxDailyLossUnit",
  "strategyMode",
  "manualStrategy",
  "marketMode",
  "futuresLeverageMode",
  "futuresLeverage",
  "supertrendSpotAuto",
  "supertrendFuturesAuto",
  "supertrendFuturesAiConfidenceFilter",
  "signalStrengthGatesTrades",
  "signalStrengthOpenMin",
  "supertrendFuturesMinAiProb",
  "supertrendFuturesFixedSlPct",
  "supertrendFuturesFixedTpPct",
  "supertrendFuturesTwoWay",
  "supertrendPeriod",
  "supertrendMultiplier",
  "supertrendWilderAtr",
  "tradingFormDefaults",
] as const;

export type PersistableBotKey = (typeof PERSIST_BOT_KEYS)[number];

export function extractPersistableBotPatch(bot: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!bot || typeof bot !== "object") return {};
  const out: Record<string, unknown> = {};
  for (const key of PERSIST_BOT_KEYS) {
    if (Object.prototype.hasOwnProperty.call(bot, key) && bot[key] !== undefined) {
      if (key === "tradingFormDefaults" && bot.tradingFormDefaults && typeof bot.tradingFormDefaults === "object") {
        out.tradingFormDefaults = { ...(bot.tradingFormDefaults as Record<string, unknown>) };
      } else {
        out[key] = bot[key];
      }
    }
  }
  return out;
}

export function mergePersistedBotPatch(
  serverBot: Record<string, unknown>,
  patch: Record<string, unknown> | undefined | null,
): Record<string, unknown> {
  if (!patch || typeof patch !== "object" || !Object.keys(patch).length) return serverBot;
  const out: Record<string, unknown> = { ...serverBot };
  for (const key of PERSIST_BOT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(patch, key) || patch[key] === undefined) continue;
    if (key === "tradingFormDefaults" && patch.tradingFormDefaults && typeof patch.tradingFormDefaults === "object") {
      const prev = (serverBot.tradingFormDefaults as Record<string, unknown> | undefined) || {};
      out.tradingFormDefaults = { ...prev, ...(patch.tradingFormDefaults as Record<string, unknown>) };
    } else {
      out[key] = patch[key];
    }
  }
  return out;
}

function stableStringify(x: unknown): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;
  const o = x as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** True when every key in `patch` has the same value on `bot` (for skipping redundant /api/bot/config). */
export function botMatchesPersistedPatch(bot: Record<string, unknown> | null | undefined, patch: Record<string, unknown>): boolean {
  if (!bot || typeof bot !== "object" || !patch || typeof patch !== "object") return false;
  for (const key of Object.keys(patch)) {
    if (!PERSIST_BOT_KEYS.includes(key as PersistableBotKey)) continue;
    const pv = patch[key];
    const bv = (bot as Record<string, unknown>)[key];
    if (stableStringify(pv) !== stableStringify(bv)) return false;
  }
  return true;
}

export function loadTradingUiPrefs(): TradingUiPersistedV1 | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as TradingUiPersistedV1;
    if (data.v !== 1 || typeof data.byMode !== "object" || !data.byMode) return null;
    return data;
  } catch {
    return null;
  }
}

export function tradingUiPersistMode(mode: string | undefined) {
  if (!mode) return;
  const m = String(mode).toUpperCase();
  if (!["PAPER", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_LIVE"].includes(m)) return;
  try {
    const cur = loadTradingUiPrefs() || { v: 1 as const, lastMode: m as TradingModeSlug, byMode: {} };
    cur.v = 1;
    cur.lastMode = m as TradingModeSlug;
    cur.byMode = { ...cur.byMode };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cur));
  } catch {
    /* ignore */
  }
}

export function tradingUiPersistBotSnapshot(mode: string | undefined, bot: Record<string, unknown> | null | undefined) {
  if (!mode || !bot || typeof bot !== "object") return;
  const m = String(mode).toUpperCase();
  if (!["PAPER", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_LIVE"].includes(m)) return;
  try {
    const cur = loadTradingUiPrefs() || { v: 1 as const, lastMode: m as TradingModeSlug, byMode: {} };
    cur.v = 1;
    cur.lastMode = m as TradingModeSlug;
    cur.byMode = { ...cur.byMode, [m]: extractPersistableBotPatch(bot) };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cur));
  } catch {
    /* ignore */
  }
}
