/** Browser persistence for trading mode + bot config fields (survives server restarts / empty data dir). */

/** v2: capital-allotment fields added to persist list; migrate v1 without copying `byMode` (stale prefs broke VPS vs dev). */
const STORAGE_KEY_BASE = "trading-ui-prefs-v2";
const LEGACY_STORAGE_KEY = "trading-ui-prefs-v1";

/** When UI auth is on, scope prefs per stable user tag from `/api/auth/me` (SHA-256 prefix of email, not reversible). */
export function tradingUiStorageKey(userTag?: string | null): string {
  const t = userTag != null && String(userTag).trim() ? String(userTag).trim() : "";
  return t ? `${STORAGE_KEY_BASE}:user:${t}` : STORAGE_KEY_BASE;
}

export type TradingModeSlug = "PAPER" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_LIVE";

export type PortfolioPnlRangePersisted = {
  pnlHistoryRange: "all" | "custom";
  customRangeStart: string;
  customRangeEnd: string;
};

export type TradingUiPersistedV1 = {
  v: 1;
  /** Last mode the operator selected (used to restore after server restarts). */
  lastMode?: TradingModeSlug;
  byMode: Record<string, Record<string, unknown>>;
  /** Portfolio trade-history PnL window per mode (browser-only; survives backend restarts). */
  portfolioPnlRangeByMode?: Record<string, PortfolioPnlRangePersisted>;
};

