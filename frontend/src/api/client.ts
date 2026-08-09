import type { Account, CreateAccountDto, CredentialsMeta, UpdateAccountDto } from "../types/accounts";
import type { ApiTradingModeSlug } from "../lib/tradingModeSlug";
import type { CreateStrategyDto, Strategy, StrategyMetaPatch, StrategyVersion } from "../types/strategy";
import type { AllotmentHeadroom, BotInstance, CreateInstanceDto, InstanceStatusLogEntry } from "../types/instance";
import type { Trade, TradeFill } from "../types/trade";
import type {
  EquityCurvePoint,
  PerformanceCompareRow,
  StrategyEdgeMetrics,
  StrategyPerformance,
  VersionPerformanceRow,
} from "../types/performance";
import { mapApiStrategy, mapApiStrategyVersion } from "../lib/strategyApiMappers";

/** DEV: "" → Vite proxy. PROD: "" → same origin (Express SERVE_FRONTEND or reverse proxy). Else set VITE_BACKEND_HTTP. */
const HTTP =
  import.meta.env.VITE_BACKEND_HTTP ?? (import.meta.env.DEV ? "" : "");

function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, credentials: "include" });
}

export function buildCustomUniverseSnapshot(symbols: string[], timeframe = "1h") {
  const cleaned = [...new Set(symbols.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))].slice(0, 10);
  return {
    ok: true,
    asOf: new Date().toISOString(),
    timeframe,
    ranked: cleaned.map((symbol) => ({
      symbol,
      score: 0,
      aiProb: null,
      opportunity: null,
      spreadPct: null,
    })),
    selected: cleaned.slice(0, 3),
    tradable: cleaned.length,
    universeSize: cleaned.length,
    emptyCustom: cleaned.length === 0,
  };
}

async function mergeUniverseScanSnapshot(scan: Record<string, unknown>) {
  const { useAppStore, deriveViewBot, draftByModeWithInstanceContext } = await import("../ws/store");
  const { tradingModeToApiModeSlug } = await import("../lib/tradingModeSlug");
  useAppStore.setState((s) => {
    const prevLive =
      s.liveBot && typeof s.liveBot === "object" && !Array.isArray(s.liveBot)
        ? (s.liveBot as Record<string, unknown>)
        : {};
    const liveBot = { ...prevLive, universe: scan };
    const modeSlug = tradingModeToApiModeSlug(s.mode);
    const bot = deriveViewBot(s.mode, liveBot, draftByModeWithInstanceContext(s, modeSlug));
    return { liveBot, bot };
  });
}

async function json<T>(res: Response): Promise<T> {
  const txt = await res.text();
  let data: any = null;
  try {
    data = txt ? JSON.parse(txt) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    let msg = data?.error || data?.detail || `http_${res.status}`;
    if (msg && typeof msg === "object") {
      try { msg = JSON.stringify(msg); } catch { msg = "validation_error"; }
    }
    throw new Error(String(msg));
  }
  return (data ?? {}) as T;
}

function mapApiTradeFill(raw: unknown): TradeFill | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.tradeId !== "string") return null;
  return {
    id: String(r.id),
    tradeId: String(r.tradeId),
    binanceOrderId: String(r.binanceOrderId ?? ""),
    binanceTradeId: r.binanceTradeId != null ? String(r.binanceTradeId) : null,
    fillType: String(r.fillType ?? ""),
    side: String(r.side ?? ""),
    price: Number(r.price),
    quantity: Number(r.quantity),
    feeAsset: r.feeAsset != null ? String(r.feeAsset) : null,
    feeAmount: r.feeAmount != null ? Number(r.feeAmount) : null,
    feeUsdt: r.feeUsdt != null ? Number(r.feeUsdt) : null,
    isMaker: r.isMaker != null ? Boolean(r.isMaker) : null,
    filledAt: r.filledAt != null ? String(r.filledAt) : null,
  };
}

function mapApiTrade(raw: unknown): Trade | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string") return null;
  const fillsRaw = r.fills;
  const fills = Array.isArray(fillsRaw) ? fillsRaw.map(mapApiTradeFill).filter((x): x is TradeFill => x != null) : undefined;
  return {
    id: String(r.id),
    instanceId: String(r.instanceId ?? ""),
    signalId: r.signalId != null ? String(r.signalId) : null,
    strategyVersionId: r.strategyVersionId != null ? String(r.strategyVersionId) : null,
    symbol: String(r.symbol ?? ""),
    marketType: String(r.marketType ?? ""),
    direction: String(r.direction ?? ""),
    status: String(r.status ?? ""),
    entryPrice: r.entryPrice != null ? Number(r.entryPrice) : null,
    exitPrice: r.exitPrice != null ? Number(r.exitPrice) : null,
    quantity: r.quantity != null ? Number(r.quantity) : null,
    notionalUsdt: r.notionalUsdt != null ? Number(r.notionalUsdt) : null,
    leverage: r.leverage != null ? Number(r.leverage) : null,
    slPrice: r.slPrice != null ? Number(r.slPrice) : null,
    tpPrice: r.tpPrice != null ? Number(r.tpPrice) : null,
    exitReason: r.exitReason != null ? String(r.exitReason) : null,
    grossPnl: r.grossPnl != null ? Number(r.grossPnl) : null,
    feesUsdt: r.feesUsdt != null ? Number(r.feesUsdt) : null,
    netPnl: r.netPnl != null ? Number(r.netPnl) : null,
    roiPct: r.roiPct != null ? Number(r.roiPct) : null,
    holdDurationSec: r.holdDurationSec != null ? Number(r.holdDurationSec) : null,
    binanceOrderIds: Array.isArray(r.binanceOrderIds) ? r.binanceOrderIds.map(String) : null,
    openedAt: r.openedAt != null ? String(r.openedAt) : null,
    closedAt: r.closedAt != null ? String(r.closedAt) : null,
    createdAt: r.createdAt != null ? String(r.createdAt) : null,
    ...(fills?.length ? { fills } : {}),
  };
}

export function mapApiStrategyPerformance(raw: unknown, fallbackVersionId?: string): StrategyPerformance | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const vid =
    typeof r.strategyVersionId === "string"
      ? r.strategyVersionId
      : fallbackVersionId != null
        ? fallbackVersionId
        : null;
  if (!vid) return null;
  return {
    strategyVersionId: vid,
    totalTrades: Number(r.totalTrades ?? 0),
    winningTrades: Number(r.winningTrades ?? 0),
    losingTrades: Number(r.losingTrades ?? 0),
    winRatePct: r.winRatePct != null ? Number(r.winRatePct) : 0,
    totalPnlUsdt: r.totalPnlUsdt != null ? Number(r.totalPnlUsdt) : 0,
    avgWinUsdt: r.avgWinUsdt != null ? Number(r.avgWinUsdt) : null,
    avgLossUsdt: r.avgLossUsdt != null ? Number(r.avgLossUsdt) : null,
    profitFactor: r.profitFactor != null ? Number(r.profitFactor) : null,
    maxDrawdownUsdt: r.maxDrawdownUsdt != null ? Number(r.maxDrawdownUsdt) : null,
    maxDrawdownPct: r.maxDrawdownPct != null ? Number(r.maxDrawdownPct) : null,
    sharpeRatio: r.sharpeRatio != null ? Number(r.sharpeRatio) : null,
    avgHoldSec: r.avgHoldSec != null ? Number(r.avgHoldSec) : null,
    avgRoiPct: r.avgRoiPct != null ? Number(r.avgRoiPct) : null,
    rrRatio: r.rrRatio != null ? Number(r.rrRatio) : null,
    lastCalculatedAt: r.lastCalculatedAt != null ? String(r.lastCalculatedAt) : null,
  };
}

