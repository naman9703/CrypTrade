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
  async marketCandles(opts?: { hours?: number; symbol?: string } | number) {
    const hours = typeof opts === "number" ? opts : opts?.hours ?? 24;
    const symbol = typeof opts === "number" ? undefined : opts?.symbol;
    const q = new URLSearchParams();
    q.set("hours", encodeURIComponent(String(hours)));
    if (symbol) q.set("symbol", String(symbol).toUpperCase());
    return json<any>(await apiFetch(`${HTTP}/api/market/candles?${q}`));
  },
  /** @param refresh When true, bypasses last cached snapshot and runs a fresh Binance scan. */
  async universeScan(refresh = false) {
    const q = refresh ? "?refresh=1" : "";
    return json<any>(await apiFetch(`${HTTP}/api/universe/scan${q}`));
  },
  /** Tradable USDT pairs for custom coin-base (spot or futures matches MARKET_FEED). */
  async universeSymbols() {
    return json<{ ok?: boolean; symbols?: string[]; error?: string }>(await apiFetch(`${HTTP}/api/universe/symbols`));
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
  async botConfig(patch: any) {
    const { useAppStore } = await import("../ws/store");
    const { mergeOptimisticBotPatch, tradingUiPersistBotSnapshot } = await import("../lib/tradingUiPersistence");
    const { tradingModeToApiModeSlug } = await import("../lib/tradingModeSlug");

    const patchObj =
      patch && typeof patch === "object" && !Array.isArray(patch) ? (patch as Record<string, unknown>) : {};
    const patchKeys = Object.keys(patchObj);
    const ignoredOnly = patchKeys.length > 0 && patchKeys.every((k) => k === "uiChartFocusSymbol");
    const prevBot = useAppStore.getState().bot as Record<string, unknown> | undefined;

    if (!ignoredOnly && patchKeys.length > 0) {
      const { noteBotConfigPatchInFlight, expandBotConfigPatch } = await import("../lib/configPatchInFlight");
      const patchExpanded = expandBotConfigPatch(patchObj);
      noteBotConfigPatchInFlight(patchObj);
      useAppStore.setState((s) => ({
        bot: mergeOptimisticBotPatch(s.bot as Record<string, unknown> | null | undefined, patchExpanded),
      }));
    }

    let data: any;
    try {
      data = await json<any>(
        await apiFetch(`${HTTP}/api/bot/config`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(patch),
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
      const { clearBotConfigPatchInFlightWhenAcked, applyBotConfigPatchInFlight } = await import(
        "../lib/configPatchInFlight",
      );
      clearBotConfigPatchInFlightWhenAcked(patchObj, botNext);
      const merged =
        useAppStore.getState().bot && typeof useAppStore.getState().bot === "object"
          ? { ...(useAppStore.getState().bot as Record<string, unknown>), ...botNext }
          : botNext;
      const { normalizeIntradayGatesOnBot } = await import("../lib/intradayGatesUi");
      tradingUiPersistBotSnapshot(useAppStore.getState().mode, merged, useAppStore.getState().authUiUserTag ?? null);
      useAppStore.setState({
        bot: normalizeIntradayGatesOnBot(applyBotConfigPatchInFlight(merged)),
      });
    } else {
      tradingUiPersistBotSnapshot(useAppStore.getState().mode, botNext, useAppStore.getState().authUiUserTag ?? null);
      useAppStore.setState((s) => ({
        bot: s.bot && typeof s.bot === "object" ? { ...(s.bot as Record<string, unknown>), ...botNext } : botNext,
      }));
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
  async saveStrategyConfigForMode(
    modeSlug: ApiTradingModeSlug,
    body: { action: "save" | "save_as_new"; name?: string; description?: string | null; tags?: string[]; label?: string | null },
  ) {
    return json<{ ok?: boolean; action?: "save" | "save_as_new"; strategy?: unknown; version?: unknown }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/strategy-config/save`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
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
    const data = await json<any>(
      await apiFetch(`${HTTP}/api/mode/set`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, confirm: true }),
      }),
    );
    if (data?.ok) {
      const [{ tradingUiPersistMode }, { useAppStore }] = await Promise.all([
        import("../lib/tradingUiPersistence"),
        import("../ws/store"),
      ]);
      tradingUiPersistMode(mode, useAppStore.getState().authUiUserTag ?? null);
    }
    return data;
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

  async getActiveStrategyForMode(modeSlug: ApiTradingModeSlug) {
    const data = await json<{ ok?: boolean; versionId?: string | null }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/active-strategy`),
    );
    return { versionId: data.versionId != null && String(data.versionId).length ? String(data.versionId) : null };
  },

  async setActiveStrategyForMode(modeSlug: ApiTradingModeSlug, versionId: string) {
    await json<{ ok?: boolean }>(
      await apiFetch(`${HTTP}/api/trading-modes/${encodeURIComponent(modeSlug)}/active-strategy`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ versionId }),
      }),
    );
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
  } | null> {
    const data = await json<{
      ok?: boolean;
      activeAccountByMode?: Record<string, string | null>;
      activeStrategyVersionByMode?: Record<string, string | null>;
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
    symbol: string;
    timeframe: string;
    from: string | number | Date;
    to: string | number | Date;
    startingUsdt?: number;
    label?: string;
    costModel?: Record<string, unknown>;
    gateMode?: "off" | "approx";
    walkForward?: { trainPct?: number };
    positionSizing?: "RISK_AT_SL" | "FULL_EQUITY_MARGIN";
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

  async getBacktestEquity(runId: string) {
    return json<{ ok?: boolean; points?: unknown[] }>(
      await apiFetch(`${HTTP}/api/backtest/runs/${encodeURIComponent(runId)}/equity-curve`),
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

  async syncHistoricalData(body: {
    symbol: string;
    timeframe: string;
    from: string | number | Date;
    to?: string | number | Date;
    market?: "spot" | "futures";
  }) {
    return json<{
      ok?: boolean;
      klines?: { inserted?: number; gaps?: number };
      funding?: { inserted?: number };
      fearGreed?: { inserted?: number };
      openInterest?: { inserted?: number };
    }>(
      await apiFetch(`${HTTP}/api/backtest/data/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  },

  async getBacktestCandles(opts: { symbol: string; timeframe: string; from: string | number; to: string | number }) {
    const q = new URLSearchParams({
      symbol: opts.symbol,
      timeframe: opts.timeframe,
      from: String(opts.from),
      to: String(opts.to),
    });
    return json<{
      ok?: boolean;
      candles?: Array<{ ts: number; open: number; high: number; low: number; close: number; volume: number }>;
    }>(await apiFetch(`${HTTP}/api/backtest/data/candles?${q.toString()}`));
  },

  async getDataCoverage(opts: { symbol: string; timeframe: string; from?: string; to?: string }) {
    const q = new URLSearchParams({ symbol: opts.symbol, timeframe: opts.timeframe });
    if (opts.from) q.set("from", opts.from);
    if (opts.to) q.set("to", opts.to);
    return json<{
      ok?: boolean;
      coverage?: { have: number; expected: number | null; coveragePct: number | null; minTs: number | null; maxTs: number | null };
      monthly?: Array<{ month: string; have: number; expected: number; coveragePct: number }>;
    }>(await apiFetch(`${HTTP}/api/backtest/data/coverage?${q.toString()}`));
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
