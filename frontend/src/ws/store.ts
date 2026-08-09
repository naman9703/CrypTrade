import { create } from "zustand";
import { api } from "../api/client";
import { tradingModeToApiModeSlug, type ApiTradingModeSlug } from "../lib/tradingModeSlug";
import { tradeRowInstanceId } from "../lib/instancePortfolioScope";
import type { Account, CreateAccountDto, UpdateAccountDto } from "../types/accounts";
import {
  enqueueServerUiPrefsPatch,
  loadTradingUiPrefs,
  mergePersistedBotPreferServer,
  tradingUiPersistShowMarketIntelligencePanel,
} from "../lib/tradingUiPersistence";
import { composeViewBotFromLiveAndDraft, noteBotConfigPatchInFlight } from "../lib/configPatchInFlight";
import { normalizeIntradayGatesOnBot } from "../lib/intradayGatesUi";
import type { CreateStrategyDto, Strategy, StrategyMetaPatch, StrategyVersion } from "../types/strategy";
import type { BotInstance, CreateInstanceDto } from "../types/instance";
import { mapApiStrategyVersion } from "../lib/strategyApiMappers";
import type { Trade } from "../types/trade";
import type { EquityCurvePoint, PerformanceCompareRow, StrategyPerformance } from "../types/performance";
import type { IntelligenceData } from "../types/intelligence";
import {
  canonicalCfgRawFromUiBot,
  instanceOperationalFromUiBot,
  instanceOperationalViewFingerprint,
  signalBrainBotFingerprint,
  signalBrainPersistBotsEqual,
} from "../lib/strategyBrainSnapshot";
import {
  mergeStrategyListWithRecentSave,
  noteStrategySaveWsAckGuard,
  recentSaveFromVersionRaw,
  runtimeBotOverlayFromPayload,
  type RecentStrategySave,
} from "../lib/syncStrategySave";
import {
  buildManualStrategySwitchPatch,
  extractProfileSliceFromBot,
} from "../lib/strategyConfigSlices.ts";
import { isPlausibleCandleClose, normalizeSym } from "../lib/symbolPriceSanity";
import { binanceIntervalMs } from "../lib/supertrend";
import { isIncomeLedgerClose, playProfitCloseSound } from "../lib/uiSounds";
import {
  activeInstanceIdForMode,
  buildBotViewFromInstanceSnapshot,
  draftForInstance,
  findInstanceInState,
  hasDraftForInstance,
  resolveStrategyVersionForInstance,
  warmInstanceConfigCachePatch,
} from "../lib/instanceConfigView";

/**
 * Prefer `activeStrategyVersionByMode`, but when the engine is driven by an instance
 * the mode-level version id in prefs can stay null while `bot_instances.strategy_version_id`
 * is authoritative — without this, `strategyConfigDirtyByMode` never turns true.
 */
function resolveActiveStrategyVersionId(
  s: {
    activeStrategyVersionByMode: Record<ApiTradingModeSlug, string | null>;
    activeInstanceByMode: Record<ApiTradingModeSlug, string | null>;
    instancesByMode: Partial<Record<ApiTradingModeSlug, BotInstance[]>>;
  },
  modeSlug: ApiTradingModeSlug,
): string | null {
  const direct = s.activeStrategyVersionByMode[modeSlug];
  if (typeof direct === "string" && direct.trim().length) return direct.trim();
  const iid = s.activeInstanceByMode[modeSlug];
  if (typeof iid === "string" && iid.trim().length) {
    const list = s.instancesByMode[modeSlug] ?? [];
    const inst = list.find((i) => i.id === iid);
    const vid = inst?.strategyVersionId;
    if (typeof vid === "string" && vid.trim().length) return vid.trim();
  }
  return null;
}

type Candle = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type MarketPayload = {
  symbol: string;
  timeframe: string;
  candle: Candle;
  indicators: Record<string, number>;
  regime: { type: string; atrPct: number; adx: number };
  supertrend?: { ts: number; up: number; dn: number; trend: number; line: number } | null;
  supertrendLine?: Array<{ time: number; value: number }>;
  /** Confirmed trend flips; last bar shown once wall-clock passes its interval (matches server k.x window). */
  supertrendSignals?: Array<{ time: number; side: "buy" | "sell" }>;
  /** Backend pauses autotrade only; chart still updates from buffer. */
  feedExecutionPause?: { reason: string; since: number } | null;
  mlctsLayerStatus?: Record<string, unknown>;
};

export type LogPayload = {
  level: "info" | "warn" | "error";
  msg: string;
  category?: string;
  reason?: string;
  source?: string;
  detail?: unknown;
  [k: string]: unknown;
};

type TradePayload = Record<string, unknown>;

export const CHART_CANDLE_MAX = 3000;

/** Must stay in line with backend TRADE_HISTORY_SNAPSHOT_MAX (default trade-ws log cap). */
const TRADE_HISTORY_UI_MAX = 4000;

function upsertTradesByInstanceMap(
  prevMap: Record<string, Trade[]>,
  row: unknown,
): Record<string, Trade[]> | undefined {
  const iid = tradeRowInstanceId(row);
  if (!iid || !row || typeof row !== "object") return undefined;
  const list = prevMap[iid] ?? [];
  const id = (row as { id?: unknown }).id;
  let nextList: Trade[];
  if (id != null && id !== "") {
    const idx = list.findIndex((t) => t?.id === id);
    if (idx >= 0) {
      nextList = list.slice();
      nextList[idx] = { ...list[idx], ...(row as Trade) };
    } else {
      nextList = [row as Trade, ...list].slice(0, TRADE_HISTORY_UI_MAX);
    }
  } else {
    nextList = [row as Trade, ...list].slice(0, TRADE_HISTORY_UI_MAX);
  }
  return { ...prevMap, [iid]: nextList };
}

type ChartSnapshotPayload = {
  symbol?: string;
  timeframe?: string;
  hours?: number;
  candles: Candle[];
  supertrend?: MarketPayload["supertrend"];
  supertrendLine?: MarketPayload["supertrendLine"];
  supertrendSignals?: MarketPayload["supertrendSignals"];
};

type HelloPayload = {
  serverTs: string;
  state: any;
  mode: string;
  chart?: ChartSnapshotPayload | null;
  /** Parallel engines: which TRADING_MODE bots are running. */
  runningByMode?: Record<string, boolean>;
  /** Server: selected DB account UUID per mode slug (Phase 2B). */
  activeAccountByMode?: Record<string, string | null>;
  /** Server: active strategy_versions.id per persistence slug (Phase 3B). */
  activeStrategyVersionByMode?: Record<string, string | null>;
  /** Server: active bot_instances.id per persistence slug (Phase 3C). */
  activeInstanceByMode?: Record<string, string | null>;
  /** When UI auth is on: stable key for per-user browser prefs (SHA-256 prefix of email on server). */
  uiUserTag?: string;
  /** True when trading mode is stored per login session (not shared across users). */
  perSessionTradingMode?: boolean;
};

type DepthPayload = {
  symbol: string;
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
};

type ExternalPayload = {
  ok: boolean;
  source: string;
  symbol: string;
  asOf: string;
  market?: { marketCapUsd?: number | null; volume24hUsd?: number | null; change24hPct?: number | null; athUsd?: number | null };
};

type WsState = {
  connected: boolean;
  lastError?: string;
};

type AppState = {
  ws: WsState;
  mode?: string;
  /** Target mode while POST /api/mode/set is in flight or WS has not confirmed the switch yet. */
  modeSwitchPending: string | null;
  /** When APP_UI_AUTH_ENABLED: server `/api/auth/me` + hello `uiUserTag` for scoped localStorage prefs. */
  authUiUserTag?: string | null;
  /** Server hello: session-scoped mode (each login has its own selected mode). */
  perSessionTradingMode?: boolean;
  /** Server: bot `running` flag per TRADING_MODE (parallel engines). */
  runningByMode?: Record<string, boolean>;
  /** Server/engine truth from WS/HTTP snapshots. */
  liveBot?: any;
  bot?: any;
  /** Unsaved strategy draft patches per mode (legacy — prefer per-instance). */
  draftBotPatchByMode: Record<ApiTradingModeSlug, Record<string, unknown>>;
  /** Unsaved strategy draft patches keyed by `bot_instances.id`. */
  draftBotPatchByInstanceId: Record<string, Record<string, unknown>>;
  /** Cached TradingPanel config per instance (instant tab switch). */
  configViewByInstanceId: Record<string, Record<string, unknown>>;
  /** Instance id currently awaiting `/active-instance` engine reload. */
  instanceConfigLoadingId: string | null;
  account?: any;
  positions?: any[];
  market?: MarketPayload;
  depth?: DepthPayload;
  external?: ExternalPayload;
  candles: Candle[];
  /** Multi-coin UI: main chart shows this symbol; null = follow `bot.symbol`. */
  chartDisplaySymbol: string | null;
  /** Incremented on each WS `hello` full `activityLog` replace so ActivityToasts can re-hydrate (no replay after reconnect/login). */
  activityLogBulkGeneration: number;
  logs: Array<{ ts: string } & LogPayload>;
  trades: TradePayload[];

  /** Phase 2A — trading accounts per mode (DB-backed). */
  accounts: Account[];
  selectedAccountId: string | null;
  /** Phase 2B — which account supplies exchange API keys per mode (from server prefs / hello). */
  activeAccountByMode: Record<ApiTradingModeSlug, string | null>;
  accountsLoading: boolean;
  accountsError: string | null;

  /** Phase 3B — versioned strategies (DB user session). */
  activeStrategyVersionByMode: Record<ApiTradingModeSlug, string | null>;
  /** Phase 3C — bot instance bound to engine when set. */
  activeInstanceByMode: Record<ApiTradingModeSlug, string | null>;
  instancesByMode: Partial<Record<ApiTradingModeSlug, BotInstance[]>>;
  instancesLoading: boolean;
  /** Phase 3E — DB-backed trades keyed by `bot_instances.id`. */
  tradesByInstance: Record<string, Trade[]>;
  tradesLoadingByInstance: Record<string, boolean>;
  selectedInstanceId: string | null;
  strategiesByMode: Partial<Record<ApiTradingModeSlug, Strategy[]>>;
  versionsByStrategyId: Record<string, StrategyVersion[]>;
  selectedStrategyId: string | null;
  strategiesLoading: boolean;
  strategiesError: string | null;
  /** Collapsible sidebars; `layout` also mirrored to `users.ui_prefs` when sync allowed. */
  layout: {
    accountsSidebarCollapsed: boolean;
    strategySidebarCollapsed: boolean;
    instancesPanelCollapsed: boolean;
  };
  /** Main view: 'overview' is the default landing (analytics/instances list); 'instance' is the full trading UI for a selected instance; 'backtest' is the backtest workbench. */
  mainView: "overview" | "instance" | "backtest";
  /** Live progress map for backtest runs, keyed by runId. WS-driven; pages refresh detail via REST on completion. */
  backtestProgress: Record<string, { progressPct: number; status?: string; error?: string }>;
  /** Tick trailing audit progress keyed by backtest runId. */
  trailTickAuditProgress: Record<
    string,
    { progressPct: number; status?: string; error?: string; phase?: string; detail?: string }
  >;
  /** Market intelligence data keyed by symbol. */
  intelligence: Record<string, IntelligenceData>;
  /** When true, Market Intelligence is shown under the chart order book (instance trading UI only). */
  showMarketIntelligencePanel: boolean;
  /** True when live bot signal-brain fields differ from the active saved strategy version. */
  strategyConfigDirtyByMode: Record<ApiTradingModeSlug, boolean>;
  /** Latest Save response cfg — shields list refetch from overwriting fresh DB snapshot. */
  recentStrategySaveByMode: Partial<Record<ApiTradingModeSlug, RecentStrategySave>>;
  /** Isolated strategy-config view for TradingPanel — updated only when signal brain changes. */
  configViewByMode: Partial<Record<ApiTradingModeSlug, Record<string, unknown>>>;
  /** Monotonic revision; TradingPanel subscribes to this instead of full `bot`. */
  configViewSeqByMode: Partial<Record<ApiTradingModeSlug, number>>;
  /** Pre-built Save POST body — avoids main-thread serialize at click time. */
  strategySavePayloadByMode: Partial<
    Record<
      ApiTradingModeSlug,
      { cfgRaw: Record<string, unknown>; instanceOperational: Record<string, unknown> }
    >
  >;

  /** Unsaved per-path slices while switching manualStrategy on one strategy record. */
  strategySliceDraftByMode: Partial<Record<ApiTradingModeSlug, Record<string, Record<string, unknown>>>>;

  /** Compare stripped signal-brain vs active `strategy_versions.cfg_raw` for `modeSlug`. */
  recomputeStrategyConfigDirtyForMode: (modeSlug: ApiTradingModeSlug) => void;
  /** Clear dirty + sync saved cfg baseline from current bot (call right after Save). */
  markStrategyConfigCleanForMode: (modeSlug: ApiTradingModeSlug) => void;
  /** Patch in-memory strategy version cfg after Save so dirty clears before the next list fetch. */
  mergeStrategyVersionFromSaveResponse: (modeSlug: ApiTradingModeSlug, versionRaw: unknown) => void;
  /** Authoritative post-Save sync: store cfg, live bot, WS guards, dirty=false. */
  applyStrategySaveResponse: (
    modeSlug: ApiTradingModeSlug,
    versionRaw: unknown,
    botRaw: Record<string, unknown> | null | undefined,
  ) => void;

  connect: () => void;
  setBot: (bot: any) => void;
  stageDraftBotPatch: (modeSlug: ApiTradingModeSlug, patch: Record<string, unknown>) => void;
  /** Replace staged draft (presets) instead of merging onto prior draft keys. */
  replaceDraftBotPatch: (modeSlug: ApiTradingModeSlug, patch: Record<string, unknown>) => void;
  clearDraftBotPatch: (modeSlug: ApiTradingModeSlug) => void;
  getDraftBotPatch: (modeSlug: ApiTradingModeSlug) => Record<string, unknown>;
  hasDraftBotPatch: (modeSlug: ApiTradingModeSlug) => boolean;
  switchManualStrategyPath: (modeSlug: ApiTradingModeSlug, newManualStrategy: string) => void;
  setChartDisplaySymbol: (sym: string | null) => void;
  /** Push `chartDisplaySymbol` to server when WS/HTTP ack drifted (HMR, failed prior sync). */
  ensureChartFocusSynced: () => void;
  pushLog: (p: LogPayload) => void;
  fetchAccountsForMode: (modeSlug: ApiTradingModeSlug) => Promise<void>;
  selectAccount: (accountId: string | null) => void;
  setActiveAccountForMode: (modeSlug: ApiTradingModeSlug, accountId: string) => Promise<void>;
  createAccount: (modeSlug: ApiTradingModeSlug, data: CreateAccountDto) => Promise<Account>;
  updateAccount: (accountId: string, patch: UpdateAccountDto) => Promise<Account>;
  deactivateAccount: (accountId: string) => Promise<void>;

  fetchStrategiesForMode: (
    modeSlug: ApiTradingModeSlug,
    opts?: { includeArchived?: boolean; skipDirtyRecompute?: boolean },
  ) => Promise<void>;
  fetchVersionsForStrategy: (strategyId: string) => Promise<void>;
  selectStrategy: (strategyId: string | null) => void;
  createStrategyForMode: (modeSlug: ApiTradingModeSlug, dto: CreateStrategyDto) => Promise<{ strategy: Strategy }>;
  updateStrategyMetaStore: (strategyId: string, patch: StrategyMetaPatch) => Promise<Strategy>;
  archiveStrategyStore: (strategyId: string) => Promise<void>;
  cloneStrategyAsNewStore: (sourceStrategyId: string, name: string) => Promise<Strategy>;
  bindInstanceStrategyStore: (instanceId: string, strategyId: string) => Promise<void>;
  saveNewStrategyVersionSnapshot: (strategyId: string, label?: string) => Promise<StrategyVersion>;
  cloneStrategyVersionStore: (
    strategyId: string,
    versionId: string,
    opts?: { targetStrategyId?: string; label?: string },
  ) => Promise<StrategyVersion>;
  setActiveStrategyVersionForMode: (modeSlug: ApiTradingModeSlug, versionId: string) => Promise<void>;
  fetchInstancesForMode: (modeSlug: ApiTradingModeSlug) => Promise<void>;
  createInstanceStore: (modeSlug: ApiTradingModeSlug, dto: CreateInstanceDto) => Promise<BotInstance>;
  deleteInstanceStore: (instanceId: string) => Promise<void>;
  setActiveTradingInstanceForMode: (
    modeSlug: ApiTradingModeSlug,
    instanceId: string | null,
    opts?: { switchToken?: number; skipOptimistic?: boolean },
  ) => Promise<void>;
  selectInstance: (instanceId: string | null) => void;
  /** Returns number of trades returned in this request (0 on error). */
  fetchTradesForInstance: (instanceId: string, opts?: { limit?: number; append?: boolean }) => Promise<number>;
  setSidebarCollapsed: (which: "accounts" | "strategy", collapsed: boolean) => void;
  setInstancesPanelCollapsed: (collapsed: boolean) => void;
  hydrateLayoutFromServer: (layout: unknown) => void;
  setMainView: (v: "overview" | "instance" | "backtest") => void;
  setBacktestProgress: (runId: string, patch: { progressPct?: number; status?: string; error?: string }) => void;
  setTrailTickAuditProgress: (
    runId: string,
    patch: { progressPct?: number; status?: string; error?: string; phase?: string; detail?: string },
  ) => void;
  setShowMarketIntelligencePanel: (show: boolean) => void;
  fetchIntelligence: (symbol: string) => Promise<void>;
  /** Navigate into the full trading UI for a specific instance. */
  enterInstance: (instanceId: string) => Promise<void>;
};