function mapApiEquityPoint(raw: unknown): EquityCurvePoint | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.closedAt !== "string") return null;
  const dir = String(r.direction || "LONG").toUpperCase();
  return {
    closedAt: String(r.closedAt),
    netPnl: Number(r.netPnl),
    runningEquity: Number(r.runningEquity),
    drawdownPct: Number(r.drawdownPct),
    exitReason: r.exitReason != null ? String(r.exitReason) : null,
    symbol: String(r.symbol ?? ""),
    direction: dir === "SHORT" ? "SHORT" : "LONG",
  };
}

function mapApiPerformanceCompareRow(raw: unknown): PerformanceCompareRow | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.strategyId !== "string" || typeof r.versionId !== "string") return null;
  return {
    strategyId: String(r.strategyId),
    strategyName: String(r.strategyName ?? ""),
    versionId: String(r.versionId),
    versionNumber: Number(r.versionNumber ?? 0),
    label: r.label != null ? String(r.label) : null,
    metrics: mapApiStrategyPerformance(r.metrics, String(r.versionId)),
  };
}

export type MarketIntelProvidersStatus = {
  ok?: boolean;
  encryptionConfigured: boolean;
  storedBlobPresent: boolean;
  envPresent: Record<string, boolean>;
  effectivePresent: Record<string, boolean>;
  storedPreview: Record<string, string | null>;
  effectiveAiBaseUrl: string | null;
};