/** Keys mirror backend `persistTradingConfigToDisk` + tradingFormDefaults + pin symbol. */
export const PERSIST_BOT_KEYS = [
  "symbol",
  "timeframe",
  "symbolMode",
  "universePinnedSymbol",
  "universeCoinBase",
  "universeCustomSymbols",
  "universeCoinSelectMode",
  "universePinControl",
  "universeAutoCoinPick",
  "universePinnedSymbols",
  "aiThreshold",
  "riskPerTrade",
  "maxDailyLoss",
  "riskPerTradeUnit",
  "maxDailyLossUnit",
  "capitalSplitAcrossCoins",
  /** Fixed-USDT capital pool + multi-coin deploy (must persist for session restore / VPS parity). */
  "allowedBudgetUsdt",
  "allowedBudgetWalletPct",
  "allowedBudgetInputMode",
  "multiTradeUsePctOfUsable",
  "multiTradePctOfUsable",
  "multiBudgetSplitMode",
  "multiBudgetCoinUsdt",
  "multiBudgetCoinPct",
  "strategyMode",
  "manualStrategy",
  "marketMode",
  "futuresLeverageMode",
  "futuresLeverage",
  "supertrendSpotAuto",
  "supertrendFuturesAuto",
  "supertrendFuturesAiConfidenceFilter",
  "signalStrengthGatesTrades",
  "supertrendMoveQualityGate",
  "supertrendMoveQualityMinScore",
  "supertrendMoveQualityMinAdx",
  "supertrendMoveQualityMinMoveSlRatio",
  "supertrendMoveQualityExpectedMoveAtrMult",
  "supertrendMoveQualityMinAtrExpansion",
  "supertrendMoveQualityMinBodyVsAvg",
  "supertrendMoveQualityMinDirectionalBody",
  "supertrendMoveQualityMinVolumeVsAvg",
  "supertrendBreakoutConfirm",
  "supertrendBreakoutMaxBars",
  "signalStrengthOpenMin",
  "supertrendFuturesMinAiProb",
  "surfPulseMlThreshold",
  "trailingStopLossAuto",
  "futuresTrailingStopMode",
  "trailingStopExtraScalpingPcts",
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
      } else if (
        (key === "multiBudgetCoinUsdt" || key === "multiBudgetCoinPct") &&
        bot[key] &&
        typeof bot[key] === "object"
      ) {
        out[key] = { ...(bot[key] as Record<string, unknown>) };
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
    } else if (
      (key === "multiBudgetCoinUsdt" || key === "multiBudgetCoinPct") &&
      patch[key] &&
      typeof patch[key] === "object"
    ) {
      const prev = ((serverBot as Record<string, unknown>)[key] as Record<string, unknown> | undefined) || {};
      out[key] = { ...prev, ...(patch[key] as Record<string, unknown>) };
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

export function loadTradingUiPrefs(userTag?: string | null): TradingUiPersistedV1 | null {
  try {
    const key = tradingUiStorageKey(userTag);
    let raw = localStorage.getItem(key);
    if (!raw && userTag) {
      raw = localStorage.getItem(STORAGE_KEY_BASE);
    }
    if (!raw) {
      const leg = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (leg) {
        try {
          const old = JSON.parse(leg) as TradingUiPersistedV1 & { lastMode?: string };
          if (old?.v === 1 && typeof old.byMode === "object") {
            const migrated: TradingUiPersistedV1 = {
              v: 1,
              lastMode: old.lastMode as TradingModeSlug | undefined,
              byMode: {},
            };
            localStorage.setItem(key, JSON.stringify(migrated));
          }
        } catch {
          /* ignore */
        }
        try {
          localStorage.removeItem(LEGACY_STORAGE_KEY);
        } catch {
          /* ignore */
        }
        raw = localStorage.getItem(key);
      }
    }
    if (!raw) return null;
    const data = JSON.parse(raw) as TradingUiPersistedV1;
    if (data.v !== 1 || typeof data.byMode !== "object" || !data.byMode) return null;
    return data;
  } catch {
    return null;
  }
}

export function tradingUiPersistMode(mode: string | undefined, userTag?: string | null) {
  if (!mode) return;
  const m = String(mode).toUpperCase();
  if (!["PAPER", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_LIVE"].includes(m)) return;
  try {
    const key = tradingUiStorageKey(userTag);
    const cur = loadTradingUiPrefs(userTag) || { v: 1 as const, lastMode: m as TradingModeSlug, byMode: {} };
    cur.v = 1;
    cur.lastMode = m as TradingModeSlug;
    cur.byMode = { ...cur.byMode };
    localStorage.setItem(key, JSON.stringify(cur));
  } catch {
    /* ignore */
  }
}

export function tradingUiPersistBotSnapshot(
  mode: string | undefined,
  bot: Record<string, unknown> | null | undefined,
  userTag?: string | null,
) {
  if (!mode || !bot || typeof bot !== "object") return;
  const m = String(mode).toUpperCase();
  if (!["PAPER", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_LIVE"].includes(m)) return;
  try {
    const key = tradingUiStorageKey(userTag);
    const cur = loadTradingUiPrefs(userTag) || { v: 1 as const, lastMode: m as TradingModeSlug, byMode: {} };
    cur.v = 1;
    cur.lastMode = m as TradingModeSlug;
    cur.byMode = { ...cur.byMode, [m]: extractPersistableBotPatch(bot) };
    localStorage.setItem(key, JSON.stringify(cur));
  } catch {
    /* ignore */
  }
}

const MODE_SLUGS = new Set(["PAPER", "BINANCE_DEMO_API", "BINANCE_TESTNET", "BINANCE_LIVE"]);

/** Read saved portfolio PnL custom range for the active trading mode. */
export function loadPortfolioPnlRangeForMode(
  mode: string | undefined,
  userTag?: string | null,
): PortfolioPnlRangePersisted | null {
  const m = String(mode || "").toUpperCase();
  if (!MODE_SLUGS.has(m)) return null;
  const cur = loadTradingUiPrefs(userTag);
  const row = cur?.portfolioPnlRangeByMode?.[m];
  if (!row || typeof row !== "object") return null;
  const pnlHistoryRange = row.pnlHistoryRange === "custom" ? "custom" : "all";
  return {
    pnlHistoryRange,
    customRangeStart: typeof row.customRangeStart === "string" ? row.customRangeStart : "",
    customRangeEnd: typeof row.customRangeEnd === "string" ? row.customRangeEnd : "",
  };
}

/** Persist portfolio PnL history range for one trading mode (same storage bucket as bot prefs). */
export function tradingUiPersistPortfolioPnlRange(
  mode: string | undefined,
  payload: PortfolioPnlRangePersisted,
  userTag?: string | null,
) {
  const m = String(mode || "").toUpperCase();
  if (!MODE_SLUGS.has(m)) return;
  try {
    const key = tradingUiStorageKey(userTag);
    const cur = loadTradingUiPrefs(userTag) || { v: 1 as const, lastMode: m as TradingModeSlug, byMode: {} };
    cur.v = 1;
    cur.lastMode = (cur.lastMode ?? m) as TradingModeSlug;
    cur.byMode = cur.byMode && typeof cur.byMode === "object" ? cur.byMode : {};
    cur.portfolioPnlRangeByMode = {
      ...(cur.portfolioPnlRangeByMode && typeof cur.portfolioPnlRangeByMode === "object"
        ? cur.portfolioPnlRangeByMode
        : {}),
      [m]: {
        pnlHistoryRange: payload.pnlHistoryRange === "custom" ? "custom" : "all",
        customRangeStart: String(payload.customRangeStart ?? ""),
        customRangeEnd: String(payload.customRangeEnd ?? ""),
      },
    };
    localStorage.setItem(key, JSON.stringify(cur));
  } catch {
    /* ignore */
  }
}