export function parseActiveAccountByModeFromServer(raw: unknown): Record<ApiTradingModeSlug, string | null> {
  const slugs: ApiTradingModeSlug[] = ["paper", "demo_api", "testnet", "live"];
  const out: Record<ApiTradingModeSlug, string | null> = {
    paper: null,
    demo_api: null,
    testnet: null,
    live: null,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const k of slugs) {
    const v = o[k];
    out[k] = typeof v === "string" && v.length > 0 ? v : null;
  }
  return out;
}

export function parseActiveStrategyVersionByModeFromServer(raw: unknown): Record<ApiTradingModeSlug, string | null> {
  const slugs: ApiTradingModeSlug[] = ["paper", "demo_api", "testnet", "live"];
  const out: Record<ApiTradingModeSlug, string | null> = {
    paper: null,
    demo_api: null,
    testnet: null,
    live: null,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const k of slugs) {
    const v = o[k];
    out[k] = typeof v === "string" && v.length > 0 ? v : null;
  }
  return out;
}

export function parseActiveInstanceByModeFromServer(raw: unknown): Record<ApiTradingModeSlug, string | null> {
  const slugs: ApiTradingModeSlug[] = ["paper", "demo_api", "testnet", "live"];
  const out: Record<ApiTradingModeSlug, string | null> = {
    paper: null,
    demo_api: null,
    testnet: null,
    live: null,
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const o = raw as Record<string, unknown>;
  for (const k of slugs) {
    const v = o[k];
    out[k] = typeof v === "string" && v.length > 0 ? v : null;
  }
  return out;
}

/** Merge a patched `BotInstance` (e.g. from `PATCH .../operational-config`) into sidebar lists. */
export function patchInstanceInByMode(
  byMode: Partial<Record<ApiTradingModeSlug, BotInstance[]>>,
  instanceId: string,
  patch: Partial<BotInstance>,
): Partial<Record<ApiTradingModeSlug, BotInstance[]>> {
  const next: Partial<Record<ApiTradingModeSlug, BotInstance[]>> = { ...byMode };
  const slugs: ApiTradingModeSlug[] = ["paper", "demo_api", "testnet", "live"];
  for (const slug of slugs) {
    const list = next[slug];
    if (!list?.length) continue;
    const idx = list.findIndex((i) => i.id === instanceId);
    if (idx < 0) continue;
    const copy = [...list];
    const prev = copy[idx];
    const allotIn = patch.allotment;
    const mergedAllotment =
      allotIn && prev.allotment
        ? { ...prev.allotment, ...allotIn }
        : allotIn !== undefined
          ? allotIn
          : prev.allotment;
    copy[idx] = { ...prev, ...patch, allotment: mergedAllotment };
    next[slug] = copy;
  }
  return next;
}

function defaultDevWsUrl() {
  if (typeof window === "undefined") return "ws://localhost:5173/ws";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

/** Production build served from the same host as the API (e.g. Railway single service). */
function productionSameOriginWsUrl() {
  if (typeof window === "undefined") return "ws://127.0.0.1:8000/ws";
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

/** Split deploy: derive wss:// from VITE_BACKEND_HTTP when VITE_BACKEND_WS omitted. */
function wsUrlFromBackendHttp(): string | null {
  const raw = import.meta.env.VITE_BACKEND_HTTP;
  if (!raw || typeof raw !== "string") return null;
  const base = raw.trim().replace(/\/$/, "");
  if (!base) return null;
  try {
    const u = new URL(base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/ws";
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Resolve WSS URL at connect time (not only at module load) so `window.location` is final.
 *
 * Production checklist (monolith + UI auth):
 * 1. Browser page is same host as API (e.g. https://host/ from Caddy → Node :8000).
 * 2. `new WebSocket(wss://host/ws)` — session cookie `trading.sid` must be sent (login on same host; Secure + HTTPS).
 * 3. Edge proxy must upgrade Upgrade: websocket → Node returns 101 (Caddy/nginx config).
 * 4. Empty `VITE_BACKEND_WS` / `ENV VITE_BACKEND_WS=` must not become `new WebSocket("")` — normalize below.
 */
export function resolveWebSocketConnectUrl(): string {
  const viteWsOverride = String(import.meta.env.VITE_BACKEND_WS ?? "").trim();
  if (viteWsOverride) return viteWsOverride;
  const fromHttp = wsUrlFromBackendHttp();
  if (fromHttp) return fromHttp;
  if (import.meta.env.DEV) return defaultDevWsUrl();
  return productionSameOriginWsUrl();
}

const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
let wsReconnectDelay = WS_RECONNECT_BASE_MS;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** When true, the next `onclose` must not schedule reconnect (logout / auth gate). */
let wsIntentionalClose = false;

/**
 * Coalesce burst `market` WS frames to one store commit per microtask (not rAF — rAF is throttled in
 * background tabs). **Per-symbol map**: a single `pendingMarketPayload` would drop all but the last frame;
 * when the server emits primary + alt pairs in the same tick (tick + multiplex live push), the wrong
 * symbol could win and the chart tab would stop updating (merge rejects non-view symbols).
 */
let pendingMarketBySymbol: Map<string, MarketPayload> | null = null;
/** Latest WS `market` tick per symbol — flush batches often carry one alt pair; chart view still merges from cache. */
let lastMarketTickBySymbol = new Map<string, MarketPayload>();
let pendingMarketFlushScheduled = false;
/** Last-wins coalesce for burst `state` frames (multiplex + tick can emit several/sec — log showed e.g. state:3 + market:7 in one wall second). */
let pendingWsStatePayload: unknown = undefined;
let pendingStateFlushScheduled = false;
/** Last-wins coalesce for burst `depth` frames (same multiplex pattern). */
let pendingDepthPayload: DepthPayload | null = null;
let pendingDepthFlushScheduled = false;
/** Monotonic id for activity log rows so prepending does not shift React keys (avoids list remount flicker). */
let nextActivityLogLid = 1;
/** Debounce `POST /api/bot/config` when multi-coin chart tab changes (server multiplex + `market` routing). */
let chartFocusSyncTimer: ReturnType<typeof setTimeout> | null = null;
let chartFocusSyncRetryTimer: ReturnType<typeof setTimeout> | null = null;
let chartFocusSyncQueued: string | null | undefined = undefined;
let chartFocusSyncFailStreak = 0;
let lastChartFocusSentNorm = "";
/** Optimistic + server-confirmed focus norm. Empty = cleared/primary. */
let lastChartFocusAckNorm = "";
let chartFocusAbort: AbortController | null = null;

/** Drop buffered WS market ticks so a mode switch cannot repaint the previous venue’s candles. */
export function resetChartSessionForModeSwitch() {
  pendingMarketFlushScheduled = false;
  pendingMarketBySymbol = null;
  lastMarketTickBySymbol = new Map();
}

/** Clear mode-switch loader once server-reported mode matches the pending target. */
export function maybeClearModeSwitchPending(confirmedMode: string | undefined | null) {
  const pending = useAppStore.getState().modeSwitchPending;
  if (!pending) return;
  const want = String(pending).toUpperCase();
  const got = String(confirmedMode || "").toUpperCase();
  if (want && got === want) {
    useAppStore.setState({ modeSwitchPending: null });
  }
}

function isChartFocusAbortError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === "AbortError") return true;
  if (err instanceof Error && err.name === "AbortError") return true;
  return false;
}

/** Primary tab / null chart override → clear server alt focus (null), not `uiChartFocusSymbol: primary`. */
function resolveChartFocusSyncSymbol(chartSym: string | null | undefined): string | null {
  const primaryNorm = normalizeSym(String(useAppStore.getState().bot?.symbol ?? ""));
  if (chartSym == null || !String(chartSym).trim()) return null;
  const norm = normalizeSym(String(chartSym));
  if (primaryNorm && norm === primaryNorm) return null;
  return normWsSym(String(chartSym));
}

function noteChartFocusAckFromServer(raw: string | null | undefined) {
  if (raw == null || !String(raw).trim()) {
    lastChartFocusAckNorm = "";
    return;
  }
  lastChartFocusAckNorm = normalizeSym(String(raw));
}

/** Tab click applies focus locally immediately — UI must not wait on HTTP/WS round-trips. */
function applyOptimisticChartFocus(sym: string | null) {
  const syncSym = resolveChartFocusSyncSymbol(sym);
  noteChartFocusAckFromServer(syncSym);
  if (syncSym != null) lastChartFocusSentNorm = normalizeSym(syncSym);
  else lastChartFocusSentNorm = "";
  useAppStore.setState((s) => {
    const live =
      s.liveBot && typeof s.liveBot === "object" && !Array.isArray(s.liveBot)
        ? { ...(s.liveBot as Record<string, unknown>) }
        : {};
    live.uiChartFocusSymbol = syncSym;
    return {
      liveBot: live,
      bot: deriveViewBot(s.mode, live, draftByModeWithInstanceContext(s, tradingModeToApiModeSlug(String(s.mode ?? "")))),
    };
  });
}

function shouldIgnoreStaleWsChartFocusAck(
  ack: unknown,
  chartDisplaySymbol: string | null,
  botSymbol: string | undefined,
): boolean {
  const clientTarget = resolveChartFocusSyncSymbol(chartDisplaySymbol);
  const clientNorm = clientTarget != null ? normalizeSym(clientTarget) : "";
  const primaryNorm = normalizeSym(String(botSymbol ?? ""));
  const ackNorm = ack != null && String(ack).trim() ? normalizeSym(String(ack)) : "";
  const optimisticNorm = lastChartFocusAckNorm;
  if (clientNorm && optimisticNorm === clientNorm && ackNorm !== clientNorm) return true;
  if (!clientNorm && ackNorm && ackNorm !== primaryNorm && optimisticNorm !== ackNorm) return true;
  return false;
}

function scheduleChartFocusRetry(failed: boolean) {
  if (chartFocusSyncQueued === undefined) return;
  if (chartFocusSyncRetryTimer != null) return;
  const delay = failed
    ? Math.min(8000, 250 * 2 ** Math.min(chartFocusSyncFailStreak, 5))
    : 0;
  chartFocusSyncRetryTimer = setTimeout(() => {
    chartFocusSyncRetryTimer = null;
    flushChartFocusToServer();
  }, delay);
}

function flushChartFocusToServer() {
  const sym = chartFocusSyncQueued;
  chartFocusSyncQueued = undefined;
  if (sym === undefined) return;
  const symNorm = sym != null ? normalizeSym(sym) : "";
  chartFocusAbort?.abort();
  const abortCtrl = new AbortController();
  chartFocusAbort = abortCtrl;
  let flushFailed = false;
  void api
    .botChartFocus(sym, {
      signal: abortCtrl.signal,
    })
    .then((data) => {
      if (!data?.ok) {
        throw new Error("chart focus not acked");
      }
      chartFocusSyncFailStreak = 0;
      if (symNorm) lastChartFocusSentNorm = symNorm;
      else lastChartFocusSentNorm = "";
      const ackRaw = data.uiChartFocusSymbol;
      noteChartFocusAckFromServer(
        ackRaw != null && String(ackRaw).trim() ? String(ackRaw) : sym,
      );
    })
    .catch((err: unknown) => {
      if (isChartFocusAbortError(err)) return;
      flushFailed = true;
      chartFocusSyncFailStreak += 1;
      chartFocusSyncQueued = sym;
    })
    .finally(() => {
      if (chartFocusAbort !== abortCtrl) return;
      chartFocusAbort = null;
      if (chartFocusSyncQueued !== undefined) scheduleChartFocusRetry(flushFailed);
    });
}

function queueChartFocusSync(sym: string | null, opts?: { immediate?: boolean }) {
  chartFocusSyncQueued = resolveChartFocusSyncSymbol(sym);
  if (chartFocusSyncTimer) clearTimeout(chartFocusSyncTimer);
  if (opts?.immediate === true) {
    flushChartFocusToServer();
    return;
  }
  /** Coalesce rapid tab clicks — one HTTP round-trip for the final symbol (server also coalesces). */
  chartFocusSyncTimer = setTimeout(() => {
    chartFocusSyncTimer = null;
    flushChartFocusToServer();
  }, 280);
}

/** One-shot: push saved mode + /api/bot/config after load (hello or first HTTP hydrate). */
let tradingUiSessionRestoreStarted = false;

/**
 * In-flight request dedup: several components (InstanceNavBar, OverviewPage,
 * StrategySidebar, AccountWidget) mount together and each fired the same
 * strategies/instances/accounts fetch — 4-6 identical GETs per mode on load.
 * Coalesce concurrent calls per mode into a single network request.
 */
const inFlightStrategiesFetch = new Map<string, Promise<void>>();
const inFlightInstancesFetch = new Map<string, Promise<void>>();
const inFlightAccountsFetch = new Map<string, Promise<void>>();

let strategyDirtyRecomputeTimer: ReturnType<typeof setTimeout> | null = null;
let instanceSwitchToken = 0;
let strategyDirtyRecomputeSlug: ApiTradingModeSlug | null = null;
/** Per-mode signal-brain fingerprint — skip dirty work when WS only updates runtime fields. */
const signalBrainFpByMode = new Map<string, string>();

/** Rebuild isolated config view + cached Save payload when signal brain changes. */
function strategyConfigSlicePatch(
  mode: string | undefined,
  modeSlug: ApiTradingModeSlug,
  live: Record<string, unknown>,
  draftByMode: Record<ApiTradingModeSlug, Record<string, unknown>>,
  prev: Pick<AppState, "configViewByMode" | "configViewSeqByMode" | "strategySavePayloadByMode">,
): Pick<AppState, "configViewByMode" | "configViewSeqByMode" | "strategySavePayloadByMode" | "bot"> | null {
  const view = normalizeIntradayGatesOnBot(deriveViewBot(mode, live, draftByMode));
  const fp = signalBrainBotFingerprint(view);
  const opFp = instanceOperationalViewFingerprint(view);
  const prevView = prev.configViewByMode[modeSlug];
  if (
    prevView &&
    fp === signalBrainBotFingerprint(prevView) &&
    opFp === instanceOperationalViewFingerprint(prevView)
  ) {
    return null;
  }
  return buildStrategyConfigViewSlice(mode, modeSlug, view, prev);
}

/** Always refresh config view + Save payload (draft edits must not skip on fingerprint cache). */
function buildStrategyConfigViewSlice(
  mode: string | undefined,
  modeSlug: ApiTradingModeSlug,
  view: Record<string, unknown>,
  prev: Pick<AppState, "configViewByMode" | "configViewSeqByMode" | "strategySavePayloadByMode" | "configViewByInstanceId">,
  instanceId?: string | null,
): Pick<AppState, "configViewByMode" | "configViewSeqByMode" | "strategySavePayloadByMode" | "bot" | "configViewByInstanceId"> {
  const seq = (prev.configViewSeqByMode[modeSlug] ?? 0) + 1;
  signalBrainFpByMode.set(modeSlug, signalBrainBotFingerprint(view));
  return {
    bot: view,
    configViewByMode: { ...prev.configViewByMode, [modeSlug]: view },
    configViewSeqByMode: { ...prev.configViewSeqByMode, [modeSlug]: seq },
    strategySavePayloadByMode: {
      ...prev.strategySavePayloadByMode,
      [modeSlug]: {
        cfgRaw: canonicalCfgRawFromUiBot(view),
        instanceOperational: instanceOperationalFromUiBot(view),
      },
    },
    ...(instanceId
      ? { configViewByInstanceId: { ...prev.configViewByInstanceId, [instanceId]: view } }
      : {}),
  };
}

/** Refresh isolated config view after live bot + draft merge (e.g. botConfig HTTP ack). */
export function refreshStrategyConfigViewSlice(
  prev: Pick<
    AppState,
    | "mode"
    | "configViewByMode"
    | "configViewSeqByMode"
    | "strategySavePayloadByMode"
    | "configViewByInstanceId"
    | "activeInstanceByMode"
    | "selectedInstanceId"
    | "instanceConfigLoadingId"
    | "mainView"
  >,
  modeSlug: ApiTradingModeSlug,
  view: Record<string, unknown>,
  instanceId?: string | null,
): Pick<
  AppState,
  "configViewByMode" | "configViewSeqByMode" | "strategySavePayloadByMode" | "bot" | "configViewByInstanceId"
> {
  const iid = instanceId ?? activeInstanceIdForMode(prev, modeSlug);
  return buildStrategyConfigViewSlice(prev.mode, modeSlug, view, prev, iid);
}

/** Merge engine bot snapshot into store + isolated config view (hello, instance switch, version activate). */
export function mergeEngineBotSnapshot(
  prev: AppState,
  modeSlug: ApiTradingModeSlug,
  botNext: Record<string, unknown>,
  opts?: { clearDraft?: boolean; markConfigClean?: boolean; instanceId?: string | null },
): Partial<AppState> {
  const instanceId = opts?.instanceId ?? activeInstanceIdForMode(prev, modeSlug);
  let draftBotPatchByInstanceId = prev.draftBotPatchByInstanceId ?? {};
  if (opts?.clearDraft !== false && instanceId) {
    draftBotPatchByInstanceId = { ...draftBotPatchByInstanceId, [instanceId]: {} };
  }
  const draftCtx = draftByModeWithInstanceContext(
    { ...prev, draftBotPatchByInstanceId },
    modeSlug,
  );
  const view = normalizeIntradayGatesOnBot(deriveViewBot(prev.mode, botNext, draftCtx));
  const slice = buildStrategyConfigViewSlice(prev.mode, modeSlug, view, prev, instanceId);
  return {
    liveBot: botNext,
    draftBotPatchByInstanceId,
    ...(opts?.clearDraft !== false ? { draftBotPatchByMode: { ...prev.draftBotPatchByMode, [modeSlug]: {} } } : {}),
    ...(opts?.markConfigClean
      ? { strategyConfigDirtyByMode: { ...prev.strategyConfigDirtyByMode, [modeSlug]: false } }
      : {}),
    bot: slice.bot,
    configViewByMode: slice.configViewByMode,
    configViewSeqByMode: slice.configViewSeqByMode,
    strategySavePayloadByMode: slice.strategySavePayloadByMode,
    configViewByInstanceId: slice.configViewByInstanceId ?? prev.configViewByInstanceId,
  };
}

/** Instance-aware draft map for deriveViewBot (exported for api/client + staged saves). */
export function draftByModeWithInstanceContext(
  s: Pick<
    AppState,
    | "draftBotPatchByMode"
    | "draftBotPatchByInstanceId"
    | "activeInstanceByMode"
    | "selectedInstanceId"
    | "instanceConfigLoadingId"
    | "mainView"
  >,
  modeSlug: ApiTradingModeSlug,
): Record<ApiTradingModeSlug, Record<string, unknown>> {
  return { ...s.draftBotPatchByMode, [modeSlug]: effectiveDraftForMode(s, modeSlug) };
}

function effectiveDraftForMode(
  s: Pick<
    AppState,
    | "draftBotPatchByMode"
    | "draftBotPatchByInstanceId"
    | "activeInstanceByMode"
    | "selectedInstanceId"
    | "instanceConfigLoadingId"
    | "mainView"
  >,
  modeSlug: ApiTradingModeSlug,
): Record<string, unknown> {
  const iid = activeInstanceIdForMode(s, modeSlug);
  if (iid) return draftForInstance(s.draftBotPatchByInstanceId ?? {}, iid);
  return s.draftBotPatchByMode[modeSlug] ?? {};
}

function hasActiveConfigDraftForMode(
  s: Pick<
    AppState,
    | "draftBotPatchByMode"
    | "draftBotPatchByInstanceId"
    | "activeInstanceByMode"
    | "selectedInstanceId"
    | "instanceConfigLoadingId"
    | "mainView"
  >,
  modeSlug: ApiTradingModeSlug,
): boolean {
  const iid = activeInstanceIdForMode(s, modeSlug);
  if (iid) return hasDraftForInstance(s.draftBotPatchByInstanceId ?? {}, iid);
  return Object.keys(s.draftBotPatchByMode[modeSlug] ?? {}).length > 0;
}

function applyOptimisticInstanceConfig(
  s: AppState,
  modeSlug: ApiTradingModeSlug,
  instanceId: string,
): Partial<AppState> | null {
  const optimistic = buildBotViewFromInstanceSnapshot(s, modeSlug, instanceId);
  if (!optimistic) return null;
  const draft = draftForInstance(s.draftBotPatchByInstanceId ?? {}, instanceId);
  const view = normalizeIntradayGatesOnBot(composeViewBotFromLiveAndDraft(optimistic, draft));
  const slice = buildStrategyConfigViewSlice(s.mode, modeSlug, view, s, instanceId);
  return {
    activeInstanceByMode: { ...s.activeInstanceByMode, [modeSlug]: instanceId },
    configViewByInstanceId: { ...s.configViewByInstanceId, [instanceId]: view },
    ...slice,
  };
}

function mergeWarmInstanceConfigCache(
  s: AppState,
  modeSlug: ApiTradingModeSlug,
): Partial<AppState> {
  const warm = warmInstanceConfigCachePatch(s, modeSlug);
  return warm ? { configViewByInstanceId: warm } : {};
}

function hasActiveConfigDraft(
  draftByMode: Record<ApiTradingModeSlug, Record<string, unknown>>,
  modeSlug: ApiTradingModeSlug,
): boolean {
  return Object.keys(draftByMode[modeSlug] ?? {}).length > 0;
}

function scheduleStrategyConfigDirtyRecompute(modeSlug: ApiTradingModeSlug, opts?: { force?: boolean }) {
  const st = useAppStore.getState();
  if (!opts?.force) {
    if (hasActiveConfigDraftForMode(st, modeSlug)) return;
    const bot = useAppStore.getState().bot;
    const fp = signalBrainBotFingerprint(bot);
    const prev = signalBrainFpByMode.get(modeSlug);
    if (prev === fp) return;
    signalBrainFpByMode.set(modeSlug, fp);
  }
  strategyDirtyRecomputeSlug = modeSlug;
  if (strategyDirtyRecomputeTimer) clearTimeout(strategyDirtyRecomputeTimer);
  strategyDirtyRecomputeTimer = setTimeout(() => {
    strategyDirtyRecomputeTimer = null;
    const slug = strategyDirtyRecomputeSlug;
    strategyDirtyRecomputeSlug = null;
    if (slug) useAppStore.getState().recomputeStrategyConfigDirtyForMode(slug);
  }, 400);
}

function scheduleStrategyConfigDirtyRecomputeFromBot(modeSlug: ApiTradingModeSlug, bot: unknown) {
  const st = useAppStore.getState();
  /** Unsaved draft ⇒ dirty is already true; skip expensive equal check on every WS tick. */
  if (hasActiveConfigDraftForMode(st, modeSlug)) return;
  const fp = signalBrainBotFingerprint(bot);
  const prev = signalBrainFpByMode.get(modeSlug);
  if (prev === fp) return;
  signalBrainFpByMode.set(modeSlug, fp);
  scheduleStrategyConfigDirtyRecompute(modeSlug);
}

/** Authoritative UI bot: guarded live WS/HTTP truth, then unsaved draft wins on top. */
export function deriveViewBot(
  mode: string | undefined,
  liveBot: Record<string, unknown> | undefined,
  draftByMode: Record<ApiTradingModeSlug, Record<string, unknown>>,
): Record<string, unknown> {
  const modeSlug = tradingModeToApiModeSlug(String(mode ?? ""));
  const draft = draftByMode[modeSlug] ?? {};
  const live =
    liveBot && typeof liveBot === "object" && !Array.isArray(liveBot) ? liveBot : {};
  return normalizeIntradayGatesOnBot(composeViewBotFromLiveAndDraft(live, draft));
}

function scheduleWsStateFlush() {
  if (pendingStateFlushScheduled) return;
  pendingStateFlushScheduled = true;
  queueMicrotask(() => {
    pendingStateFlushScheduled = false;
    const p = pendingWsStatePayload;
    pendingWsStatePayload = undefined;
    if (p !== undefined) applyWsStateSnapshot(p);
  });
}

function scheduleDepthFlush() {
  if (pendingDepthFlushScheduled) return;
  pendingDepthFlushScheduled = true;
  queueMicrotask(() => {
    pendingDepthFlushScheduled = false;
    const d = pendingDepthPayload;
    pendingDepthPayload = null;
    if (d) {
      const st = useAppStore.getState();
      const chartSym = normalizeSym(st.chartDisplaySymbol ?? st.bot?.symbol);
      const depthSym = normalizeSym(d.symbol);
      if (chartSym && depthSym && chartSym !== depthSym) {
        const storeDepthSym = normalizeSym(st.depth?.symbol);
        if (storeDepthSym !== chartSym) {
          useAppStore.setState({
            depth: {
              symbol: st.chartDisplaySymbol ?? chartSym,
              bids: [],
              asks: [],
            },
          });
        }
        return;
      }
      useAppStore.setState({ depth: d });
    }
  });
}

function scheduleTradingUiSessionRestore(serverMode: string) {
  if (typeof window === "undefined" || tradingUiSessionRestoreStarted) return;
  const tag = useAppStore.getState().authUiUserTag ?? null;
  const prefs = loadTradingUiPrefs(tag);
  if (!prefs) return;
  const want = String(prefs.lastMode || "").toUpperCase();
  const have = String(serverMode || "").toUpperCase();
  const modeMismatch = Boolean(want && want !== have);
  // Do not POST stale `byMode` to `/api/bot/config` on load — that overwrote saved strategy / disk with
  // browser cache. Mode restore (`setMode`) is enough; hello state is authoritative for bot fields.
  if (!modeMismatch) return;
  tradingUiSessionRestoreStarted = true;

  void (async () => {
    try {
        if (want === "BINANCE_LIVE") {
          const ok = window.confirm(
            "BINANCE LIVE (mainnet): real funds — losses possible. Requires BINANCE_LIVE_TRADING_ENABLED=1 on the server. Restore your saved LIVE mode?",
          );
          if (!ok) return;
        }
        await api.setMode(want as "PAPER" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_LIVE");
    } catch {
      /* ignore */
    }
  })();
}

function normWsSym(x: string | undefined) {
  return String(x ?? "").trim().toUpperCase();
}

function normChartTf(x: string | undefined) {
  return String(x ?? "").trim().toLowerCase();
}

/** Instance/config chart TF — may differ from live engine `bot.timeframe` (multi-instance UI). */
function chartViewTimeframeForState(s: AppState): string {
  const modeSlug = tradingModeToApiModeSlug(s.mode);
  const iid = activeInstanceIdForMode(s, modeSlug);
  if (iid) {
    const instView = s.configViewByInstanceId?.[iid];
    if (instView && typeof instView.timeframe === "string" && String(instView.timeframe).trim()) {
      return normChartTf(String(instView.timeframe));
    }
  }
  const modeView = s.configViewByMode?.[modeSlug];
  if (modeView && typeof modeView.timeframe === "string" && String(modeView.timeframe).trim()) {
    return normChartTf(String(modeView.timeframe));
  }
  return normChartTf(String(s.bot?.timeframe ?? ""));
}

function mergeMarketIntoState(s: AppState, p: MarketPayload): AppState | Partial<AppState> {
  const c = p.candle;
  const o = Number(c?.open);
  const h = Number(c?.high);
  const l = Number(c?.low);
  const cl = Number(c?.close);
  /** Match ChartPanel / Binance wire: `BTC/USDT` vs `BTCUSDT` must not block every `market` tick. */
  const payloadSym = normalizeSym(p.symbol);
  /** Without a symbol, `symbolChanged` would be true vs any prior pair and wipe the whole buffer. */
  if (!payloadSym) return s;
  const viewSym = normalizeSym(s.chartDisplaySymbol ?? s.bot?.symbol);
  /** Stale or misrouted ticks (WS backlog) must not append into another pair’s candle buffer. */
  if (viewSym && payloadSym && viewSym !== payloadSym) {
    return s;
  }
  /**
   * Must detect pair changes even when `market` was briefly undefined; the old logic used
   * `prevSymbol && prevSymbol !== p.symbol`, which kept `symbolChanged` false and merged
   * BTC (etc.) history with BNB ticks — HUD/chart then flickered plausible-but-wrong prices.
   */
  const prevMarketSym = normalizeSym(s.market?.symbol);
  const symbolChanged = prevMarketSym !== payloadSym;
  const prev = symbolChanged ? [] : s.candles;
  const lastPrev = prev.length ? prev[prev.length - 1] : null;
  const prevClose =
    lastPrev && Number.isFinite(Number(lastPrev.close)) ? Number(lastPrev.close) : null;
  /** Same open time as last store bar = in-progress kline tail; skip 45% step check vs last tick (avoids dropping live partials). */
  const sameBarAsPrev =
    lastPrev != null && Number.isFinite(Number(lastPrev.ts)) && Number(lastPrev.ts) === Number(c?.ts);
  const symPlausible = String(p.symbol ?? "");
  let plausible = isPlausibleCandleClose(symPlausible, cl, l, prevClose);
  if (!plausible && sameBarAsPrev) {
    plausible = isPlausibleCandleClose(symPlausible, cl, l, null);
  }
  if (
    c == null ||
    !Number.isFinite(Number(c.ts)) ||
    ![o, h, l, cl].every((x) => Number.isFinite(x) && x > 0) ||
    !plausible
  ) {
    return s;
  }

  const botPatch =
    s.bot &&
    typeof s.bot === "object" &&
    (p.mlctsLayerStatus != null || p.liqCascadeRadarStatus != null || p.microEventRadarStatus != null)
      ? {
          ...s.bot,
          ...(p.mlctsLayerStatus != null ? { mlctsLayerStatus: p.mlctsLayerStatus } : {}),
          ...(p.liqCascadeRadarStatus != null ? { liqCascadeRadarStatus: p.liqCascadeRadarStatus } : {}),
          ...(p.microEventRadarStatus != null ? { microEventRadarStatus: p.microEventRadarStatus } : {}),
        }
      : s.bot;

  const mergeMarketHudOnly = (): Partial<AppState> => {
    const prevMarketHud =
      s.market && typeof s.market === "object" && !Array.isArray(s.market)
        ? { ...(s.market as MarketPayload) }
        : {};
    return {
      market: {
        ...prevMarketHud,
        ...p,
        supertrendLine:
          Array.isArray(p.supertrendLine) && p.supertrendLine.length > 0
            ? p.supertrendLine
            : (s.market?.supertrendLine ?? []),
        supertrendSignals:
          Array.isArray(p.supertrendSignals) && p.supertrendSignals.length > 0
            ? p.supertrendSignals
            : (s.market?.supertrendSignals ?? []),
      },
      ...(botPatch !== s.bot ? { bot: botPatch } : {}),
    };
  };

  const chartViewTf = chartViewTimeframeForState(s);
  const marketTf = normChartTf(p.timeframe);
  /** Engine WS klines (e.g. 15m) must not append into a 1m chart store — primary BTC looked fine until the splice. */
  if (chartViewTf && marketTf && chartViewTf !== marketTf) {
    return mergeMarketHudOnly();
  }

  let next: Candle[];
  if (prev.length && Number(prev[prev.length - 1]?.ts) === Number(c?.ts)) {
    next = [...prev.slice(0, -1), { ...prev[prev.length - 1], ...c }];
  } else {
    const lastTs = lastPrev != null ? Number(lastPrev.ts) : NaN;
    const cTs = Number(c?.ts);
    const tfMs = chartViewTf ? binanceIntervalMs(chartViewTf) : 0;
    if (
      prev.length &&
      Number.isFinite(lastTs) &&
      Number.isFinite(cTs) &&
      cTs > lastTs &&
      tfMs > 0 &&
      cTs - lastTs > tfMs * 1.8
    ) {
      return mergeMarketHudOnly();
    }
    next = [...prev, c];
  }
  next = next.slice(-CHART_CANDLE_MAX);
  const stLine =
    Array.isArray(p.supertrendLine) && p.supertrendLine.length > 0
      ? p.supertrendLine
      : (s.market?.supertrendLine ?? []);
  const stSig =
    Array.isArray(p.supertrendSignals) && p.supertrendSignals.length > 0
      ? p.supertrendSignals
      : (s.market?.supertrendSignals ?? []);
  const prevMarket =
    s.market && typeof s.market === "object" && !Array.isArray(s.market)
      ? { ...(s.market as MarketPayload) }
      : {};
  const marketMerged: MarketPayload = {
    ...prevMarket,
    ...p,
    supertrendLine: stLine,
    supertrendSignals: stSig,
  };
  return { market: marketMerged, candles: next, ...(botPatch !== s.bot ? { bot: botPatch } : {}) };
}

function mergeHybridAccountSnapshot(prevAccount: unknown, nextAccount: unknown): unknown {
  if (nextAccount == null) return prevAccount ?? nextAccount;
  if (!nextAccount || typeof nextAccount !== "object" || Array.isArray(nextAccount)) return nextAccount;
  const nextObj = nextAccount as Record<string, unknown>;
  const prevObj =
    prevAccount && typeof prevAccount === "object" && !Array.isArray(prevAccount)
      ? (prevAccount as Record<string, unknown>)
      : null;
  const nextVenues =
    nextObj.venues && typeof nextObj.venues === "object" && !Array.isArray(nextObj.venues)
      ? (nextObj.venues as Record<string, unknown>)
      : null;
  const prevVenues =
    prevObj?.venues && typeof prevObj.venues === "object" && !Array.isArray(prevObj.venues)
      ? (prevObj.venues as Record<string, unknown>)
      : null;
  if (!nextVenues && !prevVenues) return nextObj;

  const mergedVenues = {
    spot: (nextVenues?.spot ?? prevVenues?.spot ?? null) as unknown,
    futures: (nextVenues?.futures ?? prevVenues?.futures ?? null) as unknown,
  };
  const sEqRaw =
    mergedVenues.spot && typeof mergedVenues.spot === "object"
      ? (mergedVenues.spot as Record<string, unknown>).equity
      : null;
  const fEqRaw =
    mergedVenues.futures && typeof mergedVenues.futures === "object"
      ? (mergedVenues.futures as Record<string, unknown>).equity
      : null;
  const sEq = sEqRaw != null && Number.isFinite(Number(sEqRaw)) ? Number(sEqRaw) : null;
  const fEq = fEqRaw != null && Number.isFinite(Number(fEqRaw)) ? Number(fEqRaw) : null;
  const nextEqRaw = nextObj.equity;
  const nextEq = nextEqRaw != null && Number.isFinite(Number(nextEqRaw)) ? Number(nextEqRaw) : null;
  const mergedByVenue =
    nextObj.dailyPnlPctByVenue && typeof nextObj.dailyPnlPctByVenue === "object" && !Array.isArray(nextObj.dailyPnlPctByVenue)
      ? {
          ...(prevObj?.dailyPnlPctByVenue && typeof prevObj.dailyPnlPctByVenue === "object" && !Array.isArray(prevObj.dailyPnlPctByVenue)
            ? (prevObj.dailyPnlPctByVenue as Record<string, unknown>)
            : {}),
          ...(nextObj.dailyPnlPctByVenue as Record<string, unknown>),
        }
      : prevObj?.dailyPnlPctByVenue;

  // futuresAuthError: always explicitly set so null from the server clears any stale warning.
  // `...nextObj` spreads it when present, but if the key is absent (old server), fall back to prev.
  const futuresAuthError = Object.prototype.hasOwnProperty.call(nextObj, "futuresAuthError")
    ? (nextObj.futuresAuthError as string | null | undefined) ?? null
    : (prevObj?.futuresAuthError as string | null | undefined) ?? null;

  return {
    ...(prevObj ?? {}),
    ...nextObj,
    venues: mergedVenues,
    ...(mergedByVenue && typeof mergedByVenue === "object" ? { dailyPnlPctByVenue: mergedByVenue } : {}),
    ...(sEq != null && fEq != null ? { equity: sEq + fEq } : nextEq != null ? { equity: nextEq } : {}),
    ...(mergedVenues.spot == null || mergedVenues.futures == null ? { accountFetchPartial: true } : {}),
    futuresAuthError,
  };
}

export const useAppStore = create<AppState>((set, get) => ({
  ws: { connected: false },
  authUiUserTag: null,
  perSessionTradingMode: false,
  candles: [],
  chartDisplaySymbol: null,
  activityLogBulkGeneration: 0,
  logs: [],
  trades: [],
  accounts: [],
  selectedAccountId: null,
  activeAccountByMode: { paper: null, demo_api: null, testnet: null, live: null },
  accountsLoading: false,
  accountsError: null,
  activeStrategyVersionByMode: { paper: null, demo_api: null, testnet: null, live: null },
  activeInstanceByMode: { paper: null, demo_api: null, testnet: null, live: null },
  instancesByMode: {},
  instancesLoading: false,
  tradesByInstance: {},
  tradesLoadingByInstance: {},
  selectedInstanceId: null,
  strategiesByMode: {},
  versionsByStrategyId: {},
  selectedStrategyId: null,
  strategiesLoading: false,
  strategiesError: null,
  layout: { accountsSidebarCollapsed: false, strategySidebarCollapsed: false, instancesPanelCollapsed: false },
  mainView: "overview",
  backtestProgress: {},
  trailTickAuditProgress: {},
  intelligence: {},
  showMarketIntelligencePanel: false,
  performanceByVersion: {},
  equityCurveByVersion: {},
  analyticsCompareRows: [],
  analyticsCompareLoading: false,
  analyticsSelectedStrategyId: null,
  analyticsSelectedVersionId: null,
  analyticsModeSlug: "paper",
  runningByMode: {},
  liveBot: undefined,
  draftBotPatchByMode: { paper: {}, demo_api: {}, testnet: {}, live: {} },
  draftBotPatchByInstanceId: {},
  configViewByInstanceId: {},
  instanceConfigLoadingId: null,
  modeSwitchPending: null,
  strategyConfigDirtyByMode: { paper: false, demo_api: false, testnet: false, live: false },
  recentStrategySaveByMode: {},
  strategySliceDraftByMode: {},
  configViewByMode: {},
  configViewSeqByMode: {},
  strategySavePayloadByMode: {},
  account: undefined,
  positions: [],

  connect: () => {
    const existing = (window as any).__app_ws as WebSocket | undefined;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }

    wsIntentionalClose = false;
    let url = resolveWebSocketConnectUrl();
    if (!url || !/^wss?:\/\//i.test(url)) {
      url = productionSameOriginWsUrl();
    }
    if (!url || !/^wss?:\/\//i.test(url)) {
      set((s) => ({ ws: { ...s.ws, lastError: "ws_url_invalid", connected: false } }));
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      set((s) => ({
        ws: { ...s.ws, connected: false, lastError: "ws_construct_failed" },
      }));
      return;
    }
    (window as any).__app_ws = ws;

    const isCurrent = () => (window as any).__app_ws === ws;

    ws.onopen = () => {
      if (!isCurrent()) return;
      wsReconnectDelay = WS_RECONNECT_BASE_MS;
      set((s) => ({ ws: { ...s.ws, connected: true, lastError: undefined } }));
    };
    const scheduleReconnect = (ev?: CloseEvent) => {
      if (!isCurrent()) return;
      const lastErr =
        ev == null ? undefined : ev.wasClean ? undefined : `ws_close_${ev.code}`;
      set((s) => ({
        ws: {
          ...s.ws,
          connected: false,
          lastError: lastErr,
        },
      }));
      if (wsIntentionalClose) {
        wsIntentionalClose = false;
        return;
      }
      if (wsReconnectTimer) return;
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        if ((window as any).__app_ws === ws) {
          (window as any).__app_ws = undefined;
        }
        get().connect();
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX_MS);
      }, wsReconnectDelay);
    };
    ws.onclose = (ev) => scheduleReconnect(ev);
    ws.onerror = () => {
      if (!isCurrent()) return;
      set((s) => ({ ws: { ...s.ws, lastError: "ws_error" } }));
    };

    ws.onmessage = (ev) => {
      if (!isCurrent()) return;
      try {
        const msg = JSON.parse(ev.data);
        const { type, payload } = msg;
        if (type === "hello") {
          const p = payload as HelloPayload & { activityLog?: unknown[] };
          const chart = p.chart;
          const prevModeHello = String(get().mode ?? "").toUpperCase();
          const nextModeHello = String(p.mode ?? "").toUpperCase();
          if (nextModeHello && prevModeHello !== nextModeHello) {
            resetChartSessionForModeSwitch();
          }
          set((s) => {
            const act = Array.isArray(p.activityLog) ? p.activityLog : [];
            const logsFromServer = act.slice(0, 500).map((row: unknown) => {
                const r = row as Record<string, unknown>;
                const tsIso =
                  typeof r.ts === "string" && r.ts.length >= 10
                    ? r.ts
                    : typeof r.serverTs === "string" && r.serverTs.length >= 10
                      ? r.serverTs
                      : new Date().toISOString();
              const _lid = nextActivityLogLid++;
              return { ...(r as LogPayload), ts: tsIso, _lid };
              });
            const tagNext =
              typeof (p as HelloPayload & { uiUserTag?: string }).uiUserTag === "string" &&
              String((p as HelloPayload & { uiUserTag?: string }).uiUserTag).trim()
                ? String((p as HelloPayload & { uiUserTag?: string }).uiUserTag).trim()
                : s.authUiUserTag ?? null;
            const prefs = loadTradingUiPrefs(tagNext);
            const modeKeyHello = String(p.mode || "").toUpperCase();
            const patchHello = prefs?.byMode?.[modeKeyHello];
            const mergedHelloBot =
              patchHello && Object.keys(patchHello).length
                ? mergePersistedBotPreferServer(p.state as Record<string, unknown>, patchHello as Record<string, unknown>)
                : p.state;
            const liveHello =
              mergedHelloBot && typeof mergedHelloBot === "object"
                ? (mergedHelloBot as Record<string, unknown>)
                : {};
            const modeSlugHello = tradingModeToApiModeSlug(String(p.mode || ""));
            const helloDraftCtx = draftByModeWithInstanceContext(s, modeSlugHello);
            const helloConfigSlice = strategyConfigSlicePatch(
              p.mode,
              modeSlugHello,
              liveHello,
              helloDraftCtx,
              s,
            );
            const prevBulk =
              typeof s.activityLogBulkGeneration === "number" ? s.activityLogBulkGeneration : 0;
            const modeChangedHello =
              nextModeHello.length > 0 && String(s.mode ?? "").toUpperCase() !== nextModeHello;
            const base: Partial<AppState> = {
              mode: p.mode,
              authUiUserTag: tagNext,
              perSessionTradingMode: (p as HelloPayload).perSessionTradingMode === true,
              runningByMode:
                p.runningByMode != null && typeof p.runningByMode === "object"
                  ? (p.runningByMode as Record<string, boolean>)
                  : s.runningByMode ?? {},
              activeAccountByMode:
                p.activeAccountByMode != null && typeof p.activeAccountByMode === "object"
                  ? parseActiveAccountByModeFromServer(p.activeAccountByMode)
                  : s.activeAccountByMode,
              activeStrategyVersionByMode:
                (p as HelloPayload & { activeStrategyVersionByMode?: unknown }).activeStrategyVersionByMode !=
                  null &&
                typeof (p as HelloPayload & { activeStrategyVersionByMode?: unknown }).activeStrategyVersionByMode ===
                  "object"
                  ? parseActiveStrategyVersionByModeFromServer(
                      (p as HelloPayload & { activeStrategyVersionByMode?: unknown }).activeStrategyVersionByMode,
                    )
                  : s.activeStrategyVersionByMode,
              activeInstanceByMode:
                (p as HelloPayload & { activeInstanceByMode?: unknown }).activeInstanceByMode != null &&
                typeof (p as HelloPayload & { activeInstanceByMode?: unknown }).activeInstanceByMode === "object"
                  ? parseActiveInstanceByModeFromServer(
                      (p as HelloPayload & { activeInstanceByMode?: unknown }).activeInstanceByMode,
                    )
                  : s.activeInstanceByMode,
              liveBot: liveHello,
              ...(helloConfigSlice ?? {
                bot: deriveViewBot(p.mode, liveHello, helloDraftCtx),
              }),
              ...(helloConfigSlice
                ? {
                    configViewByMode: helloConfigSlice.configViewByMode,
                    configViewSeqByMode: helloConfigSlice.configViewSeqByMode,
                    strategySavePayloadByMode: helloConfigSlice.strategySavePayloadByMode,
                  }
                : {}),
              account:
                (p as any).account !== undefined
                  ? mergeHybridAccountSnapshot(s.account, (p as any).account)
                  : s.account,
              positions:
                (p as any).positions !== undefined ? (p as any).positions : s.positions,
              logs: logsFromServer,
              activityLogBulkGeneration: prevBulk + 1,
            };
            if (modeChangedHello) {
              base.candles = [];
              base.market = undefined;
              base.depth = undefined;
            }
            if (chart?.candles?.length) {
              const chartSym = String(chart.symbol ?? p.state?.symbol ?? "");
              const cc: Candle[] = [];
              let prevHello: number | null = null;
              for (const c of chart.candles as Candle[]) {
                const cl = Number(c?.close);
                const lo = Number(c?.low);
                if (!isPlausibleCandleClose(chartSym, cl, lo, prevHello)) continue;
                cc.push(c);
                prevHello = cl;
              }
              const ccTrim = cc.slice(-CHART_CANDLE_MAX);
              if (ccTrim.length) {
                const last = ccTrim[ccTrim.length - 1];
                base.candles = ccTrim;
                base.market = {
                  symbol: String(chart.symbol ?? p.state?.symbol ?? "—"),
                  timeframe: String(chart.timeframe ?? p.state?.timeframe ?? "—"),
                  candle: last,
                  indicators: s.market?.indicators ?? {},
                  regime: s.market?.regime ?? { type: "—", atrPct: 0, adx: 0 },
                  supertrend: chart.supertrend ?? null,
                  supertrendLine: Array.isArray(chart.supertrendLine) ? chart.supertrendLine : [],
                  supertrendSignals: Array.isArray(chart.supertrendSignals) ? chart.supertrendSignals : [],
                };
              }
            }
            return base as AppState;
          });
          maybeClearModeSwitchPending(String(p.mode || ""));
          queueMicrotask(() => scheduleTradingUiSessionRestore(String(p.mode || "")));
          queueMicrotask(() => {
            void (async () => {
              const slug = tradingModeToApiModeSlug(String(p.mode || ""));
              await Promise.all([
                useAppStore.getState().fetchAccountsForMode(slug),
                useAppStore.getState().fetchStrategiesForMode(slug),
                useAppStore.getState().fetchInstancesForMode(slug),
              ]);
              const activeInst = useAppStore.getState().activeInstanceByMode[slug];
              if (!activeInst) {
                useAppStore.getState().setMainView("overview");
                return;
              }
              useAppStore.setState((s) => ({
                selectedInstanceId: activeInst,
                mainView: "instance",
                ...(applyOptimisticInstanceConfig(s, slug, activeInst) ?? {}),
              }));
            })();
          });
          return;
        }
        if (type === "instance_status") {
          const raw = payload as Record<string, unknown>;
          const instanceId = raw.instanceId != null ? String(raw.instanceId) : "";
          if (!instanceId) return;
          const patch: Partial<BotInstance> = {};
          if (raw.status != null && String(raw.status).trim() !== "") patch.status = String(raw.status);
          if (raw.errorMessage !== undefined) {
            patch.errorMessage =
              raw.errorMessage != null && String(raw.errorMessage).trim() !== ""
                ? String(raw.errorMessage)
                : null;
          }
          const ru = raw.reservedUsdt;
          if (ru != null && Number.isFinite(Number(ru))) {
            patch.allotment = { reservedUsdt: Number(ru) } as BotInstance["allotment"];
          }
          const tt = raw.totalTrades;
          if (tt != null && Number.isFinite(Number(tt))) patch.totalTrades = Math.floor(Number(tt));
          const tp = raw.totalPnlUsdt;
          if (tp != null && Number.isFinite(Number(tp))) patch.totalPnlUsdt = Number(tp);
          if (raw.updatedAt != null && String(raw.updatedAt).trim() !== "") {
            patch.updatedAt = String(raw.updatedAt);
          }
          if (Object.keys(patch).length === 0) return;
          set((s) => ({
            instancesByMode: patchInstanceInByMode(s.instancesByMode, instanceId, patch) as typeof s.instancesByMode,
          }));
          return;
        }
        if (type === "trades_snapshot") {
          const raw = payload as any;
          const replace = raw && typeof raw === "object" && !Array.isArray(raw) && raw.replace === true;
          const arr: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.trades) ? raw.trades : [];
          set((s) => {
            if (replace) {
              return { trades: arr.slice(0, TRADE_HISTORY_UI_MAX) };
            }
            if (arr.length === 0) {
              return {};
            }
            const existingIds = new Set(s.trades.map((t: any) => t?.id).filter(Boolean));
            const deduped = arr.filter((t: any) => !existingIds.has(t?.id));
            return { trades: [...deduped, ...s.trades].slice(0, TRADE_HISTORY_UI_MAX) };
          });
          return;
        }
        if (type === "state") {
          pendingWsStatePayload = payload;
          scheduleWsStateFlush();
          return;
        }
        if (type === "runtime_state") {
          applyWsRuntimeStateSnapshot(payload);
          return;
        }
        if (type === "market") {
          const p = payload as MarketPayload;
          const k = normalizeSym(p.symbol);
          if (!k) return;
          const st = useAppStore.getState();
          const viewK = normalizeSym(st.chartDisplaySymbol ?? st.bot?.symbol);
          if (viewK && k !== viewK) return;
          if (!pendingMarketBySymbol) pendingMarketBySymbol = new Map();
          pendingMarketBySymbol.set(k, p);
          scheduleMarketFlush();
          return;
        }
        if (type === "log") {
          const raw = payload as LogPayload & { tradingMode?: string };
          const tm =
            raw.tradingMode != null && String(raw.tradingMode).trim() !== ""
              ? String(raw.tradingMode).trim().toUpperCase()
              : null;
          const current = String(get().mode || "PAPER").toUpperCase();
          if (tm != null && tm !== current) return;
          get().pushLog(payload as LogPayload);
          return;
        }
        if (type === "funding_alert") {
          const p = payload as {
            message?: string;
            symbol?: string;
            band?: string;
            zscore?: number;
            ts?: string;
          };
          const msg = typeof p?.message === "string" ? p.message : "Funding extreme";
          get().pushLog({
            level: "warn",
            category: "intelligence",
            reason: "funding_extreme",
            msg,
            symbol: p?.symbol,
            detail: { band: p?.band, zscore: p?.zscore },
            ts: typeof p?.ts === "string" ? p.ts : undefined,
          } as LogPayload);
          return;
        }
        if (type === "trail_tick_audit_progress") {
          const p = payload as {
            runId?: string;
            progressPct?: number;
            status?: string;
            error?: string;
            phase?: string;
            detail?: string;
          };
          const runId = p?.runId != null ? String(p.runId) : "";
          if (!runId) return;
          get().setTrailTickAuditProgress(runId, {
            progressPct: p?.progressPct != null ? Number(p.progressPct) : undefined,
            status: p?.status,
            error: p?.error,
            phase: p?.phase,
            detail: p?.detail,
          });
          return;
        }
        if (type === "backtest_progress" || type === "backtest_complete" || type === "backtest_failed") {
          const p = payload as { runId?: string; progressPct?: number; status?: string; error?: string };
          const runId = p?.runId != null ? String(p.runId) : "";
          if (!runId) return;
          let status: string | undefined = p?.status;
          if (type === "backtest_complete") status = "done";
          if (type === "backtest_failed") status = "failed";
          if (type === "backtest_progress" && (status == null || status === "")) status = "running";
          get().setBacktestProgress(runId, {
            progressPct:
              type === "backtest_complete"
                ? 100
                : p?.progressPct != null
                  ? Number(p.progressPct)
                  : undefined,
            status,
            error: p?.error,
          });
          return;
        }
        if (type === "whale_alert") {
          const p = payload as { alert?: { symbol?: string; amountUsd?: number | null }; timestamp?: string };
          const a = p?.alert;
          const sym = a?.symbol != null ? String(a.symbol) : "";
          const amt = a?.amountUsd != null && Number.isFinite(Number(a.amountUsd)) ? Number(a.amountUsd) : null;
          const msg =
            sym && amt != null
              ? `Large transfer · ${sym} ~$${(amt / 1e6).toFixed(2)}M`
              : sym
                ? `Whale alert · ${sym}`
                : "Whale alert";
          get().pushLog({
            level: "info",
            category: "intelligence",
            reason: "whale_alert",
            msg,
            symbol: sym || undefined,
            detail: { alert: a },
            ts: typeof p?.timestamp === "string" ? p.timestamp : undefined,
          } as LogPayload);
          return;
        }
        if (type === "trade") {
          const p = payload as TradePayload;
          if (
            p?.type === "CLOSE" &&
            !isIncomeLedgerClose(p) &&
            Number(p?.pnl) > 0
          ) {
            playProfitCloseSound();
          }
          set((s) => {
            const withInst = (trades: TradePayload[], row: unknown) => {
              const byInst = upsertTradesByInstanceMap(s.tradesByInstance, row);
              return byInst ? { trades, tradesByInstance: byInst } : { trades };
            };
            const id = p?.id;
            if (id != null && id !== "") {
              const idx = s.trades.findIndex((t: any) => t?.id === id);
              if (idx >= 0) {
                const prev = s.trades[idx] as Record<string, unknown>;
                const prevType = String(prev?.type ?? "").toUpperCase();
                const nextType = String((p as Record<string, unknown>)?.type ?? "").toUpperCase();
                const prevStatus = String(prev?.status ?? prevType).toUpperCase();
                // Paper futures reuse position id for OPEN→CLOSE — merge into one mutable row.
                if (
                  prevType &&
                  nextType &&
                  prevType === "OPEN" &&
                  nextType === "CLOSE"
                ) {
                  const closeRow = p as Record<string, unknown>;
                  const openPrice = prev.price ?? prev.entryPrice ?? (prev.meta as Record<string, unknown>)?.entryPx;
                  const merged = {
                    ...prev,
                    ...closeRow,
                    type: "OPEN",
                    status: "CLOSED",
                    entryPrice: openPrice ?? closeRow.entryPrice,
                    exitPrice: closeRow.price ?? closeRow.exitPrice,
                    price: openPrice ?? prev.price,
                    instanceId: closeRow.instanceId ?? prev.instanceId,
                    meta: {
                      ...((prev.meta as Record<string, unknown>) || {}),
                      ...(closeRow.meta || {}),
                      entryPrice: openPrice ?? (prev.meta as Record<string, unknown>)?.entryPrice,
                      exitPrice: closeRow.price ?? (closeRow.meta as Record<string, unknown>)?.exitPrice,
                    },
                  } as TradePayload & { status?: string; exitPrice?: number };
                  const next = s.trades.slice();
                  next[idx] = merged;
                  return withInst(next.slice(0, TRADE_HISTORY_UI_MAX), merged);
                }
                if (
                  prevType &&
                  nextType &&
                  prevType !== nextType &&
                  (prevType === "OPEN" || prevType === "CLOSE") &&
                  (nextType === "OPEN" || nextType === "CLOSE")
                ) {
                  return withInst([p, ...s.trades].slice(0, TRADE_HISTORY_UI_MAX), p);
                }
                const merged = {
                  ...prev,
                  ...p,
                  instanceId:
                    (p as Record<string, unknown>)?.instanceId ?? prev.instanceId,
                  status:
                    (p as Record<string, unknown>)?.status ??
                    (nextType === "CLOSE" ? "CLOSED" : prevStatus === "CLOSED" ? "CLOSED" : "OPEN"),
                  meta: {
                    ...((prev.meta as Record<string, unknown>) || {}),
                    ...((p as Record<string, unknown>).meta || {}),
                  },
                };
                const next = s.trades.slice();
                next[idx] = merged as TradePayload;
                return withInst(next.slice(0, TRADE_HISTORY_UI_MAX), merged);
              }
            }
            return withInst([p, ...s.trades].slice(0, TRADE_HISTORY_UI_MAX), p);
          });
          return;
        }
        if (type === "depth") {
          pendingDepthPayload = payload as DepthPayload;
          scheduleDepthFlush();
          return;
        }
        if (type === "external") {
          set({ external: payload as ExternalPayload });
          return;
        }
        if (type === "intelligence_update") {
          const p = payload as { symbol?: string; data?: IntelligenceData; timestamp?: string };
          if (p?.symbol && p?.data) {
            const merged: IntelligenceData = {
              ...p.data,
              timestamp: p.data.timestamp ?? p.timestamp ?? new Date().toISOString(),
            };
            set((s) => ({
              intelligence: { ...s.intelligence, [p.symbol!]: merged },
            }));
          }
          return;
        }
      } catch {
        // ignore
      }
    };
  },

  setBot: (bot) => set({ bot, liveBot: bot }),
  stageDraftBotPatch: (modeSlug, patch) => {
    if (!patch || typeof patch !== "object") return;
    noteBotConfigPatchInFlight(patch);
    set((s) => {
      const instanceId = activeInstanceIdForMode(s, modeSlug);
      const draftBotPatchByInstanceId = { ...(s.draftBotPatchByInstanceId ?? {}) };
      if (instanceId) {
        const prevInstPatch = draftBotPatchByInstanceId[instanceId] ?? {};
        draftBotPatchByInstanceId[instanceId] = { ...prevInstPatch, ...patch };
      }
      const live =
        s.liveBot && typeof s.liveBot === "object" && !Array.isArray(s.liveBot)
          ? (s.liveBot as Record<string, unknown>)
          : s.bot && typeof s.bot === "object" && !Array.isArray(s.bot)
            ? (s.bot as Record<string, unknown>)
            : {};
      const draftCtx = draftByModeWithInstanceContext({ ...s, draftBotPatchByInstanceId }, modeSlug);
      const view = normalizeIntradayGatesOnBot(deriveViewBot(s.mode, live, draftCtx));
      return {
        draftBotPatchByInstanceId,
        strategyConfigDirtyByMode: { ...s.strategyConfigDirtyByMode, [modeSlug]: true },
        ...buildStrategyConfigViewSlice(s.mode, modeSlug, view, s, instanceId),
      };
    });
  },
  replaceDraftBotPatch: (modeSlug, patch) => {
    if (!patch || typeof patch !== "object") return;
    noteBotConfigPatchInFlight(patch);
    set((s) => {
      const instanceId = activeInstanceIdForMode(s, modeSlug);
      const draftBotPatchByInstanceId = { ...(s.draftBotPatchByInstanceId ?? {}) };
      const draftBotPatchByMode = { ...s.draftBotPatchByMode, [modeSlug]: { ...patch } };
      if (instanceId) {
        draftBotPatchByInstanceId[instanceId] = { ...patch };
      }
      const live =
        s.liveBot && typeof s.liveBot === "object" && !Array.isArray(s.liveBot)
          ? (s.liveBot as Record<string, unknown>)
          : s.bot && typeof s.bot === "object" && !Array.isArray(s.bot)
            ? (s.bot as Record<string, unknown>)
            : {};
      const draftCtx = draftByModeWithInstanceContext(
        { ...s, draftBotPatchByInstanceId, draftBotPatchByMode },
        modeSlug,
      );
      const view = normalizeIntradayGatesOnBot(deriveViewBot(s.mode, live, draftCtx));
      return {
        draftBotPatchByInstanceId,
        draftBotPatchByMode,
        strategyConfigDirtyByMode: { ...s.strategyConfigDirtyByMode, [modeSlug]: true },
        ...buildStrategyConfigViewSlice(s.mode, modeSlug, view, s, instanceId),
      };
    });
  },
  clearDraftBotPatch: (modeSlug) => {
    set((s) => {
      const instanceId = activeInstanceIdForMode(s, modeSlug);
      const draftBotPatchByInstanceId = { ...(s.draftBotPatchByInstanceId ?? {}) };
      if (instanceId) draftBotPatchByInstanceId[instanceId] = {};
      const strategySliceDraftByMode = { ...s.strategySliceDraftByMode, [modeSlug]: {} };
      const live =
        s.liveBot && typeof s.liveBot === "object" && !Array.isArray(s.liveBot)
          ? (s.liveBot as Record<string, unknown>)
          : s.bot && typeof s.bot === "object" && !Array.isArray(s.bot)
            ? (s.bot as Record<string, unknown>)
            : {};
      const draftCtx = draftByModeWithInstanceContext({ ...s, draftBotPatchByInstanceId }, modeSlug);
      const view = normalizeIntradayGatesOnBot(deriveViewBot(s.mode, live, draftCtx));
      return {
        draftBotPatchByInstanceId,
        strategySliceDraftByMode,
        ...buildStrategyConfigViewSlice(s.mode, modeSlug, view, s, instanceId),
      };
    });
    scheduleStrategyConfigDirtyRecompute(modeSlug);
  },
  getDraftBotPatch: (modeSlug) => {
    const s = get();
    const instanceId = activeInstanceIdForMode(s, modeSlug);
    return draftForInstance(s.draftBotPatchByInstanceId ?? {}, instanceId);
  },
  hasDraftBotPatch: (modeSlug) => hasActiveConfigDraftForMode(get(), modeSlug),

  switchManualStrategyPath: (modeSlug, newManualStrategy) => {
    const s = get();
    const live =
      s.liveBot && typeof s.liveBot === "object" && !Array.isArray(s.liveBot)
        ? (s.liveBot as Record<string, unknown>)
        : s.bot && typeof s.bot === "object" && !Array.isArray(s.bot)
          ? (s.bot as Record<string, unknown>)
          : {};
    const view =
      s.bot && typeof s.bot === "object" && !Array.isArray(s.bot)
        ? (s.bot as Record<string, unknown>)
        : live;
    const oldManual = String(view.manualStrategy ?? live.manualStrategy ?? "").trim().toUpperCase();
    const nextManual = String(newManualStrategy ?? "").trim().toUpperCase();
    if (!nextManual || oldManual === nextManual) return;

    const sliceDraftByMode = { ...(s.strategySliceDraftByMode ?? {}) };
    const modeDraft = { ...(sliceDraftByMode[modeSlug] ?? {}) };
    if (oldManual) {
      modeDraft[oldManual] = extractProfileSliceFromBot(view, oldManual);
    }

    let savedCfgRaw: Record<string, unknown> | null = null;
    const vid = resolveActiveStrategyVersionId(s, modeSlug);
    if (vid) {
      for (const st of s.strategiesByMode[modeSlug] ?? []) {
        if (st.latestVersion?.id === vid) {
          savedCfgRaw = (st.latestVersion.cfgRaw ?? {}) as Record<string, unknown>;
          break;
        }
        const hit = s.versionsByStrategyId[st.id]?.find((v) => v.id === vid);
        if (hit) {
          savedCfgRaw = (hit.cfgRaw ?? {}) as Record<string, unknown>;
          break;
        }
      }
    }

    const patch = buildManualStrategySwitchPatch(
      live,
      nextManual,
      savedCfgRaw,
      modeDraft[nextManual],
    );
    sliceDraftByMode[modeSlug] = modeDraft;
    noteBotConfigPatchInFlight(patch);
    set((st) => {
      const instanceId = activeInstanceIdForMode(st, modeSlug);
      const draftBotPatchByInstanceId = { ...(st.draftBotPatchByInstanceId ?? {}) };
      if (instanceId) {
        const prevInstPatch = draftBotPatchByInstanceId[instanceId] ?? {};
        draftBotPatchByInstanceId[instanceId] = { ...prevInstPatch, ...patch };
      }
      const live =
        st.liveBot && typeof st.liveBot === "object" && !Array.isArray(st.liveBot)
          ? (st.liveBot as Record<string, unknown>)
          : st.bot && typeof st.bot === "object" && !Array.isArray(st.bot)
            ? (st.bot as Record<string, unknown>)
            : {};
      const draftCtx = draftByModeWithInstanceContext({ ...st, draftBotPatchByInstanceId }, modeSlug);
      const view = normalizeIntradayGatesOnBot(deriveViewBot(st.mode, live, draftCtx));
      return {
        strategySliceDraftByMode: sliceDraftByMode,
        draftBotPatchByInstanceId,
        strategyConfigDirtyByMode: { ...st.strategyConfigDirtyByMode, [modeSlug]: true },
        ...buildStrategyConfigViewSlice(st.mode, modeSlug, view, st, instanceId),
      };
    });
    get().recomputeStrategyConfigDirtyForMode(modeSlug);
  },

  setChartDisplaySymbol: (sym) => {
    const primaryNorm = normalizeSym(String(get().bot?.symbol ?? ""));
    const nextRaw = sym == null || String(sym).trim() === "" ? null : normWsSym(String(sym));
    const next =
      nextRaw != null && primaryNorm && normalizeSym(nextRaw) === primaryNorm ? null : nextRaw;
    const depthSym = next ?? (primaryNorm || null);
    /** ChartPanel owns candle hydration (per-symbol cache + REST). Clearing here left a blank chart until manual reload. */
    set((s) => ({
      chartDisplaySymbol: next,
      /** Avoid “DOGE book vs chart XAUT” while server depth WS reconnects after focus change. */
      depth:
        depthSym != null
          ? { symbol: depthSym, bids: [], asks: [] }
          : s.depth,
    }));
    applyOptimisticChartFocus(next);
    queueChartFocusSync(next);
  },

  ensureChartFocusSynced: () => {
    const sym = get().chartDisplaySymbol;
    const primaryNorm = normalizeSym(String(get().bot?.symbol ?? ""));
    const serverNorm = normalizeSym(String(get().bot?.uiChartFocusSymbol ?? ""));
    const syncTarget = resolveChartFocusSyncSymbol(sym);

    /** Primary / no override: server focus must clear so depth + ticks follow `bot.symbol`. */
    if (syncTarget == null) {
      if (serverNorm && serverNorm !== primaryNorm) {
        queueChartFocusSync(null, { immediate: true });
      }
      return;
    }

    const clientNorm = normalizeSym(syncTarget);
    if (clientNorm && (clientNorm === lastChartFocusAckNorm || clientNorm === serverNorm)) return;
    queueChartFocusSync(syncTarget, { immediate: true });
  },

  pushLog: (p) =>
    set((s) => {
      const raw = p as Record<string, unknown>;
      const tsIso =
        typeof raw.ts === "string" && raw.ts.length >= 10
          ? raw.ts
          : typeof raw.serverTs === "string" && raw.serverTs.length >= 10
            ? raw.serverTs
            : new Date().toISOString();
      const _lid = nextActivityLogLid++;
      return {
        logs: [{ ...p, ts: tsIso, _lid }, ...s.logs].slice(0, 500),
      };
    }),

  fetchAccountsForMode: async (modeSlug) => {
    const existing = inFlightAccountsFetch.get(modeSlug);
    if (existing) return existing;
    const run = (async () => {
      set({ accountsLoading: true, accountsError: null });
      try {
        const list = await api.getAccountsForMode(modeSlug);
        set({ accounts: list, accountsLoading: false, accountsError: null });
        const sel = get().selectedAccountId;
        if (sel && !list.some((a) => a.id === sel)) {
          const fallback = list.find((a) => a.isActive)?.id ?? null;
          set({ selectedAccountId: fallback });
        }
        // Auto-select first active account if none is set for this mode.
        // Paper mode has no DB-backed active account (server returns 400
        // `paper_no_active_account`), so never POST active-account for it.
        const activeForMode = get().activeAccountByMode[modeSlug];
        if (!activeForMode && modeSlug !== "paper") {
          const firstActive = list.find((a) => a.isActive);
          if (firstActive) {
            try {
              await get().setActiveAccountForMode(modeSlug, firstActive.id);
            } catch {
              /* non-critical: ignore */
            }
          }
        }
      } catch (e) {
        set({
          accountsLoading: false,
          accountsError: e instanceof Error ? e.message : "accounts_fetch_failed",
        });
      } finally {
        inFlightAccountsFetch.delete(modeSlug);
      }
    })();
    inFlightAccountsFetch.set(modeSlug, run);
    return run;
  },

  selectAccount: (accountId) => set({ selectedAccountId: accountId }),

  setActiveAccountForMode: async (modeSlug, accountId) => {
    const data = await api.setActiveAccountForMode(modeSlug, accountId);
    if (data.activeAccountByMode && typeof data.activeAccountByMode === "object") {
      set({ activeAccountByMode: parseActiveAccountByModeFromServer(data.activeAccountByMode) });
    }
  },

  createAccount: async (modeSlug, data) => {
    const acc = await api.createAccount(modeSlug, data);
    await get().fetchAccountsForMode(modeSlug);
    return acc;
  },

  updateAccount: async (accountId, patch) => {
    const acc = await api.updateAccount(accountId, patch);
    const mode = get().mode;
    await get().fetchAccountsForMode(tradingModeToApiModeSlug(mode));
    return acc;
  },

  deactivateAccount: async (accountId) => {
    await api.deactivateAccount(accountId);
    const mode = get().mode;
    await get().fetchAccountsForMode(tradingModeToApiModeSlug(mode));
    if (get().selectedAccountId === accountId) {
      set({ selectedAccountId: null });
    }
  },

  recomputeStrategyConfigDirtyForMode: (modeSlug) => {
    const s = get();
    const vid = resolveActiveStrategyVersionId(s, modeSlug);
    const bot = s.bot;
    const hasDraft = hasActiveConfigDraftForMode(s, modeSlug);
    if (!vid || !bot || typeof bot !== "object") {
      if (hasDraft) {
        set((st) => ({
          strategyConfigDirtyByMode: { ...st.strategyConfigDirtyByMode, [modeSlug]: true },
        }));
      }
      return;
    }
    const strategies = s.strategiesByMode[modeSlug] ?? [];
    let cfgRaw: Record<string, unknown> | null = null;
    for (const st of strategies) {
      if (st.latestVersion?.id === vid) {
        cfgRaw = (st.latestVersion.cfgRaw ?? {}) as Record<string, unknown>;
        break;
      }
      const vers = s.versionsByStrategyId[st.id];
      const hit = vers?.find((v) => v.id === vid);
      if (hit) {
        cfgRaw = (hit.cfgRaw ?? {}) as Record<string, unknown>;
        break;
      }
    }
    if (cfgRaw == null) {
      const owner = strategies.find(
        (st) =>
          st.latestVersion?.id === vid ||
          (s.versionsByStrategyId[st.id] ?? []).some((v) => v.id === vid),
      );
      if (owner) {
        void (async () => {
          await get().fetchVersionsForStrategy(owner.id);
          get().recomputeStrategyConfigDirtyForMode(modeSlug);
        })();
      }
      return;
    }
    const dirty = hasDraft || !signalBrainPersistBotsEqual(bot, cfgRaw);
    if (s.strategyConfigDirtyByMode[modeSlug] === dirty) return;
    signalBrainFpByMode.set(modeSlug, signalBrainBotFingerprint(bot));
    set((st) => ({
      strategyConfigDirtyByMode: { ...st.strategyConfigDirtyByMode, [modeSlug]: dirty },
    }));
  },

  markStrategyConfigCleanForMode: (modeSlug) => {
    const s = get();
    const vid = resolveActiveStrategyVersionId(s, modeSlug);
    const cfgRaw = canonicalCfgRawFromUiBot(s.bot);
    set((st) => {
      const dirtyByMode = { ...st.strategyConfigDirtyByMode, [modeSlug]: false };
      if (!vid) return { strategyConfigDirtyByMode: dirtyByMode };

      const list = [...(st.strategiesByMode[modeSlug] ?? [])];
      const versionsByStrategyId = { ...st.versionsByStrategyId };
      for (let i = 0; i < list.length; i++) {
        const stg = list[i];
        if (stg.latestVersion?.id === vid) {
          list[i] = { ...stg, latestVersion: { ...stg.latestVersion, cfgRaw } };
        }
        const prevVers = versionsByStrategyId[stg.id] ?? [];
        const vidx = prevVers.findIndex((x) => x.id === vid);
        if (vidx >= 0) {
          versionsByStrategyId[stg.id] = prevVers.map((x, j) => (j === vidx ? { ...x, cfgRaw } : x));
        }
      }
      const strategySliceDraftByMode = { ...st.strategySliceDraftByMode, [modeSlug]: {} };
      return {
        strategyConfigDirtyByMode: dirtyByMode,
        strategySliceDraftByMode,
        strategiesByMode: { ...st.strategiesByMode, [modeSlug]: list },
        versionsByStrategyId,
      };
    });
  },

  mergeStrategyVersionFromSaveResponse: (modeSlug, versionRaw) => {
    const ver = mapApiStrategyVersion(versionRaw);
    if (!ver?.id || !ver.strategyId) return;
    const recent = recentSaveFromVersionRaw(versionRaw);
    set((s) => {
      const list = [...(s.strategiesByMode[modeSlug] ?? [])];
      const idx = list.findIndex((st) => st.id === ver.strategyId);
      if (idx === -1) return {};
      const st = list[idx];
      if (!st) return {};
      const prevVers = s.versionsByStrategyId[ver.strategyId] ?? [];
      const vidx = prevVers.findIndex((x) => x.id === ver.id);
      const nextVers = vidx === -1 ? [...prevVers, ver] : prevVers.map((x, i) => (i === vidx ? ver : x));
      const nextLatest =
        st.latestVersion?.id === ver.id
          ? ver
          : st.latestVersion?.versionNumber != null && ver.versionNumber >= (st.latestVersion?.versionNumber ?? 0)
            ? ver
            : st.latestVersion;
      list[idx] = { ...st, latestVersion: nextLatest ?? ver };
      return {
        strategiesByMode: { ...s.strategiesByMode, [modeSlug]: list },
        versionsByStrategyId: { ...s.versionsByStrategyId, [ver.strategyId]: nextVers },
        strategyConfigDirtyByMode: { ...s.strategyConfigDirtyByMode, [modeSlug]: false },
        ...(recent
          ? { recentStrategySaveByMode: { ...s.recentStrategySaveByMode, [modeSlug]: recent } }
          : {}),
      };
    });
  },

  applyStrategySaveResponse: (modeSlug, versionRaw, botRaw) => {
    get().mergeStrategyVersionFromSaveResponse(modeSlug, versionRaw);
    if (!botRaw || typeof botRaw !== "object") return;
    const botNext = botRaw as Record<string, unknown>;
    noteStrategySaveWsAckGuard(botNext);
    const instanceId = activeInstanceIdForMode(get(), modeSlug);
    set((s) => ({
      ...mergeEngineBotSnapshot(s, modeSlug, botNext, {
        markConfigClean: true,
        instanceId,
      }),
      strategySliceDraftByMode: { ...s.strategySliceDraftByMode, [modeSlug]: {} },
    }));
    get().markStrategyConfigCleanForMode(modeSlug);
  },

  fetchStrategiesForMode: async (modeSlug, opts) => {
    const key = `${modeSlug}|${opts?.includeArchived ? 1 : 0}|${opts?.skipDirtyRecompute ? 1 : 0}`;
    const existing = inFlightStrategiesFetch.get(key);
    if (existing) return existing;
    const run = (async () => {
      set({ strategiesLoading: true, strategiesError: null });
      try {
        const prevList = get().strategiesByMode[modeSlug] ?? [];
        const recent = get().recentStrategySaveByMode[modeSlug];
        const list = await api.getStrategiesForMode(modeSlug, opts);
        const merged = mergeStrategyListWithRecentSave(list, prevList, recent ?? null);
        set((s) => {
          const strategiesByMode = { ...s.strategiesByMode, [modeSlug]: merged };
          return {
            strategiesByMode,
            strategiesLoading: false,
            strategiesError: null,
            ...mergeWarmInstanceConfigCache({ ...s, strategiesByMode }, modeSlug),
          };
        });
        if (!opts?.skipDirtyRecompute) {
          get().recomputeStrategyConfigDirtyForMode(modeSlug);
        }
      } catch (e) {
        set({
          strategiesLoading: false,
          strategiesError: e instanceof Error ? e.message : "strategies_fetch_failed",
        });
      } finally {
        inFlightStrategiesFetch.delete(key);
      }
    })();
    inFlightStrategiesFetch.set(key, run);
    return run;
  },

  fetchVersionsForStrategy: async (strategyId) => {
    try {
      const versions = await api.getStrategyVersions(strategyId);
      set((s) => {
        const versionsByStrategyId = { ...s.versionsByStrategyId, [strategyId]: versions };
        const mode = s.mode;
        const modeSlug = mode ? tradingModeToApiModeSlug(mode) : null;
        const warm =
          modeSlug != null
            ? warmInstanceConfigCachePatch({ ...s, versionsByStrategyId }, modeSlug)
            : null;
        return {
          versionsByStrategyId,
          ...(warm ? { configViewByInstanceId: warm } : {}),
        };
      });
      const mode = get().mode;
      if (mode) get().recomputeStrategyConfigDirtyForMode(tradingModeToApiModeSlug(mode));
    } catch {
      /* ignore */
    }
  },

  selectStrategy: (strategyId) => set({ selectedStrategyId: strategyId }),

  createStrategyForMode: async (modeSlug, dto) => {
    const { strategy } = await api.createStrategy(modeSlug, dto);
    await get().fetchStrategiesForMode(modeSlug);
    return { strategy };
  },

  updateStrategyMetaStore: async (strategyId, patch) => {
    const st = await api.updateStrategyMeta(strategyId, patch);
    const mode = get().mode;
    const slug = tradingModeToApiModeSlug(mode);
    await get().fetchStrategiesForMode(slug);
    return st;
  },

  archiveStrategyStore: async (strategyId) => {
    await api.archiveStrategy(strategyId);
    const mode = get().mode;
    const slug = tradingModeToApiModeSlug(mode);
    await get().fetchStrategiesForMode(slug);
    if (get().selectedStrategyId === strategyId) {
      set({ selectedStrategyId: null });
    }
  },

  cloneStrategyAsNewStore: async (sourceStrategyId, name) => {
    const { strategy } = await api.cloneStrategyAsNew(sourceStrategyId, name);
    const mode = get().mode;
    const slug = tradingModeToApiModeSlug(mode);
    await get().fetchStrategiesForMode(slug);
    return strategy;
  },

  bindInstanceStrategyStore: async (instanceId, strategyId) => {
    const data = await api.bindInstanceStrategy(instanceId, strategyId);
    const inst = data.instance;
    const modeSlug = (inst?.accountModeSlug ?? tradingModeToApiModeSlug(get().mode)) as ApiTradingModeSlug;
    const { applyBindInstanceStrategyResponse } = await import("../lib/strategyInstanceBind");
    await applyBindInstanceStrategyResponse(modeSlug, instanceId, data);
    await get().fetchStrategiesForMode(modeSlug);
    await get().fetchInstancesForMode(modeSlug);
  },

  saveNewStrategyVersionSnapshot: async (strategyId, label) => {
    const v = await api.saveStrategyVersionSnapshot(strategyId, label);
    await get().fetchVersionsForStrategy(strategyId);
    const mode = get().mode;
    await get().fetchStrategiesForMode(tradingModeToApiModeSlug(mode));
    return v;
  },

  cloneStrategyVersionStore: async (strategyId, versionId, opts) => {
    const v = await api.cloneStrategyVersion(strategyId, versionId, opts);
    const destId = opts?.targetStrategyId ?? strategyId;
    await get().fetchVersionsForStrategy(destId);
    const mode = get().mode;
    await get().fetchStrategiesForMode(tradingModeToApiModeSlug(mode));
    return v;
  },

  setActiveStrategyVersionForMode: async (modeSlug, versionId) => {
    const data = await api.setActiveStrategyForMode(modeSlug, versionId);
    set((s) => ({
      activeStrategyVersionByMode: {
        ...s.activeStrategyVersionByMode,
        ...(data?.activeStrategyVersionByMode
          ? parseActiveStrategyVersionByModeFromServer(data.activeStrategyVersionByMode)
          : { [modeSlug]: versionId }),
      },
    }));
    enqueueServerUiPrefsPatch({
      activeStrategyVersionByMode: { [modeSlug]: versionId },
    });
    if (data?.bot && typeof data.bot === "object") {
      const { noteStrategySaveWsAckGuard } = await import("../lib/syncStrategySave");
      const botNext = data.bot as Record<string, unknown>;
      noteStrategySaveWsAckGuard(botNext);
      const instanceId = activeInstanceIdForMode(get(), modeSlug);
      set((s) =>
        mergeEngineBotSnapshot(s, modeSlug, botNext, {
          markConfigClean: true,
          instanceId,
        }),
      );
    }
    get().recomputeStrategyConfigDirtyForMode(modeSlug);
  },

  fetchInstancesForMode: async (modeSlug) => {
    const existing = inFlightInstancesFetch.get(modeSlug);
    if (existing) return existing;
    const run = (async () => {
      set({ instancesLoading: true });
      try {
        const list = await api.listInstancesForMode(modeSlug);
        set((s) => {
          const instancesByMode = { ...s.instancesByMode, [modeSlug]: list };
          return {
            instancesByMode,
            instancesLoading: false,
            ...mergeWarmInstanceConfigCache({ ...s, instancesByMode }, modeSlug),
          };
        });
        get().recomputeStrategyConfigDirtyForMode(modeSlug);
      } catch {
        set({ instancesLoading: false });
      } finally {
        inFlightInstancesFetch.delete(modeSlug);
      }
    })();
    inFlightInstancesFetch.set(modeSlug, run);
    return run;
  },

  createInstanceStore: async (modeSlug, dto) => {
    const inst = await api.createInstance(modeSlug, dto);
    await get().fetchInstancesForMode(modeSlug);
    return inst;
  },

  deleteInstanceStore: async (instanceId) => {
    await api.deleteInstance(instanceId);
    const slug = tradingModeToApiModeSlug(get().mode || "PAPER");
    set((s) => {
      const next: Partial<Record<ApiTradingModeSlug, BotInstance[]>> = { ...s.instancesByMode };
      for (const k of Object.keys(next) as ApiTradingModeSlug[]) {
        const list = next[k];
        if (!list) continue;
        next[k] = list.filter((i) => i.id !== instanceId);
      }
      const ai = { ...s.activeInstanceByMode };
      for (const key of Object.keys(ai) as ApiTradingModeSlug[]) {
        if (ai[key] === instanceId) ai[key] = null;
      }
      const sel = s.selectedInstanceId === instanceId ? null : s.selectedInstanceId;
      const tradesByInstance = { ...s.tradesByInstance };
      delete tradesByInstance[instanceId];
      const tradesLoadingByInstance = { ...s.tradesLoadingByInstance };
      delete tradesLoadingByInstance[instanceId];
      return {
        instancesByMode: next,
        selectedInstanceId: sel,
        activeInstanceByMode: ai,
        tradesByInstance,
        tradesLoadingByInstance,
      };
    });
    await get().fetchInstancesForMode(slug);
  },

  setActiveTradingInstanceForMode: async (modeSlug, instanceId, opts) => {
    const switchToken = opts?.switchToken ?? ++instanceSwitchToken;
    if (!opts?.skipOptimistic && instanceId) {
      set((s) => ({
        selectedInstanceId: instanceId,
        instanceConfigLoadingId: instanceId,
        ...(applyOptimisticInstanceConfig(s, modeSlug, instanceId) ?? {}),
      }));
    } else if (instanceId) {
      set((s) => ({
        instanceConfigLoadingId: instanceId,
        activeInstanceByMode: { ...s.activeInstanceByMode, [modeSlug]: instanceId },
        ...(applyOptimisticInstanceConfig(s, modeSlug, instanceId) ?? {}),
      }));
    } else {
      set({ instanceConfigLoadingId: null });
    }
    let data: Awaited<ReturnType<typeof api.setActiveInstanceForMode>> | null = null;
    try {
      data = await api.setActiveInstanceForMode(modeSlug, instanceId);
    } catch (e) {
      if (switchToken === instanceSwitchToken) {
        set({ instanceConfigLoadingId: null });
      }
      throw e;
    }
    if (switchToken !== instanceSwitchToken) return;
    set((s) => ({
      activeInstanceByMode: { ...s.activeInstanceByMode, [modeSlug]: instanceId },
      instanceConfigLoadingId: null,
      ...(data?.activeAccountByMode
        ? { activeAccountByMode: parseActiveAccountByModeFromServer(data.activeAccountByMode) }
        : {}),
      ...(data?.activeStrategyVersionByMode
        ? { activeStrategyVersionByMode: parseActiveStrategyVersionByModeFromServer(data.activeStrategyVersionByMode) }
        : {}),
    }));
    const patch: Record<string, unknown> = {
      activeInstanceByMode: { [modeSlug]: instanceId },
    };
    if (data?.activeAccountByMode) patch.activeAccountByMode = data.activeAccountByMode;
    if (data?.activeStrategyVersionByMode) patch.activeStrategyVersionByMode = data.activeStrategyVersionByMode;
    enqueueServerUiPrefsPatch(patch);
    if (data?.bot && typeof data.bot === "object" && instanceId) {
      const { noteStrategySaveWsAckGuard } = await import("../lib/syncStrategySave");
      const botNext = data.bot as Record<string, unknown>;
      noteStrategySaveWsAckGuard(botNext);
      set((s) =>
        mergeEngineBotSnapshot(s, modeSlug, botNext, {
          markConfigClean: true,
          instanceId,
        }),
      );
    }
    get().recomputeStrategyConfigDirtyForMode(modeSlug);
  },

  selectInstance: (instanceId) => set({ selectedInstanceId: instanceId }),

  fetchTradesForInstance: async (instanceId, opts) => {
    const limit = opts?.limit ?? 20;
    const append = opts?.append === true;
    if (!instanceId) return 0;
    set((s) => ({
      tradesLoadingByInstance: { ...s.tradesLoadingByInstance, [instanceId]: true },
    }));
    try {
      const prev = get().tradesByInstance[instanceId];
      const offset = append && Array.isArray(prev) ? prev.length : 0;
      const page = await api.getInstanceTrades(instanceId, { limit, offset });
      set((s) => {
        const existing = s.tradesByInstance[instanceId];
        const merged =
          append && Array.isArray(existing)
            ? [
                ...existing,
                ...page.filter((t) => !existing.some((e) => e.id === t.id)),
              ]
            : page;
        return {
          tradesByInstance: { ...s.tradesByInstance, [instanceId]: merged },
          tradesLoadingByInstance: { ...s.tradesLoadingByInstance, [instanceId]: false },
        };
      });
      return page.length;
    } catch {
      set((s) => ({
        tradesLoadingByInstance: { ...s.tradesLoadingByInstance, [instanceId]: false },
      }));
      return 0;
    }
  },

  setSidebarCollapsed: (which, collapsed) => {
    set((s) => ({
      layout:
        which === "accounts"
          ? { ...s.layout, accountsSidebarCollapsed: collapsed }
          : { ...s.layout, strategySidebarCollapsed: collapsed },
    }));
    enqueueServerUiPrefsPatch({
      layout:
        which === "accounts"
          ? { accountsSidebarCollapsed: collapsed }
          : { strategySidebarCollapsed: collapsed },
    });
  },

  setInstancesPanelCollapsed: (collapsed) => {
    set((s) => ({ layout: { ...s.layout, instancesPanelCollapsed: collapsed } }));
    enqueueServerUiPrefsPatch({ layout: { instancesPanelCollapsed: collapsed } });
  },

  hydrateLayoutFromServer: (layout) => {
    if (!layout || typeof layout !== "object" || Array.isArray(layout)) return;
    const L = layout as Record<string, unknown>;
    set((s) => ({
      layout: {
        accountsSidebarCollapsed:
          L.accountsSidebarCollapsed === true ? true : L.accountsSidebarCollapsed === false ? false : s.layout.accountsSidebarCollapsed,
        strategySidebarCollapsed:
          L.strategySidebarCollapsed === true ? true : L.strategySidebarCollapsed === false ? false : s.layout.strategySidebarCollapsed,
        instancesPanelCollapsed:
          L.instancesPanelCollapsed === true
            ? true
            : L.instancesPanelCollapsed === false
              ? false
              : s.layout.instancesPanelCollapsed,
      },
    }));
  },

  setMainView: (v) => {
    const safe = v === "overview" || v === "instance" || v === "backtest" ? v : "overview";
    set({ mainView: safe });
    if (safe === "overview") {
      const slug = tradingModeToApiModeSlug(get().mode || "PAPER");
      set({ analyticsModeSlug: slug });
      void get().fetchComparisonData(slug);
    }
  },

  setBacktestProgress: (runId, patch) => {
    if (!runId) return;
    set((s) => {
      const prev = s.backtestProgress?.[runId] ?? { progressPct: 0 };
      const next = {
        progressPct: patch.progressPct != null ? Number(patch.progressPct) : prev.progressPct,
        status: patch.status ?? prev.status,
        error: patch.error ?? prev.error,
      };
      if (
        prev.progressPct === next.progressPct &&
        prev.status === next.status &&
        prev.error === next.error
      ) {
        return s;
      }
      return {
        backtestProgress: {
          ...s.backtestProgress,
          [runId]: next,
        },
      };
    });
  },

  setTrailTickAuditProgress: (runId, patch) => {
    if (!runId) return;
    set((s) => {
      const prev = s.trailTickAuditProgress?.[runId] ?? { progressPct: 0 };
      const next = {
        progressPct: patch.progressPct != null ? Number(patch.progressPct) : prev.progressPct,
        status: patch.status ?? prev.status,
        error: patch.error ?? prev.error,
        phase: patch.phase ?? prev.phase,
        detail: patch.detail ?? prev.detail,
      };
      if (
        prev.progressPct === next.progressPct &&
        prev.status === next.status &&
        prev.error === next.error &&
        prev.phase === next.phase &&
        prev.detail === next.detail
      ) {
        return s;
      }
      return {
        trailTickAuditProgress: {
          ...s.trailTickAuditProgress,
          [runId]: next,
        },
      };
    });
  },

  setShowMarketIntelligencePanel: (show) => {
    const v = Boolean(show);
    set({ showMarketIntelligencePanel: v });
    tradingUiPersistShowMarketIntelligencePanel(v, get().authUiUserTag ?? null);
  },

  fetchIntelligence: async (symbol: string) => {
    try {
      const res = await fetch(`/api/intelligence/${encodeURIComponent(symbol)}`);
      const data = await res.json() as IntelligenceData & { symbol?: string };
      if (data && data.symbol) {
        set((s) => {
          const prev = s.intelligence[symbol];
          const merged: IntelligenceData = {
            ...data,
            newsImpact: data.newsImpact ?? prev?.newsImpact ?? null,
            confluence: data.confluence ?? prev?.confluence ?? null,
          };
          return { intelligence: { ...s.intelligence, [symbol]: merged } };
        });
      }
    } catch {
      /* silent */
    }
  },

  enterInstance: async (instanceId) => {
    const slug = tradingModeToApiModeSlug(get().mode || "PAPER");
    const switchToken = ++instanceSwitchToken;

    set((s) => ({
      selectedInstanceId: instanceId,
      mainView: "instance",
      instanceConfigLoadingId: instanceId,
      ...(applyOptimisticInstanceConfig(s, slug, instanceId) ?? {}),
    }));

    if (!get().configViewByInstanceId[instanceId]) {
      const st0 = get();
      const inst = findInstanceInState(st0, slug, instanceId);
      if (inst?.strategyId && !resolveStrategyVersionForInstance(st0, slug, inst)) {
        await get().fetchVersionsForStrategy(inst.strategyId);
      }
      if (switchToken !== instanceSwitchToken) return;
      if (!get().configViewByInstanceId[instanceId]) {
        await get().fetchStrategiesForMode(slug, { skipDirtyRecompute: true });
      }
      if (switchToken === instanceSwitchToken && !get().configViewByInstanceId[instanceId]) {
        set((s) => {
          const warm = warmInstanceConfigCachePatch(s, slug);
          const base = warm ? { ...s, configViewByInstanceId: warm } : s;
          const patch = applyOptimisticInstanceConfig(base, slug, instanceId);
          if (!patch && !warm) return s;
          return {
            selectedInstanceId: instanceId,
            mainView: "instance",
            instanceConfigLoadingId: instanceId,
            ...(warm ? { configViewByInstanceId: warm } : {}),
            ...(patch ?? {}),
          };
        });
      }
    }

    try {
      await get().setActiveTradingInstanceForMode(slug, instanceId, {
        switchToken,
        skipOptimistic: true,
      });
    } catch {
      if (switchToken === instanceSwitchToken) {
        set({ instanceConfigLoadingId: null });
      }
    }
  },

  fetchPerformanceForStrategy: async (strategyId) => {
    try {
      const rows = await api.getStrategyPerformance(strategyId);
      set((s) => {
        const next = { ...s.performanceByVersion };
        for (const row of rows) {
          if (row.metrics) next[row.versionId] = row.metrics;
        }
        return { performanceByVersion: next };
      });
    } catch {
      /* ignore */
    }
  },

  fetchEquityCurve: async (strategyId, versionId) => {
    try {
      const curve = await api.getEquityCurve(strategyId, versionId);
      set((s) => ({ equityCurveByVersion: { ...s.equityCurveByVersion, [versionId]: curve } }));
    } catch {
      /* ignore */
    }
  },

  fetchComparisonData: async (modeSlug) => {
    set({ analyticsCompareLoading: true });
    try {
      const rows = await api.getPerformanceCompare(modeSlug);
      set({ analyticsCompareRows: rows, analyticsCompareLoading: false });
    } catch {
      set({ analyticsCompareRows: [], analyticsCompareLoading: false });
    }
  },

  selectAnalyticsVersion: (strategyId, versionId) => {
    set({ analyticsSelectedStrategyId: strategyId, analyticsSelectedVersionId: versionId });
    void get().fetchEquityCurve(strategyId, versionId);
    void get().fetchPerformanceForStrategy(strategyId);
  },
}));

function scheduleMarketFlush() {
  if (pendingMarketFlushScheduled) return;
  pendingMarketFlushScheduled = true;
  queueMicrotask(() => {
    pendingMarketFlushScheduled = false;
    const map = pendingMarketBySymbol;
    pendingMarketBySymbol = null;
    if (!map || map.size === 0) return;
    for (const [k, v] of map) {
      lastMarketTickBySymbol.set(k, v);
    }
    if (lastMarketTickBySymbol.size > 32) {
      const keep = new Set(map.keys());
      const viewK = normalizeSym(useAppStore.getState().chartDisplaySymbol ?? useAppStore.getState().bot?.symbol);
      if (viewK) keep.add(viewK);
      for (const k of [...lastMarketTickBySymbol.keys()]) {
        if (!keep.has(k)) lastMarketTickBySymbol.delete(k);
      }
    }
    const s = useAppStore.getState();
    const viewNorm = normalizeSym(s.chartDisplaySymbol ?? s.bot?.symbol);
    const batchPick = viewNorm ? map.get(viewNorm) : undefined;
    const cachedPick = viewNorm ? lastMarketTickBySymbol.get(viewNorm) : undefined;
    const pick = batchPick ?? cachedPick;
    const pickFromCache = Boolean(viewNorm && !batchPick && cachedPick);
    if (pickFromCache && cachedPick) {
      const storeLast = s.candles.at(-1);
      const storeLastTs = Number(storeLast?.ts);
      const pickTs = Number(cachedPick.candle?.ts);
      const marketSym = normalizeSym(s.market?.symbol);
      const sameBar =
        marketSym === viewNorm &&
        Number.isFinite(storeLastTs) &&
        Number.isFinite(pickTs) &&
        pickTs <= storeLastTs;
      const sameOhlc =
        sameBar &&
        storeLast != null &&
        Number(storeLast.close) === Number(cachedPick.candle?.close) &&
        Number(storeLast.high) === Number(cachedPick.candle?.high) &&
        Number(storeLast.low) === Number(cachedPick.candle?.low);
      if (sameOhlc) {
        return;
      }
    }
    if (!pick) return;
    useAppStore.setState((st) => mergeMarketIntoState(st, pick) as AppState);
  });
}

/** Frequent account/position refreshes should not re-merge the large bot config or rerun dirty checks. */
export function applyWsRuntimeStateSnapshot(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const p = payload as Record<string, unknown>;
  useAppStore.setState((prev) => {
    const nextMode = p.mode != null ? String(p.mode) : prev.mode;
    if (
      prev.mode != null &&
      nextMode != null &&
      String(prev.mode).toUpperCase() !== String(nextMode).toUpperCase()
    ) {
      return {};
    }
    const rawPos = p.positions;
    const payloadHadRunningByMode =
      Object.prototype.hasOwnProperty.call(p, "runningByMode") &&
      p.runningByMode != null &&
      typeof p.runningByMode === "object";
    const nextRb =
      payloadHadRunningByMode ? (p.runningByMode as Record<string, boolean>) : prev.runningByMode ?? {};

    let liveBot = prev.liveBot;
    let bot = prev.bot;
    const modeKeySync = String(nextMode || prev.mode || "PAPER").toUpperCase();
    const runningAck =
      payloadHadRunningByMode && typeof nextRb[modeKeySync] === "boolean"
        ? Boolean(nextRb[modeKeySync])
        : typeof p.running === "boolean"
          ? Boolean(p.running)
          : undefined;
    if (runningAck !== undefined && Boolean(prev.bot?.running) !== runningAck) {
      liveBot =
        liveBot && typeof liveBot === "object" && !Array.isArray(liveBot)
          ? { ...(liveBot as Record<string, unknown>), running: runningAck }
          : { running: runningAck };
      bot =
        bot && typeof bot === "object" && !Array.isArray(bot)
          ? { ...(bot as Record<string, unknown>), running: runningAck }
          : { running: runningAck };
    }

    return {
      mode: nextMode,
      ...(payloadHadRunningByMode ? { runningByMode: nextRb } : {}),
      ...(liveBot !== prev.liveBot ? { liveBot, bot } : {}),
      ...(p.account !== undefined ? { account: mergeHybridAccountSnapshot(prev.account, p.account) } : {}),
      ...(rawPos !== undefined ? { positions: Array.isArray(rawPos) ? rawPos : [] } : {}),
    };
  });
}

/** Same shape as server WS `state` / `hello.state` (mode + getPublicState + account + positions). */
export function applyWsStateSnapshot(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const p = payload as Record<string, unknown>;
  const modeChangedEarly =
    p.mode != null && String(useAppStore.getState().mode ?? "") !== String(p.mode);
  if (modeChangedEarly) resetChartSessionForModeSwitch();
  let configUnchangedFastPath = false;
  useAppStore.setState((prev) => {
    const prevSym = prev.bot?.symbol != null ? String(prev.bot.symbol) : "";
    const nextSym = p.symbol != null ? String(p.symbol) : "";
    const prevTf = prev.bot?.timeframe != null ? String(prev.bot.timeframe) : "";
    const nextTf = p.timeframe != null ? String(p.timeframe) : "";
    const chartRekey =
      (prevSym &&
        nextSym &&
        normalizeSym(prevSym) !== normalizeSym(nextSym)) ||
      (prevTf && nextTf && prevTf !== nextTf);
    const nextMode = p.mode != null ? String(p.mode) : prev.mode;
    const modeChanged = p.mode != null && String(prev.mode ?? "") !== String(p.mode);
    const nextAccount =
      p.account !== undefined ? mergeHybridAccountSnapshot(prev.account, p.account) : prev.account;
    const rawPos = p.positions;
    const nextPositions =
      rawPos !== undefined ? (Array.isArray(rawPos) ? rawPos : []) : prev.positions;
    const payloadHadRunningByMode =
      Object.prototype.hasOwnProperty.call(p, "runningByMode") &&
      p.runningByMode != null &&
      typeof p.runningByMode === "object";
    const nextRb =
      p.runningByMode != null && typeof p.runningByMode === "object"
        ? (p.runningByMode as Record<string, boolean>)
        : prev.runningByMode ?? {};
    const botPayload = { ...p };
    delete (botPayload as { runningByMode?: unknown }).runningByMode;
    const nextSav =
      p.activeStrategyVersionByMode != null && typeof p.activeStrategyVersionByMode === "object"
        ? parseActiveStrategyVersionByModeFromServer(p.activeStrategyVersionByMode)
        : undefined;
    const nextAi =
      p.activeInstanceByMode != null && typeof p.activeInstanceByMode === "object"
        ? parseActiveInstanceByModeFromServer(p.activeInstanceByMode)
        : undefined;
    const prevBot =
      prev.liveBot && typeof prev.liveBot === "object" && !Array.isArray(prev.liveBot)
        ? (prev.liveBot as Record<string, unknown>)
        : {};
    const incMssRaw = (botPayload as Record<string, unknown>).multiSymbolWatchSignals;
    delete (botPayload as { multiSymbolWatchSignals?: unknown }).multiSymbolWatchSignals;
    const prevMss =
      prevBot.multiSymbolWatchSignals && typeof prevBot.multiSymbolWatchSignals === "object" && !Array.isArray(prevBot.multiSymbolWatchSignals)
        ? ({ ...(prevBot.multiSymbolWatchSignals as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const incomingMode = String((botPayload as Record<string, unknown>).universeCoinSelectMode ?? "").toUpperCase();
    const prevMode = String(prevBot.universeCoinSelectMode ?? "").toUpperCase();
    const incomingExplicitSingle = incomingMode === "SINGLE";
    let nextMss: Record<string, unknown> = { ...prevMss };
    if (incMssRaw != null && typeof incMssRaw === "object" && !Array.isArray(incMssRaw)) {
      const inc = incMssRaw as Record<string, unknown>;
      const incKeys = Object.keys(inc);
      if (incKeys.length === 0) {
        if (incomingExplicitSingle) {
          nextMss = {};
        } else if ((incomingMode === "MULTIPLE" || prevMode === "MULTIPLE") && Object.keys(prevMss).length > 0) {
          nextMss = { ...prevMss };
        } else {
          nextMss = {};
        }
      } else {
        nextMss = { ...prevMss, ...inc };
      }
    }
    // Stabilize multiCoinSignalTabSymbols order: only accept a new tab list if the SET of symbols
    // changed (additions/removals). Pure reorders from universe scans are ignored so tabs don't
    // constantly shuffle while the bot is running in MULTIPLE mode.
    const incTabsRaw = (botPayload as Record<string, unknown>).multiCoinSignalTabSymbols;
    const incTabs = Array.isArray(incTabsRaw) ? (incTabsRaw as string[]) : null;
    const prevTabs2 = Array.isArray(prevBot.multiCoinSignalTabSymbols)
      ? (prevBot.multiCoinSignalTabSymbols as string[])
      : [];
    let stableTabSymbols: string[] | undefined;
    if (incTabs !== null) {
      const incSet = new Set(incTabs.map((s) => String(s).toUpperCase()));
      const prevSet = new Set(prevTabs2.map((s) => String(s).toUpperCase()));
      const setsEqual = incSet.size === prevSet.size && [...incSet].every((s) => prevSet.has(s));
      if (setsEqual && prevTabs2.length > 0) {
        // Same symbols, different order — keep previous stable order
        stableTabSymbols = prevTabs2;
      } else {
        // Symbols added or removed — accept the new list (preserves order of retained symbols)
        const prevOrder = new Map(prevTabs2.map((s, i) => [String(s).toUpperCase(), i]));
        stableTabSymbols = [
          ...prevTabs2.filter((s) => incSet.has(String(s).toUpperCase())),
          ...incTabs.filter((s) => !prevSet.has(String(s).toUpperCase())),
        ];
        void prevOrder; // used for type-checking only
      }
    }
    if (stableTabSymbols !== undefined) {
      (botPayload as Record<string, unknown>).multiCoinSignalTabSymbols = stableTabSymbols;
    }
    const liveBotNext: Record<string, unknown> = { ...prevBot, ...botPayload, multiSymbolWatchSignals: nextMss };
    const modeSlugForDraft = tradingModeToApiModeSlug(String(nextMode));
    const wsDraftCtx = draftByModeWithInstanceContext(prev, modeSlugForDraft);
    const instanceSwitchInFlight =
      typeof prev.instanceConfigLoadingId === "string" && prev.instanceConfigLoadingId.trim().length > 0;
    const editingConfig = hasActiveConfigDraftForMode(prev, modeSlugForDraft);
    const configDirty = prev.strategyConfigDirtyByMode[modeSlugForDraft] === true;
    const pinnedConfigView = prev.configViewByMode[modeSlugForDraft];
    const preserveConfigView =
      !chartRekey &&
      !modeChanged &&
      (instanceSwitchInFlight ||
        editingConfig ||
        (configDirty && pinnedConfigView && typeof pinnedConfigView === "object"));
    if (instanceSwitchInFlight && !chartRekey && !modeChanged) {
      const runtimeOverlay = runtimeBotOverlayFromPayload(liveBotNext);
      const modeKeySync = String(nextMode || prev.mode || "PAPER").toUpperCase();
      let nextBot: Record<string, unknown> | null | undefined =
        prev.bot && typeof prev.bot === "object" && !Array.isArray(prev.bot)
          ? { ...(prev.bot as Record<string, unknown>), ...runtimeOverlay }
          : prev.bot;
      if (payloadHadRunningByMode && typeof nextRb[modeKeySync] === "boolean") {
        nextBot = { ...(nextBot as Record<string, unknown>), running: Boolean(nextRb[modeKeySync]) };
      }
      configUnchangedFastPath = true;
      return {
        mode: nextMode,
        runningByMode: nextRb,
        liveBot: prev.liveBot,
        bot: nextBot,
        account: nextAccount,
        positions: nextPositions,
      };
    }
    if (!editingConfig && !chartRekey && !modeChanged) {
      const prevView = prev.configViewByMode[modeSlugForDraft];
      const draftEmpty = !hasActiveConfigDraftForMode(prev, modeSlugForDraft);
      if (prevView && draftEmpty) {
        const candidate = normalizeIntradayGatesOnBot(composeViewBotFromLiveAndDraft(liveBotNext, {}));
        const nextFp = signalBrainBotFingerprint(candidate);
        const prevFp = signalBrainBotFingerprint(prevView);
        if (nextFp === prevFp) {
          configUnchangedFastPath = true;
          const runtimeOverlay = runtimeBotOverlayFromPayload(liveBotNext);
          const modeKeyFast = String(nextMode || prev.mode || "PAPER").toUpperCase();
          let nextBot: Record<string, unknown> | null | undefined =
            prev.bot && typeof prev.bot === "object" && !Array.isArray(prev.bot)
              ? { ...(prev.bot as Record<string, unknown>), ...runtimeOverlay }
              : prev.bot;
          if (payloadHadRunningByMode && typeof nextRb[modeKeyFast] === "boolean") {
            nextBot = { ...(nextBot as Record<string, unknown>), running: Boolean(nextRb[modeKeyFast]) };
          }
          return {
            mode: nextMode,
            runningByMode: nextRb,
            liveBot: liveBotNext,
            bot: nextBot,
            account: nextAccount,
            positions: nextPositions,
          };
        }
      }
    }
    let mergedBot: Record<string, unknown>;
    if (preserveConfigView) {
      const base =
        pinnedConfigView && typeof pinnedConfigView === "object"
          ? (pinnedConfigView as Record<string, unknown>)
          : prev.bot && typeof prev.bot === "object" && !Array.isArray(prev.bot)
            ? (prev.bot as Record<string, unknown>)
            : deriveViewBot(nextMode, liveBotNext, wsDraftCtx);
      mergedBot = { ...base, ...runtimeBotOverlayFromPayload(liveBotNext) };
    } else {
      mergedBot = deriveViewBot(nextMode, liveBotNext, wsDraftCtx);
    }
    const modeKeySync = String(nextMode || prev.mode || "PAPER").toUpperCase();
    if (!editingConfig && payloadHadRunningByMode && typeof nextRb[modeKeySync] === "boolean") {
      mergedBot = { ...mergedBot, running: Boolean(nextRb[modeKeySync]) };
    }
    const configSlice =
      !preserveConfigView && !chartRekey && !modeChanged
        ? strategyConfigSlicePatch(nextMode, modeSlugForDraft, liveBotNext, wsDraftCtx, prev)
        : null;
    if (configSlice?.bot) {
      mergedBot = configSlice.bot;
    }
    const out = {
      mode: nextMode,
      runningByMode: nextRb,
      liveBot: liveBotNext,
      bot: mergedBot,
      account: nextAccount,
      positions: nextPositions,
      ...(configSlice
        ? {
            configViewByMode: configSlice.configViewByMode,
            configViewSeqByMode: configSlice.configViewSeqByMode,
            strategySavePayloadByMode: configSlice.strategySavePayloadByMode,
          }
        : {}),
      ...(chartRekey || modeChanged ? { candles: [], market: undefined, depth: undefined } : {}),
      ...(modeChanged ? { trades: [], selectedInstanceId: null } : {}),
      ...(nextSav ? { activeStrategyVersionByMode: nextSav } : {}),
      ...(nextAi ? { activeInstanceByMode: nextAi } : {}),
    };
    if (modeChanged) {
      const slug = tradingModeToApiModeSlug(String(nextMode));
      queueMicrotask(() => {
        void useAppStore.getState().fetchAccountsForMode(slug);
        void useAppStore.getState().fetchStrategiesForMode(slug);
        void useAppStore.getState().fetchInstancesForMode(slug);
      });
    }
    return out;
  });
  if (p.mode != null) maybeClearModeSwitchPending(String(p.mode));
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const ack = (payload as Record<string, unknown>).uiChartFocusSymbol;
    if (ack !== undefined) {
      const st = useAppStore.getState();
      if (
        !shouldIgnoreStaleWsChartFocusAck(ack, st.chartDisplaySymbol, String(st.bot?.symbol ?? ""))
      ) {
        noteChartFocusAckFromServer(ack != null ? String(ack) : null);
      }
    }
  }
  const m = useAppStore.getState().mode;
  if (m && !configUnchangedFastPath) {
    const slug = tradingModeToApiModeSlug(String(m));
    scheduleStrategyConfigDirtyRecomputeFromBot(slug, useAppStore.getState().bot);
  }
}

/**
 * Pull `/api/state` and merge into the store (credentials included). Use when WebSocket is down
 * (e.g. reverse proxy missing Upgrade) so the UI still updates.
 */
export async function hydrateStateViaHttp(): Promise<void> {
  try {
    const res = await api.state();
    if (!res?.ok || !res.bot) return;
    const wsOff = !useAppStore.getState().ws.connected;
    let botShape = { ...res.bot } as Record<string, unknown>;
    if (wsOff) {
      const prefs = loadTradingUiPrefs(useAppStore.getState().authUiUserTag ?? null);
      const m = String(res.mode || "").toUpperCase();
      const patch = prefs?.byMode?.[m];
      if (patch && Object.keys(patch).length) {
        botShape = mergePersistedBotPreferServer(botShape, patch as Record<string, unknown>);
      }
    }
    const activeInstanceByMode =
      res.activeInstanceByMode != null && typeof res.activeInstanceByMode === "object"
        ? parseActiveInstanceByModeFromServer(res.activeInstanceByMode)
        : undefined;
    const httpSlug = tradingModeToApiModeSlug(String(res.mode || ""));
    const payload = {
      mode: res.mode,
      ...botShape,
      account: res.account,
      positions: res.positions,
      ...(res.runningByMode != null && typeof res.runningByMode === "object"
        ? { runningByMode: res.runningByMode }
        : {}),
      ...(activeInstanceByMode ? { activeInstanceByMode } : {}),
    };
    applyWsStateSnapshot(payload);
    if (res.activeAccountByMode != null && typeof res.activeAccountByMode === "object") {
      useAppStore.setState({
        activeAccountByMode: parseActiveAccountByModeFromServer(res.activeAccountByMode),
      });
    }
    if (res.activeStrategyVersionByMode != null && typeof res.activeStrategyVersionByMode === "object") {
      useAppStore.setState({
        activeStrategyVersionByMode: parseActiveStrategyVersionByModeFromServer(res.activeStrategyVersionByMode),
      });
    }
    if (activeInstanceByMode) {
      useAppStore.setState({ activeInstanceByMode });
      const activeInstId = activeInstanceByMode[httpSlug];
      if (activeInstId) {
        useAppStore.setState((s) => {
          const warm = warmInstanceConfigCachePatch(s, httpSlug);
          const base = warm ? { ...s, configViewByInstanceId: warm } : s;
          const patch = applyOptimisticInstanceConfig(base, httpSlug, activeInstId);
          return {
            selectedInstanceId: activeInstId,
            ...(warm ? { configViewByInstanceId: warm } : {}),
            ...(patch ?? {}),
          };
        });
      }
    }
    void useAppStore.getState().fetchInstancesForMode(httpSlug);
    if (Array.isArray(res.trades)) {
      useAppStore.setState({ trades: res.trades.slice(0, TRADE_HISTORY_UI_MAX) });
    }
    if (wsOff) {
      queueMicrotask(() => scheduleTradingUiSessionRestore(String(res.mode || "")));
    }
  } catch {
    /* ignore: auth/network */
  }
}

/** Close the app WebSocket and suppress auto-reconnect (e.g. UI auth logout). */
export function forceDisconnectWebSocket() {
  tradingUiSessionRestoreStarted = false;
  wsIntentionalClose = true;
  pendingMarketFlushScheduled = false;
  pendingMarketBySymbol = null;
  pendingStateFlushScheduled = false;
  pendingWsStatePayload = undefined;
  pendingDepthFlushScheduled = false;
  pendingDepthPayload = null;
  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  const w = (window as any).__app_ws as WebSocket | undefined;
  if (w) {
    try {
      w.close();
    } catch {
      /* ignore */
    }
    (window as any).__app_ws = undefined;
  }
  useAppStore.setState((s) => ({ ws: { ...s.ws, connected: false } }));
}