export const api = {
  /** Retries on 429 so UI auth bootstrap is not mistaken for logout when the global /api bucket is hot. */
  async authMe() {
    const maxAttempts = 6;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const res = await apiFetch(`${HTTP}/api/auth/me`);
      if (res.status === 429 && attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      return json<{
        ok?: boolean;
        enabled?: boolean;
        authenticated?: boolean;
        uiUserTag?: string | null;
        uiTradingMode?: string | null;
        syncUiPrefs?: boolean;
        uiUserRole?: string | null;
      }>(res);
    }
  },
  async login(email: string, password: string) {
    return json<{ ok?: boolean }>(
      await apiFetch(`${HTTP}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      }),
    );
  },
  async logout() {
    return json<{ ok?: boolean }>(
      await apiFetch(`${HTTP}/api/auth/logout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
  },
  async getUiPrefs() {
    return json<{ ok?: boolean; ui_prefs?: Record<string, unknown> }>(await apiFetch(`${HTTP}/api/me/ui-prefs`));
  },
  async patchUiPrefs(patch: Record<string, unknown>) {
    return json<{ ok?: boolean; ui_prefs?: Record<string, unknown> }>(
      await apiFetch(`${HTTP}/api/me/ui-prefs`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
  },
  async state() {
    return json<any>(await apiFetch(`${HTTP}/api/state`));
  },
  async getAccountsForMode(modeSlug: ApiTradingModeSlug) {
    const data = await json<{ ok?: boolean; accounts?: Account[] }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/accounts`),
    );
    return data.accounts ?? [];
  },
  async createAccount(modeSlug: ApiTradingModeSlug, body: CreateAccountDto) {
    const data = await json<{ ok?: boolean; account?: Account }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/accounts`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (!data.account) throw new Error("create_failed");
    return data.account;
  },
  async updateAccount(accountId: string, patch: UpdateAccountDto) {
    const data = await json<{ ok?: boolean; account?: Account }>(
      await apiFetch(`${HTTP}/api/accounts/${encodeURIComponent(accountId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
    if (!data.account) throw new Error("update_failed");
    return data.account;
  },
  async deactivateAccount(accountId: string) {
    await json<{ ok?: boolean }>(
      await apiFetch(`${HTTP}/api/accounts/${encodeURIComponent(accountId)}`, {
        method: "DELETE",
      }),
    );
  },
  /** Persist + apply which DB account supplies API keys for this mode (Phase 2B). */
  async setActiveAccountForMode(modeSlug: ApiTradingModeSlug, accountId: string) {
    return json<{ ok?: boolean; activeAccountByMode?: Record<string, string | null> }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/active-account`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId }),
      }),
    );
  },
  async getCredentialsMeta(accountId: string) {
    const data = await json<{ ok?: boolean; meta?: CredentialsMeta | null }>(
      await apiFetch(`${HTTP}/api/accounts/${encodeURIComponent(accountId)}/credentials`),
    );
    return data.meta ?? null;
  },
  async saveCredentials(accountId: string, apiKey: string, secret: string) {
    await json<{ ok?: boolean }>(
      await apiFetch(`${HTTP}/api/accounts/${encodeURIComponent(accountId)}/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey, secret }),
      }),
    );
  },
  async revokeCredentials(accountId: string) {
    await json<{ ok?: boolean }>(
      await apiFetch(`${HTTP}/api/accounts/${encodeURIComponent(accountId)}/credentials`, {
        method: "DELETE",
      }),
    );
  },
  /** Min notional + quote asset from Binance exchangeInfo (via backend). venue: SPOT | FUTURES | BOTH */
  async symbolConstraints(symbol?: string, venue?: string) {
    const q = new URLSearchParams();
    if (symbol) q.set("symbol", symbol);
    if (venue) q.set("venue", venue);
    const qs = q.toString();
    return json<any>(await apiFetch(`${HTTP}/api/symbol/constraints${qs ? `?${qs}` : ""}`));
  },
  /** OHLCV + supertrend line from server. Omit symbol = bot’s active pair; pass symbol for multi-chart tiles. */
  async marketCandles(opts?: { hours?: number; symbol?: string; timeframe?: string } | number) {
    const hours = typeof opts === "number" ? opts : opts?.hours ?? 24;
    const symbol = typeof opts === "number" ? undefined : opts?.symbol;
    const timeframe = typeof opts === "number" ? undefined : opts?.timeframe;
    const q = new URLSearchParams();
    q.set("hours", String(hours));
    if (symbol) q.set("symbol", String(symbol).toUpperCase());
    if (timeframe) q.set("timeframe", String(timeframe).trim().toLowerCase());
    return json<any>(await apiFetch(`${HTTP}/api/market/candles?${q}`));
  },
  /** @param refresh When true, bypasses last cached snapshot and runs a fresh Binance scan. */
  async universeScan(refresh = false) {
    const q = refresh ? "?refresh=1" : "";
    const scan = await json<any>(await apiFetch(`${HTTP}/api/universe/scan${q}`));
    if (scan && typeof scan === "object") await mergeUniverseScanSnapshot(scan as Record<string, unknown>);
    return scan;
  },
  /** Tradable USDT pairs for custom coin-base (spot or futures matches MARKET_FEED). */
  async universeSymbols(opts?: { q?: string }) {
    const q = String(opts?.q || "").trim();
    const qs = q ? `?q=${encodeURIComponent(q)}` : "";
    return json<{ ok?: boolean; symbols?: string[]; error?: string }>(
      await apiFetch(`${HTTP}/api/universe/symbols${qs}`),
    );
  },
  async aiHealth() {
    return json<any>(await apiFetch(`${HTTP}/api/ai/health`));
  },
  async aiValidationSummary() {
    return json<any>(await apiFetch(`${HTTP}/api/ai/validation-summary`));
  },
  async botMetrics() {
    return json<any>(await apiFetch(`${HTTP}/api/metrics`));
  },
  async aiRetrain(minRows?: number) {
    return json<any>(
      await apiFetch(`${HTTP}/api/ai/retrain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(minRows ? { minRows } : {}),
      }),
    );
  },
  async botStart(opts?: {
    reason?: string;
    detail?: Record<string, unknown>;
    /** Start this mode’s engine (defaults to UI’s active trading mode). */
    mode?: "PAPER" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_LIVE";
  }) {
    return json<any>(
      await apiFetch(`${HTTP}/api/bot/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts ?? {}),
      }),
    );
  },
  async botStop(opts?: {
    reason?: string;
    detail?: Record<string, unknown>;
    mode?: "PAPER" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_LIVE";
  }) {
    return json<any>(
      await apiFetch(`${HTTP}/api/bot/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts ?? {}),
      }),
    );
  },
  /** Clear per-venue day baselines and start bot — use after max daily loss stop (hybrid / live wallets). */
  async botResetDailyLoss() {
    return json<any>(
      await apiFetch(`${HTTP}/api/bot/reset-daily-loss`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
  },
  async botConfig(patch: any, opts?: { signal?: AbortSignal }) {
    const { useAppStore, deriveViewBot, refreshStrategyConfigViewSlice, draftByModeWithInstanceContext } =
      await import("../ws/store");
    const { activeInstanceIdForMode } = await import("../lib/instanceConfigView");
    const { tradingUiPersistBotSnapshot } = await import("../lib/tradingUiPersistence");
    const { tradingModeToApiModeSlug } = await import("../lib/tradingModeSlug");

    const patchObj =
      patch && typeof patch === "object" && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {};
    const patchKeys = Object.keys(patchObj);
    const ignoredOnly = patchKeys.length > 0 && patchKeys.every((k) => k === "uiChartFocusSymbol");
    const prevBot = useAppStore.getState().bot as Record<string, unknown> | undefined;

    if (!ignoredOnly && patchKeys.length > 0) {
      const { noteBotConfigPatchInFlight } = await import("../lib/configPatchInFlight");
      noteBotConfigPatchInFlight(patchObj);
      useAppStore.setState((s) => {
        const modeSlug = tradingModeToApiModeSlug(s.mode);
        return {
          bot: deriveViewBot(
            s.mode,
            s.liveBot && typeof s.liveBot === "object" && !Array.isArray(s.liveBot)
              ? (s.liveBot as Record<string, unknown>)
              : {},
            draftByModeWithInstanceContext(s, modeSlug),
          ),
        };
      });
    }

    let data: any;
    try {
      data = await json<any>(
        await apiFetch(`${HTTP}/api/bot/config`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
          signal: opts?.signal,
        }),
      );
    } catch (e) {
      if (!ignoredOnly && patchKeys.length > 0) {
        const { clearBotConfigPatchInFlight } = await import("../lib/configPatchInFlight");
        clearBotConfigPatchInFlight(patchObj);
      }
      if (!ignoredOnly && patchKeys.length > 0 && prevBot && typeof prevBot === "object") {
        useAppStore.setState({ bot: prevBot });
      }
      throw e;
    }

    if (!data?.ok || !data.bot || typeof data.bot !== "object") {
      if (!ignoredOnly && patchKeys.length > 0) {
        const { clearBotConfigPatchInFlight } = await import("../lib/configPatchInFlight");
        clearBotConfigPatchInFlight(patchObj);
      }
      if (!ignoredOnly && patchKeys.length > 0 && prevBot && typeof prevBot === "object") {
        useAppStore.setState({ bot: prevBot });
      }
      return data;
    }

    const botNext = data.bot as Record<string, unknown>;
    if (!ignoredOnly && patchKeys.length > 0) {
      const { clearBotConfigPatchInFlightWhenAcked, pruneDraftBotPatchAcked } = await import(
        "../lib/configPatchInFlight"
      );
      clearBotConfigPatchInFlightWhenAcked(patchObj, botNext);
      useAppStore.setState((s) => {
        const modeSlug = tradingModeToApiModeSlug(s.mode);
        const instanceId = activeInstanceIdForMode(s, modeSlug);
        const draftBotPatchByInstanceId = { ...(s.draftBotPatchByInstanceId ?? {}) };
        const prevDraft = instanceId ? (draftBotPatchByInstanceId[instanceId] ?? {}) : {};
        const prunedDraft = pruneDraftBotPatchAcked(prevDraft, patchObj, botNext);
        if (instanceId) draftBotPatchByInstanceId[instanceId] = prunedDraft;
        const draftCtx = draftByModeWithInstanceContext({ ...s, draftBotPatchByInstanceId }, modeSlug);
        const viewBot = deriveViewBot(s.mode, botNext, draftCtx);
        tradingUiPersistBotSnapshot(s.mode, viewBot, s.authUiUserTag ?? null);
        return {
          liveBot: botNext,
          draftBotPatchByInstanceId,
          ...refreshStrategyConfigViewSlice(s, modeSlug, viewBot, instanceId),
        };
      });
    } else {
      useAppStore.setState((s) => {
        const modeSlug = tradingModeToApiModeSlug(s.mode);
        const live =
          s.liveBot && typeof s.liveBot === "object" && !Array.isArray(s.liveBot)
            ? { ...(s.liveBot as Record<string, unknown>), ...botNext }
            : botNext;
        const viewBot = deriveViewBot(s.mode, live, draftByModeWithInstanceContext(s, modeSlug));
        tradingUiPersistBotSnapshot(s.mode, viewBot, s.authUiUserTag ?? null);
        return { liveBot: live, bot: viewBot };
      });
    }
    const dirtyPatchKeys = Object.keys(patchObj);
    const dirtyIgnoredOnly =
      dirtyPatchKeys.length > 0 && dirtyPatchKeys.every((k) => k === "uiChartFocusSymbol");
    if (!dirtyIgnoredOnly) {
      const modeSlug = tradingModeToApiModeSlug(useAppStore.getState().mode);
      useAppStore.getState().recomputeStrategyConfigDirtyForMode(modeSlug);
    }
    return data;
  },
  async botChartFocus(uiChartFocusSymbol: string | null, opts?: { signal?: AbortSignal }) {
    return json<{ ok?: boolean; uiChartFocusSymbol?: string | null }>(
      await apiFetch(`${HTTP}/api/bot/chart-focus`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uiChartFocusSymbol }),
        signal: opts?.signal,
        cache: "no-store",
        keepalive: false,
      }),
    );
  },
  async saveStrategyConfigForMode(
    modeSlug: ApiTradingModeSlug,
    body: {
      action: "save" | "save_as_new";
      name?: string;
      description?: string | null;
      tags?: string[];
      label?: string | null;
      cfgRaw?: Record<string, unknown>;
      /** Instance operational fields (`inst_*`) from the UI view bot — avoids pre-save botConfig flush. */
      instanceOperational?: Record<string, unknown>;
    },
  ) {
    const data = await json<{
      ok?: boolean;
      action?: "save" | "save_as_new";
      strategy?: unknown;
      version?: unknown;
      bot?: Record<string, unknown>;
    }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/strategy-config/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    if (data?.ok && data.bot && typeof data.bot === "object") {
      const { tradingUiPersistBotSnapshot } = await import("../lib/tradingUiPersistence");
      const { useAppStore, mergeEngineBotSnapshot } = await import("../ws/store");
      const st = useAppStore.getState();
      if (data.version) {
        st.applyStrategySaveResponse(modeSlug, data.version, data.bot as Record<string, unknown>);
      } else {
        const botNext = data.bot as Record<string, unknown>;
        useAppStore.setState((s) => mergeEngineBotSnapshot(s, modeSlug, botNext));
      }
      queueMicrotask(() => {
        const viewBot = useAppStore.getState().bot as Record<string, unknown>;
        tradingUiPersistBotSnapshot(st.mode, viewBot, st.authUiUserTag ?? null);
      });
    }
    return data;
  },
  /** Suggest / apply Move Quality thresholds from `mq-trade-outcomes.jsonl` for the current mode. */
  async botTuneMoveQuality(opts?: {
    mode?: string;
    apply?: boolean;
    minTrades?: number;
    winPercentileFloor?: number;
  }) {
    const res = await apiFetch(`${HTTP}/api/bot/tune-move-quality`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts ?? {}),
    });
    const txt = await res.text();
    let data: any = null;
    try {
      data = txt ? JSON.parse(txt) : null;
    } catch {
      data = null;
    }
    if (res.ok && data?.ok && data.bot && typeof data.bot === "object") {
      const { tradingUiPersistBotSnapshot } = await import("../lib/tradingUiPersistence");
      const { useAppStore } = await import("../ws/store");
      tradingUiPersistBotSnapshot(
        useAppStore.getState().mode,
        data.bot as Record<string, unknown>,
        useAppStore.getState().authUiUserTag ?? null,
      );
      useAppStore.setState((s) => ({
        bot:
          s.bot && typeof s.bot === "object"
            ? { ...s.bot, ...data.bot }
            : data.bot,
      }));
    }
    if (!res.ok) {
      const msg =
        (typeof data?.message === "string" && data.message) ||
        (typeof data?.error === "string" && data.error) ||
        `http_${res.status}`;
      throw new Error(String(msg));
    }
    return data ?? {};
  },
  async manualTrade(payload: {
    side: "BUY" | "SELL";
    amountUsd: number;
    stopLossPct?: number | null;
    takeProfitPct?: number | null;
  }) {
    return json<any>(
      await apiFetch(`${HTTP}/api/trade/manual`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }),
    );
  },
  async closeTrade(id: string) {
    return json<any>(
      await apiFetch(`${HTTP}/api/trade/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      }),
    );
  },
  async tradeRefresh() {
    return json<{ ok?: boolean; count?: number }>(
      await apiFetch(`${HTTP}/api/trade/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
  },
  async paperReset() {
    return json<any>(
      await apiFetch(`${HTTP}/api/paper/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    );
  },
  async backtest(limit = 600) {
    return json<any>(await apiFetch(`${HTTP}/api/backtest?limit=${encodeURIComponent(String(limit))}`));
  },
  async tradingEvaluation() {
    return json<any>(await apiFetch(`${HTTP}/api/trading/evaluation`));
  },
  async setMode(mode: "PAPER" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_LIVE") {
    const { useAppStore, resetChartSessionForModeSwitch, maybeClearModeSwitchPending } = await import(
      "../ws/store",
    );
    useAppStore.setState({ modeSwitchPending: mode });
    try {
      const data = await json<any>(
        await apiFetch(`${HTTP}/api/mode/set`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode, confirm: true }),
        }),
      );
      if (data?.ok) {
        const { tradingUiPersistMode } = await import("../lib/tradingUiPersistence");
        resetChartSessionForModeSwitch();
        useAppStore.setState({
          mode,
          candles: [],
          market: undefined,
          depth: undefined,
          trades: [],
        });
        tradingUiPersistMode(mode, useAppStore.getState().authUiUserTag ?? null);
        if (!useAppStore.getState().ws.connected) {
          maybeClearModeSwitchPending(mode);
        } else {
          window.setTimeout(() => maybeClearModeSwitchPending(mode), 2500);
        }
      } else {
        useAppStore.setState({ modeSwitchPending: null });
      }
      return data;
    } catch (e) {
      useAppStore.setState({ modeSwitchPending: null });
      throw e;
    }
  },
  async aiTrainReal(opts?: {
    symbols?: string[];
    interval?: string;
    candlesPerSymbol?: number;
    horizon?: number;
    atrMult?: number;
    rr?: number;
    labelProfile?: "risk_aligned" | "legacy";
    feeBps?: number;
  }) {
    return json<any>(
      await apiFetch(`${HTTP}/api/ai/train-real`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts ?? {}),
      }),
    );
  },
  /** Synthetic data only — works without Binance (e.g. Railway). Usually finishes in under ~2 minutes. */
  async aiTrainBootstrap(opts?: { rows?: number; horizon?: number; seed?: number; start_price?: number }) {
    return json<any>(
      await apiFetch(`${HTTP}/api/ai/train-bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts ?? {}),
      }),
    );
  },

  async getStrategiesForMode(modeSlug: ApiTradingModeSlug, opts?: { includeArchived?: boolean }) {
    const q = opts?.includeArchived ? "?includeArchived=1" : "";
    const data = await json<{ ok?: boolean; strategies?: unknown[] }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/strategies${q}`),
    );
    const list = Array.isArray(data.strategies) ? data.strategies : [];
    return list.map((row) => mapApiStrategy(row)).filter((s): s is Strategy => s != null);
  },

  async createStrategy(modeSlug: ApiTradingModeSlug, dto: CreateStrategyDto) {
    const data = await json<{ ok?: boolean; strategy?: unknown; version?: unknown }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/strategies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(dto),
      }),
    );
    const ver = mapApiStrategyVersion(data.version);
    const st = mapApiStrategy(data.strategy, ver);
    if (!st) throw new Error("create_strategy_failed");
    return { strategy: { ...st, latestVersion: ver }, version: ver };
  },

  async getStrategyDetail(strategyId: string) {
    const data = await json<{ ok?: boolean; strategy?: unknown; latestVersion?: unknown }>(
      await apiFetch(`${HTTP}/api/strategies/${encodeURIComponent(strategyId)}`),
    );
    const latest = mapApiStrategyVersion(data.latestVersion);
    const st = mapApiStrategy(data.strategy, latest);
    if (!st) throw new Error("strategy_not_found");
    return { strategy: { ...st, latestVersion: latest }, latestVersion: latest };
  },

  async getStrategyUsage(strategyId: string, currentInstanceId?: string | null) {
    const q =
      currentInstanceId != null && String(currentInstanceId).trim()
        ? `?instanceId=${encodeURIComponent(String(currentInstanceId))}`
        : "";
    const data = await json<import("../types/strategyUsage").StrategyUsageContext & { ok?: boolean }>(
      await apiFetch(`${HTTP}/api/strategies/${encodeURIComponent(strategyId)}/usage${q}`),
    );
    if (data.ok === false) throw new Error("strategy_usage_failed");
    return data;
  },

  async bindInstanceStrategy(instanceId: string, strategyId: string) {
    const data = await json<{
      ok?: boolean;
      instance?: import("../types/instance").BotInstance;
      bot?: Record<string, unknown>;
      activeInstanceByMode?: Record<string, string | null>;
      activeStrategyVersionByMode?: Record<string, string | null>;
    }>(
      await apiFetch(`${HTTP}/api/instances/${encodeURIComponent(instanceId)}/bind-strategy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ strategyId }),
      }),
    );
    if (data.ok === false || !data.instance) throw new Error("bind_strategy_failed");
    return data;
  },

  async updateStrategyMeta(strategyId: string, patch: StrategyMetaPatch) {
    const data = await json<{ ok?: boolean; strategy?: unknown }>(
      await apiFetch(`${HTTP}/api/strategies/${encodeURIComponent(strategyId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
    const st = mapApiStrategy(data.strategy);
    if (!st) throw new Error("update_strategy_failed");
    return st;
  },

  async archiveStrategy(strategyId: string) {
    await json<{ ok?: boolean }>(
      await apiFetch(`${HTTP}/api/strategies/${encodeURIComponent(strategyId)}`, { method: "DELETE" }),
    );
  },

  async cloneStrategyAsNew(strategyId: string, name: string) {
    const data = await json<{ ok?: boolean; strategy?: unknown; version?: unknown; latestVersion?: unknown }>(
      await apiFetch(`${HTTP}/api/strategies/${encodeURIComponent(strategyId)}/clone`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );
    const ver = mapApiStrategyVersion(data.version ?? data.latestVersion);
    const st = mapApiStrategy(data.strategy, ver);
    if (!st) throw new Error("clone_strategy_failed");
    return { strategy: { ...st, latestVersion: ver }, version: ver };
  },

  async getActiveStrategyForMode(modeSlug: ApiTradingModeSlug) {
    const data = await json<{ ok?: boolean; versionId?: string | null }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/active-strategy`),
    );
    return { versionId: data.versionId != null && String(data.versionId).length ? String(data.versionId) : null };
  },

  async setActiveStrategyForMode(
    modeSlug: ApiTradingModeSlug,
    versionId: string,
  ): Promise<{
    activeStrategyVersionByMode?: Record<string, string | null>;
    bot?: Record<string, unknown>;
  } | null> {
    const data = await json<{
      ok?: boolean;
      activeStrategyVersionByMode?: Record<string, string | null>;
      bot?: Record<string, unknown>;
    }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/active-strategy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId }),
      }),
    );
    return data.ok === false ? null : data;
  },

  async listInstancesForMode(modeSlug: ApiTradingModeSlug) {
    const data = await json<{ ok?: boolean; instances?: BotInstance[] }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/instances`),
    );
    return data.instances ?? [];
  },

  async getAllotmentHeadroom(modeSlug: ApiTradingModeSlug) {
    return json<{ ok?: boolean; accountId?: string; headroom?: AllotmentHeadroom | null }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/allotment-headroom`),
    );
  },

  async createInstance(modeSlug: ApiTradingModeSlug, dto: CreateInstanceDto) {
    const data = await json<{ ok?: boolean; instance?: BotInstance }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/instances`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(dto),
      }),
    );
    if (!data.instance) throw new Error("create_instance_failed");
    return data.instance;
  },

  async getActiveInstanceForMode(modeSlug: ApiTradingModeSlug) {
    const data = await json<{ ok?: boolean; instanceId?: string | null }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/active-instance`),
    );
    return data.instanceId != null && String(data.instanceId).length ? String(data.instanceId) : null;
  },

  async setActiveInstanceForMode(
    modeSlug: ApiTradingModeSlug,
    instanceId: string | null,
  ): Promise<{
    activeAccountByMode?: Record<string, string | null>;
    activeStrategyVersionByMode?: Record<string, string | null>;
    bot?: Record<string, unknown>;
  } | null> {
    const data = await json<{
      ok?: boolean;
      activeAccountByMode?: Record<string, string | null>;
      activeStrategyVersionByMode?: Record<string, string | null>;
      bot?: Record<string, unknown>;
    }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/active-instance`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instanceId }),
      }),
    );
    return data.ok === false ? null : data;
  },

  async getInstanceDetail(instanceId: string) {
    const data = await json<{ ok?: boolean; instance?: BotInstance }>(
      await apiFetch(`${HTTP}/api/instances/${encodeURIComponent(instanceId)}`),
    );
    if (!data.instance) throw new Error("instance_not_found");
    return data.instance;
  },

  async patchInstanceLabel(instanceId: string, label: string) {
    const data = await json<{ ok?: boolean; instance?: BotInstance }>(
      await apiFetch(`${HTTP}/api/instances/${encodeURIComponent(instanceId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label }),
      }),
    );
    if (!data.instance) throw new Error("patch_failed");
    return data.instance;
  },

  /**
   * Patch operational (instance-side) config — symbol/timeframe/risk/etc.
   * Only fields present in `patch` are written. Capital allotment is a separate
   * endpoint and is intentionally NOT updatable here.
   */
  async patchInstanceOperationalConfig(
    instanceId: string,
    patch: import("../types/instance").InstanceOperationalPatch,
  ) {
    const data = await json<{ ok?: boolean; instance?: BotInstance }>(
      await apiFetch(`${HTTP}/api/instances/${encodeURIComponent(instanceId)}/operational-config`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch ?? {}),
      }),
    );
    if (!data.instance) throw new Error("patch_failed");
    return data.instance;
  },

  async deleteInstance(instanceId: string) {
    await json<{ ok?: boolean }>(
      await apiFetch(`${HTTP}/api/instances/${encodeURIComponent(instanceId)}`, { method: "DELETE" }),
    );
  },

  async getInstanceStatusLog(instanceId: string, limit = 50) {
    const data = await json<{ ok?: boolean; entries?: InstanceStatusLogEntry[] }>(
      await apiFetch(
        `${HTTP}/api/instances/${encodeURIComponent(instanceId)}/status-log?limit=${encodeURIComponent(String(limit))}`,
      ),
    );
    return data.entries ?? [];
  },

  async clearInstanceError(instanceId: string) {
    const data = await json<{ ok?: boolean; instance?: BotInstance }>(
      await apiFetch(`${HTTP}/api/instances/${encodeURIComponent(instanceId)}/clear-error`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    if (!data.instance) throw new Error("clear_error_failed");
    return data.instance;
  },

  async pauseInstance(instanceId: string) {
    const data = await json<{ ok?: boolean; instance?: BotInstance; bot?: unknown }>(
      await apiFetch(`${HTTP}/api/instances/${encodeURIComponent(instanceId)}/pause`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    if (!data.instance) throw new Error("pause_failed");
    return data;
  },

  async resumeInstance(instanceId: string) {
    const data = await json<{ ok?: boolean; instance?: BotInstance; bot?: unknown }>(
      await apiFetch(`${HTTP}/api/instances/${encodeURIComponent(instanceId)}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    if (!data.instance) throw new Error("resume_failed");
    return data;
  },

  async getInstanceTrades(instanceId: string, opts?: { limit?: number; offset?: number; status?: string }) {
    const lim = opts?.limit ?? 50;
    const off = opts?.offset ?? 0;
    const st = opts?.status != null && String(opts.status).trim() ? String(opts.status).trim() : "";
    const q = new URLSearchParams({ limit: String(lim), offset: String(off) });
    if (st) q.set("status", st);
    const data = await json<{ ok?: boolean; trades?: unknown[] }>(
      await apiFetch(`${HTTP}/api/instances/${encodeURIComponent(instanceId)}/trades?${q.toString()}`),
    );
    const list = Array.isArray(data.trades) ? data.trades : [];
    return list.map(mapApiTrade).filter((x): x is Trade => x != null);
  },

  async getTradeDetail(tradeId: string) {
    const data = await json<{ ok?: boolean; trade?: unknown }>(
      await apiFetch(`${HTTP}/api/trades/${encodeURIComponent(tradeId)}`),
    );
    return mapApiTrade(data.trade) ?? null;
  },

  async getInstanceSignals(instanceId: string, opts?: { limit?: number; wasExecuted?: boolean }) {
    const lim = opts?.limit ?? 50;
    const q = new URLSearchParams({ limit: String(lim) });
    if (opts?.wasExecuted === true) q.set("wasExecuted", "true");
    if (opts?.wasExecuted === false) q.set("wasExecuted", "false");
    const data = await json<{ ok?: boolean; signals?: unknown[] }>(
      await apiFetch(`${HTTP}/api/instances/${encodeURIComponent(instanceId)}/signals?${q.toString()}`),
    );
    return Array.isArray(data.signals) ? data.signals : [];
  },

  async getStrategyVersions(strategyId: string) {
    const data = await json<{ ok?: boolean; versions?: unknown[] }>(
      await apiFetch(`${HTTP}/api/strategies/${encodeURIComponent(strategyId)}/versions`),
    );
    const list = Array.isArray(data.versions) ? data.versions : [];
    return list.map((v) => mapApiStrategyVersion(v)).filter((x): x is StrategyVersion => x != null);
  },

  async getStrategyVersion(strategyId: string, versionId: string) {
    const data = await json<{ ok?: boolean; version?: unknown }>(
      await apiFetch(
        `${HTTP}/api/strategies/${encodeURIComponent(strategyId)}/versions/${encodeURIComponent(versionId)}`,
      ),
    );
    const v = mapApiStrategyVersion(data.version);
    if (!v) throw new Error("version_not_found");
    return v;
  },

  async saveStrategyVersionSnapshot(strategyId: string, label?: string) {
    const data = await json<{ ok?: boolean; version?: unknown }>(
      await apiFetch(`${HTTP}/api/strategies/${encodeURIComponent(strategyId)}/versions/snapshot`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(label != null ? { label } : {}),
      }),
    );
    const v = mapApiStrategyVersion(data.version);
    if (!v) throw new Error("snapshot_failed");
    return v;
  },

  async cloneStrategyVersion(strategyId: string, versionId: string, opts?: { targetStrategyId?: string; label?: string }) {
    const data = await json<{ ok?: boolean; version?: unknown }>(
      await apiFetch(
        `${HTTP}/api/strategies/${encodeURIComponent(strategyId)}/versions/${encodeURIComponent(versionId)}/clone`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(opts ?? {}),
        },
      ),
    );
    const v = mapApiStrategyVersion(data.version);
    if (!v) throw new Error("clone_failed");
    return v;
  },

  async getStrategyPerformance(strategyId: string): Promise<VersionPerformanceRow[]> {
    const data = await json<{ ok?: boolean; versions?: unknown[] }>(
      await apiFetch(`${HTTP}/api/strategies/${encodeURIComponent(strategyId)}/performance`),
    );
    const list = Array.isArray(data.versions) ? data.versions : [];
    return list
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const r = row as Record<string, unknown>;
        if (typeof r.versionId !== "string") return null;
        return {
          versionId: String(r.versionId),
          versionNumber: Number(r.versionNumber ?? 0),
          label: r.label != null ? String(r.label) : null,
          metrics: mapApiStrategyPerformance(r.metrics, String(r.versionId)),
        } satisfies VersionPerformanceRow;
      })
      .filter((x): x is VersionPerformanceRow => x != null);
  },

  async getVersionPerformance(strategyId: string, versionId: string): Promise<StrategyPerformance | null> {
    const data = await json<{ ok?: boolean; metrics?: unknown }>(
      await apiFetch(
        `${HTTP}/api/strategies/${encodeURIComponent(strategyId)}/versions/${encodeURIComponent(versionId)}/performance`,
      ),
    );
    return mapApiStrategyPerformance(data.metrics, versionId);
  },

  async getEquityCurve(strategyId: string, versionId: string): Promise<EquityCurvePoint[]> {
    const data = await json<{ ok?: boolean; curve?: unknown[] }>(
      await apiFetch(
        `${HTTP}/api/strategies/${encodeURIComponent(strategyId)}/versions/${encodeURIComponent(versionId)}/equity-curve`,
      ),
    );
    const list = Array.isArray(data.curve) ? data.curve : [];
    return list.map(mapApiEquityPoint).filter((x): x is EquityCurvePoint => x != null);
  },

  async getPerformanceCompare(modeSlug: ApiTradingModeSlug): Promise<PerformanceCompareRow[]> {
    const data = await json<{ ok?: boolean; rows?: unknown[] }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/performance/compare`),
    );
    const list = Array.isArray(data.rows) ? data.rows : [];
    return list.map(mapApiPerformanceCompareRow).filter((x): x is PerformanceCompareRow => x != null);
  },

  async getMarketEvents(opts: { from: string; to: string; assets?: string }) {
    const q = new URLSearchParams({ from: opts.from, to: opts.to });
    if (opts.assets != null && String(opts.assets).trim() !== "") q.set("assets", String(opts.assets).trim());
    const data = await json<{ ok?: boolean; events?: unknown[] }>(
      await apiFetch(`${HTTP}/api/market/events?${q.toString()}`),
    );
    return Array.isArray(data.events) ? data.events : [];
  },

  async getWhaleAlerts(opts: { from: string; to: string; symbol?: string }) {
    const q = new URLSearchParams({ from: opts.from, to: opts.to });
    if (opts.symbol != null && String(opts.symbol).trim() !== "") q.set("symbol", String(opts.symbol).trim());
    const data = await json<{ ok?: boolean; alerts?: unknown[] }>(
      await apiFetch(`${HTTP}/api/market/whales?${q.toString()}`),
    );
    return Array.isArray(data.alerts) ? data.alerts : [];
  },

  async getStrategyEdge(opts: { instanceId?: string; strategyVersionId?: string; windowDays?: number }) {
    const q = new URLSearchParams();
    if (opts.instanceId) q.set("instanceId", opts.instanceId);
    if (opts.strategyVersionId) q.set("strategyVersionId", opts.strategyVersionId);
    if (opts.windowDays != null) q.set("windowDays", String(opts.windowDays));
    return json<{ ok?: boolean; metrics?: StrategyEdgeMetrics }>(
      await apiFetch(`${HTTP}/api/analytics/strategy-edge?${q.toString()}`),
    );
  },

  async createBacktestRun(body: {
    strategyVersionId: string;
    botInstanceId?: string;
    symbol?: string;
    /** Multi-coin portfolio: 2–10 symbols; server sets symbol=PORTFOLIO. */
    symbols?: string[];
    timeframe: string;
    from: string | number | Date;
    to: string | number | Date;
    startingUsdt?: number;
    label?: string;
    costModel?: Record<string, unknown>;
    gateMode?: "off" | "approx";
    walkForward?: { trainPct?: number };
    positionSizing?: "RISK_AT_SL" | "RISK_AT_SL_FULL_MARGIN" | "FULL_EQUITY_MARGIN";
    /** Portfolio capital model (multi-coin runs only). */
    portfolioPositionSizing?:
      | "EQUAL_SLICE_FULL_MARGIN"
      | "EQUAL_SLICE_RISK_AT_SL"
      | "TOTAL_CAPITAL_RISK_AT_SL";
    /** Trailing micro TF for backtest replay (`off`, `1m`, `5m`, …). */
    trailMicroTf?: "off" | "1m" | "3m" | "5m" | "15m" | "30m";
    useLivePanelOverrides?: boolean;
    instanceOperational?: {
      symbol?: string | null;
      timeframe?: string | null;
      symbolMode?: string | null;
      marketMode?: string | null;
      riskPerTrade?: number | null;
      riskUnit?: string | null;
      maxDailyLoss?: number | null;
      maxDailyLossUnit?: string | null;
    };
  }) {
    return json<{ ok?: boolean; runId?: string; error?: string }>(
      await apiFetch(`${HTTP}/api/backtest/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },

  async listBacktestRuns(limit = 50) {
    return json<{ ok?: boolean; runs?: unknown[] }>(
      await apiFetch(`${HTTP}/api/backtest/runs?limit=${limit}`),
    );
  },

  async getBacktestRun(runId: string) {
    return json<{ ok?: boolean; run?: unknown }>(
      await apiFetch(`${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}`),
    );
  },

  async getBacktestTrades(runId: string, opts?: { limit?: number; offset?: number }) {
    const q = new URLSearchParams();
    if (opts?.limit != null) q.set("limit", String(opts.limit));
    if (opts?.offset != null) q.set("offset", String(opts.offset));
    return json<{ ok?: boolean; trades?: unknown[] }>(
      await apiFetch(`${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}/trades?${q.toString()}`),
    );
  },

  /** Download full trade CSV (table columns + TA/ML features) for a completed backtest run. */
  async downloadBacktestTradesCsv(runId: string, filename?: string) {
    const res = await apiFetch(
      `${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}/trades/export.csv`,
    );
    if (!res.ok) {
      let msg = `export_failed_${res.status}`;
      try {
        const err = (await res.json()) as { error?: string };
        if (err?.error) msg = String(err.error);
      } catch {
        /* ignore */
      }
      throw new Error(msg);
    }
    const blob = await res.blob();
    const label = filename ?? `backtest-${runId.slice(0, 8)}-trades.csv`;
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = label;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } finally {
      URL.revokeObjectURL(url);
    }
  },

  async getBacktestEquity(runId: string) {
    return json<{ ok?: boolean; points?: unknown[] }>(
      await apiFetch(`${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}/equity-curve`),
    );
  },

  async getTrailTickAuditEstimate(runId: string) {
    return json<{ ok?: boolean; estimate?: unknown }>(
      await apiFetch(`${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}/trail-tick-audit/estimate`),
    );
  },

  async getTrailTickAudit(runId: string) {
    return json<{ ok?: boolean; audit?: unknown; running?: boolean }>(
      await apiFetch(`${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}/trail-tick-audit`),
    );
  },

  async runTrailTickAudit(
    runId: string,
    body?: { mode?: string; force?: boolean; forceInline?: boolean },
  ) {
    return json<{ ok?: boolean; started?: boolean; inline?: boolean; result?: unknown; reason?: string }>(
      await apiFetch(`${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}/trail-tick-audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
      }),
    );
  },

  async cancelBacktestRun(runId: string) {
    return json<{ ok?: boolean }>(
      await apiFetch(`${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }),
    );
  },

  /** Re-enqueue a run stuck in `queued` after API restart (orphaned in DB, not in worker pool). */
  async requeueBacktestRun(runId: string) {
    return json<{ ok?: boolean; requeued?: boolean; reason?: string }>(
      await apiFetch(`${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}/requeue`, { method: "POST" }),
    );
  },

  async deleteBacktestRun(runId: string) {
    return json<{ ok?: boolean }>(
      await apiFetch(`${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}`, { method: "DELETE" }),
    );
  },

  /** Train Supertrend XGBoost from a completed ST backtest run's trade features. */
  async trainSupertrendXgb(runId: string) {
    return json<{
      ok?: boolean;
      error?: string;
      runId?: string;
      nRows?: number;
      meta?: Record<string, unknown>;
      threshold?: number | null;
      canApply?: boolean;
    }>(
      await apiFetch(`${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}/xgb/train`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
  },

  /** Clone run with Supertrend XGB gate + locked threshold and enqueue re-sim. */
  async applySupertrendXgb(runId: string, body?: { threshold?: number }) {
    return json<{
      ok?: boolean;
      error?: string;
      runId?: string;
      threshold?: number;
      baselineRunId?: string;
    }>(
      await apiFetch(`${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}/xgb/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      }),
    );
  },

  async startStrategyTest(seedRunId: string) {
    return json<{ ok?: boolean; testId?: string; error?: string }>(
      await apiFetch(`${HTTP}/api/backtest/strategy-tests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seedRunId }),
      }),
    );
  },

  async listStrategyTests(limit = 20) {
    return json<{ ok?: boolean; tests?: unknown[] }>(
      await apiFetch(`${HTTP}/api/backtest/strategy-tests?limit=${limit}`),
    );
  },

  async getStrategyTest(testId: string) {
    return json<{ ok?: boolean; test?: unknown }>(
      await apiFetch(`${HTTP}/api/backtest/strategy-tests/${encodeURIComponent(testId)}`),
    );
  },

  async cancelStrategyTest(testId: string) {
    return json<{ ok?: boolean }>(
      await apiFetch(`${HTTP}/api/backtest/strategy-tests/${encodeURIComponent(testId)}/cancel`, {
        method: "POST",
      }),
    );
  },

  async deleteStrategyTest(testId: string) {
    return json<{ ok?: boolean }>(
      await apiFetch(`${HTTP}/api/backtest/strategy-tests/${encodeURIComponent(testId)}`, {
        method: "DELETE",
      }),
    );
  },

  async syncHistoricalData(body: {
    symbol: string;
    timeframe: string;
    from: string | number | Date;
    to?: string | number | Date;
    market?: "spot" | "futures";
    /** patch = remaining gaps from exact maxTs (default); full = re-fetch whole window */
    mode?: "patch" | "full";
  }) {
    return json<{
      ok?: boolean;
      async?: boolean;
      skipped?: boolean;
      resumed?: boolean;
      jobId?: string;
      status?: string;
      progressPct?: number;
      phase?: string | null;
      error?: string | null;
      mode?: string;
      remainingMs?: number;
      remainingDays?: number;
      klines?: { inserted?: number; gaps?: number };
      markKlines?: { inserted?: number; gaps?: number };
      funding?: { inserted?: number };
      fearGreed?: { inserted?: number };
      openInterest?: { inserted?: number };
      result?: unknown;
    }>(
      await apiFetch(`${HTTP}/api/backtest/data/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },

  async syncMarkHistoricalData(body: {
    symbol: string;
    from: string | number | Date;
    to?: string | number | Date;
    mode?: "patch" | "full";
  }) {
    return json<{
      ok?: boolean;
      async?: boolean;
      resumed?: boolean;
      jobId?: string;
      status?: string;
      progressPct?: number;
      phase?: string | null;
      error?: string | null;
      markKlines?: { inserted?: number; gaps?: number };
    }>(
      await apiFetch(`${HTTP}/api/backtest/data/sync-mark`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },

  async getDataSyncJob(jobId: string) {
    return json<{
      ok?: boolean;
      jobId?: string;
      kind?: string;
      status?: string;
      progressPct?: number;
      phase?: string | null;
      error?: string | null;
      mode?: string | null;
      remainingMs?: number | null;
      remainingDays?: number | null;
      result?: unknown;
    }>(await apiFetch(`${HTTP}/api/backtest/data/sync/${encodeURIComponent(jobId)}`));
  },

  async getActiveDataSyncJob(opts: {
    kind?: "ohlc" | "mark";
    symbol: string;
    timeframe?: string;
    market?: "futures" | "spot";
  }) {
    const q = new URLSearchParams({
      kind: opts.kind || "ohlc",
      symbol: opts.symbol,
    });
    if (opts.timeframe) q.set("timeframe", opts.timeframe);
    if (opts.market) q.set("market", opts.market);
    return json<{
      ok?: boolean;
      active?: {
        jobId?: string;
        kind?: string;
        status?: string;
        progressPct?: number;
        phase?: string | null;
        mode?: string | null;
        remainingMs?: number | null;
        remainingDays?: number | null;
        error?: string | null;
      } | null;
    }>(await apiFetch(`${HTTP}/api/backtest/data/sync-active?${q.toString()}`));
  },

  async getBacktestCandles(opts: {
    symbol: string;
    timeframe: string;
    from: string | number;
    to: string | number;
    market?: "futures" | "spot";
  }) {
    const q = new URLSearchParams({
      symbol: opts.symbol,
      timeframe: opts.timeframe,
      from: String(opts.from),
      to: String(opts.to),
    });
    if (opts.market) q.set("market", opts.market);
    return json<{
      ok?: boolean;
      candles?: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>;
    }>(await apiFetch(`${HTTP}/api/backtest/data/candles?${q.toString()}`));
  },

  async getDataCoverage(opts: {
    symbol: string;
    timeframe: string;
    from?: string;
    to?: string;
    market?: "futures" | "spot";
  }) {
    const q = new URLSearchParams({ symbol: opts.symbol, timeframe: opts.timeframe });
    if (opts.from) q.set("from", opts.from);
    if (opts.to) q.set("to", opts.to);
    if (opts.market) q.set("market", opts.market);
    return json<{
      ok?: boolean;
      coverage?: {
        have: number;
        expected: number | null;
        coveragePct: number | null;
        minTs: number | null;
        maxTs: number | null;
        remainingMs?: number | null;
        remainingDays?: number | null;
        remainingBars?: number | null;
        patchFrom?: number | null;
        patchTo?: number | null;
      };
      monthly?: Array<{ month: string; have: number; expected: number; coveragePct: number }>;
      markCoverage?: {
        have: number;
        expected: number | null;
        coveragePct: number | null;
        minTs: number | null;
        maxTs: number | null;
        remainingMs?: number | null;
        remainingDays?: number | null;
      };
      markMonthly?: Array<{ month: string; have: number; expected: number; coveragePct: number }>;
      patch?: {
        remainingMs?: number;
        remainingDays?: number;
        remainingBars?: number;
        patchFrom?: number | null;
        patchTo?: number | null;
      } | null;
      activeSync?: {
        jobId?: string;
        status?: string;
        progressPct?: number;
        phase?: string | null;
        mode?: string | null;
        remainingDays?: number | null;
      } | null;
      activeMarkSync?: {
        jobId?: string;
        status?: string;
        progressPct?: number;
        phase?: string | null;
      } | null;
    }>(await apiFetch(`${HTTP}/api/backtest/data/coverage?${q.toString()}`));
  },

  async getDataCoverageBatch(opts: { symbols: string[]; timeframe: string; from?: string; to?: string }) {
    const q = new URLSearchParams({
      symbols: opts.symbols.join(","),
      timeframe: opts.timeframe,
    });
    if (opts.from) q.set("from", opts.from);
    if (opts.to) q.set("to", opts.to);
    return json<{
      ok?: boolean;
      coverageBySymbol?: Record<
        string,
        { have: number; expected: number | null; coveragePct: number | null; minTs: number | null; maxTs: number | null }
      >;
    }>(await apiFetch(`${HTTP}/api/backtest/data/coverage-batch?${q.toString()}`));
  },

  async startOptimization(body: {
    strategyVersionId: string;
    botInstanceId?: string;
    symbol: string;
    timeframe: string;
    from: string | number | Date;
    to: string | number | Date;
    startingUsdt?: number;
    costModel?: Record<string, unknown>;
    gateMode?: "off" | "approx";
    paramGrid: Record<string, number[]>;
    walkForward?: { trainPct?: number };
  }) {
    return json<{ ok?: boolean; optimizationId?: string; runs?: number }>(
      await apiFetch(`${HTTP}/api/backtest/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },

  async getOptimization(optimizationId: string) {
    return json<{ ok?: boolean; optimization?: unknown; runs?: unknown[] }>(
      await apiFetch(`${HTTP}/api/backtest/optimize/${encodeURIComponent(optimizationId)}`),
    );
  },

  async promoteBacktestRun(runId: string, body: {
    modeSlug: string;
    label: string;
    capitalMode: "FIXED" | "PCT";
    capitalUsdt?: number;
    capitalPct?: number;
    ignoreThresholds?: boolean;
  }) {
    return json<{ ok?: boolean; strategyVersionId?: string; instanceId?: string; error?: string; message?: string }>(
      await apiFetch(`${HTTP}/api/backtest/promote/${encodeURIComponent(runId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },

  async getMarketIntelProviders(): Promise<MarketIntelProvidersStatus> {
    return json<MarketIntelProvidersStatus>(
      await apiFetch(`${HTTP}/api/market-intelligence/providers`),
    );
  },

  async putMarketIntelProviders(body: {
    finnhubApiKey?: string;
    cryptoquantApiKey?: string;
    whaleAlertApiKey?: string;
    aiBaseUrl?: string;
  }) {
    return json<{ ok?: boolean; error?: string; message?: string }>(
      await apiFetch(`${HTTP}/api/market-intelligence/providers`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },
};
