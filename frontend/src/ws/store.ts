import { create } from "zustand";
import { api } from "../api/client";
import { tradingModeToApiModeSlug, type ApiTradingModeSlug } from "../lib/tradingModeSlug";
import type { Account, CreateAccountDto, UpdateAccountDto } from "../types/accounts";
import {
  enqueueServerUiPrefsPatch,
  loadTradingUiPrefs,
  mergePersistedBotPreferServer,
  tradingUiPersistShowMarketIntelligencePanel,
} from "../lib/tradingUiPersistence";
import type { CreateStrategyDto, Strategy, StrategyMetaPatch, StrategyVersion } from "../types/strategy";
import type { BotInstance, CreateInstanceDto } from "../types/instance";
import type { Trade } from "../types/trade";
import type { EquityCurvePoint, PerformanceCompareRow, StrategyPerformance } from "../types/performance";
import type { IntelligenceData } from "../types/intelligence";
import { isPlausibleCandleClose, normalizeSym } from "../lib/symbolPriceSanity";
import { isIncomeLedgerClose, playProfitCloseSound } from "../lib/uiSounds";

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
  /** When APP_UI_AUTH_ENABLED: server `/api/auth/me` + hello `uiUserTag` for scoped localStorage prefs. */
  authUiUserTag?: string | null;
  /** Server hello: session-scoped mode (each login has its own selected mode). */
  perSessionTradingMode?: boolean;
  /** Server: bot `running` flag per TRADING_MODE (parallel engines). */
  runningByMode?: Record<string, boolean>;
  bot?: any;
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
  /** Main view: 'overview' is the default landing (analytics/instances list); 'instance' is the full trading UI for a selected instance. */
  mainView: "overview" | "instance";
  /** Market intelligence data keyed by symbol. */
  intelligence: Record<string, IntelligenceData>;
  /** When true, Market Intelligence is shown under the chart order book (instance trading UI only). */
  showMarketIntelligencePanel: boolean;
  /** Unsaved strategy-config edits (set on bot config change; cleared by explicit save). */
  strategyConfigDirtyByMode: Record<ApiTradingModeSlug, boolean>;

  connect: () => void;
  setBot: (bot: any) => void;
  setChartDisplaySymbol: (sym: string | null) => void;
  pushLog: (p: LogPayload) => void;
  fetchAccountsForMode: (modeSlug: ApiTradingModeSlug) => Promise<void>;
  selectAccount: (accountId: string | null) => void;
  setActiveAccountForMode: (modeSlug: ApiTradingModeSlug, accountId: string) => Promise<void>;
  createAccount: (modeSlug: ApiTradingModeSlug, data: CreateAccountDto) => Promise<Account>;
  updateAccount: (accountId: string, patch: UpdateAccountDto) => Promise<Account>;
  deactivateAccount: (accountId: string) => Promise<void>;

  fetchStrategiesForMode: (modeSlug: ApiTradingModeSlug, opts?: { includeArchived?: boolean }) => Promise<void>;
  fetchVersionsForStrategy: (strategyId: string) => Promise<void>;
  selectStrategy: (strategyId: string | null) => void;
  createStrategyForMode: (modeSlug: ApiTradingModeSlug, dto: CreateStrategyDto) => Promise<{ strategy: Strategy }>;
  updateStrategyMetaStore: (strategyId: string, patch: StrategyMetaPatch) => Promise<Strategy>;
  archiveStrategyStore: (strategyId: string) => Promise<void>;
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
  setActiveTradingInstanceForMode: (modeSlug: ApiTradingModeSlug, instanceId: string | null) => Promise<void>;
  selectInstance: (instanceId: string | null) => void;
  /** Returns number of trades returned in this request (0 on error). */
  fetchTradesForInstance: (instanceId: string, opts?: { limit?: number; append?: boolean }) => Promise<number>;
  setSidebarCollapsed: (which: "accounts" | "strategy", collapsed: boolean) => void;
  setInstancesPanelCollapsed: (collapsed: boolean) => void;
  hydrateLayoutFromServer: (layout: unknown) => void;
  setMainView: (v: "overview" | "instance") => void;
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

/** One-shot: push saved mode + /api/bot/config after load (hello or first HTTP hydrate). */
let tradingUiSessionRestoreStarted = false;

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
    if (d) useAppStore.setState({ depth: d });
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
  let next: Candle[];
  if (prev.length && Number(prev[prev.length - 1]?.ts) === Number(c?.ts)) {
    next = [...prev.slice(0, -1), { ...prev[prev.length - 1], ...c }];
  } else {
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
  return { market: marketMerged, candles: next };
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
  strategyConfigDirtyByMode: { paper: false, demo_api: false, testnet: false, live: false },
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
            const prevBulk =
              typeof s.activityLogBulkGeneration === "number" ? s.activityLogBulkGeneration : 0;
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
              bot: mergedHelloBot,
              account:
                (p as any).account !== undefined
                  ? mergeHybridAccountSnapshot(s.account, (p as any).account)
                  : s.account,
              positions:
                (p as any).positions !== undefined ? (p as any).positions : s.positions,
              logs: logsFromServer,
              activityLogBulkGeneration: prevBulk + 1,
            };
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
          queueMicrotask(() => scheduleTradingUiSessionRestore(String(p.mode || "")));
          queueMicrotask(() => {
            const slug = tradingModeToApiModeSlug(String(p.mode || ""));
            void useAppStore.getState().fetchAccountsForMode(slug);
            void useAppStore.getState().fetchStrategiesForMode(slug);
            void useAppStore.getState().fetchInstancesForMode(slug);
            // If no active instance for the new mode, reset to overview
            const activeInst = useAppStore.getState().activeInstanceByMode[slug];
            if (!activeInst) {
              useAppStore.getState().setMainView("overview");
            }
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
        if (type === "market") {
          const p = payload as MarketPayload;
          const k = normalizeSym(p.symbol);
          if (!k) return;
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
            const id = p?.id;
            if (id != null && id !== "") {
              const idx = s.trades.findIndex((t: any) => t?.id === id);
              if (idx >= 0) {
                const prev = s.trades[idx] as Record<string, unknown>;
                const prevType = String(prev?.type ?? "").toUpperCase();
                const nextType = String((p as Record<string, unknown>)?.type ?? "").toUpperCase();
                // Paper futures (and similar) reuse the position id for OPEN and CLOSE. Merging by id
                // would drop the open leg until the next full trades_snapshot, breaking the table and
                // open↔close resolution for net PnL.
                if (
                  prevType &&
                  nextType &&
                  prevType !== nextType &&
                  (prevType === "OPEN" || prevType === "CLOSE") &&
                  (nextType === "OPEN" || nextType === "CLOSE")
                ) {
                  return { trades: [p, ...s.trades].slice(0, TRADE_HISTORY_UI_MAX) };
                }
                const merged = {
                  ...prev,
                  ...p,
                  meta: {
                    ...((prev.meta as Record<string, unknown>) || {}),
                    ...((p as Record<string, unknown>).meta || {}),
                  },
                };
                const next = s.trades.slice();
                next[idx] = merged as TradePayload;
                return { trades: next.slice(0, TRADE_HISTORY_UI_MAX) };
              }
            }
            return { trades: [p, ...s.trades].slice(0, TRADE_HISTORY_UI_MAX) };
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

  setBot: (bot) => set({ bot }),

  setChartDisplaySymbol: (sym) => {
    const next = sym == null || String(sym).trim() === "" ? null : normWsSym(String(sym));
    set({ chartDisplaySymbol: next });
    if (chartFocusSyncTimer) clearTimeout(chartFocusSyncTimer);
    /** Immediate: delayed sync left live USD-M multiplex without `uiChartFocusSymbol` for ~120ms → ticked `market` stayed on the bot pair and the UI dropped every frame for the selected tab. */
    void api
      .botConfig({ uiChartFocusSymbol: next } as Record<string, unknown>)
      .catch(() => {});
    chartFocusSyncTimer = setTimeout(() => {
      chartFocusSyncTimer = null;
      void api
        .botConfig({ uiChartFocusSymbol: next } as Record<string, unknown>)
        .catch(() => {});
    }, 800);
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
    set({ accountsLoading: true, accountsError: null });
    try {
      const list = await api.getAccountsForMode(modeSlug);
      set({ accounts: list, accountsLoading: false, accountsError: null });
      const sel = get().selectedAccountId;
      if (sel && !list.some((a) => a.id === sel)) {
        const fallback = list.find((a) => a.isActive)?.id ?? null;
        set({ selectedAccountId: fallback });
      }
      // Auto-select first active account if none is set for this mode
      const activeForMode = get().activeAccountByMode[modeSlug];
      if (!activeForMode) {
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
    }
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

  fetchStrategiesForMode: async (modeSlug, opts) => {
    set({ strategiesLoading: true, strategiesError: null });
    try {
      const list = await api.getStrategiesForMode(modeSlug, opts);
      set((s) => ({
        strategiesByMode: { ...s.strategiesByMode, [modeSlug]: list },
        strategiesLoading: false,
        strategiesError: null,
      }));
    } catch (e) {
      set({
        strategiesLoading: false,
        strategiesError: e instanceof Error ? e.message : "strategies_fetch_failed",
      });
    }
  },

  fetchVersionsForStrategy: async (strategyId) => {
    try {
      const versions = await api.getStrategyVersions(strategyId);
      set((s) => ({
        versionsByStrategyId: { ...s.versionsByStrategyId, [strategyId]: versions },
      }));
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
    await api.setActiveStrategyForMode(modeSlug, versionId);
    set((s) => ({
      activeStrategyVersionByMode: { ...s.activeStrategyVersionByMode, [modeSlug]: versionId },
      strategyConfigDirtyByMode: { ...s.strategyConfigDirtyByMode, [modeSlug]: false },
    }));
  },

  fetchInstancesForMode: async (modeSlug) => {
    set({ instancesLoading: true });
    try {
      const list = await api.listInstancesForMode(modeSlug);
      set((s) => ({
        instancesByMode: { ...s.instancesByMode, [modeSlug]: list },
        instancesLoading: false,
      }));
    } catch {
      set({ instancesLoading: false });
    }
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

  setActiveTradingInstanceForMode: async (modeSlug, instanceId) => {
    const data = await api.setActiveInstanceForMode(modeSlug, instanceId);
    set((s) => ({
      activeInstanceByMode: { ...s.activeInstanceByMode, [modeSlug]: instanceId },
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
    const safe = v === "overview" || v === "instance" ? v : "overview";
    set({ mainView: safe });
    if (safe === "overview") {
      const slug = tradingModeToApiModeSlug(get().mode || "PAPER");
      set({ analyticsModeSlug: slug });
      void get().fetchComparisonData(slug);
    }
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
    set({ selectedInstanceId: instanceId, mainView: "instance" });
    await get().setActiveTradingInstanceForMode(slug, instanceId);
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
    const s = useAppStore.getState();
    const viewNorm = normalizeSym(s.chartDisplaySymbol ?? s.bot?.symbol);
    const pick =
      viewNorm && map.has(viewNorm)
        ? map.get(viewNorm)
        : undefined;
    if (!pick) return;
    useAppStore.setState((st) => mergeMarketIntoState(st, pick) as AppState);
  });
}

/** Same shape as server WS `state` / `hello.state` (mode + getPublicState + account + positions). */
export function applyWsStateSnapshot(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const p = payload as Record<string, unknown>;
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
      prev.bot && typeof prev.bot === "object" && !Array.isArray(prev.bot)
        ? (prev.bot as Record<string, unknown>)
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
    const mergedBot: Record<string, unknown> = { ...prevBot, ...botPayload, multiSymbolWatchSignals: nextMss };
    const modeKeySync = String(nextMode || prev.mode || "PAPER").toUpperCase();
    if (payloadHadRunningByMode && typeof nextRb[modeKeySync] === "boolean") {
      mergedBot.running = Boolean(nextRb[modeKeySync]);
    }
    const out = {
      mode: nextMode,
      runningByMode: nextRb,
      bot: mergedBot,
      account: nextAccount,
      positions: nextPositions,
      ...(chartRekey ? { candles: [], market: undefined } : {}),
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
    const payload = {
      mode: res.mode,
      ...botShape,
      account: res.account,
      positions: res.positions,
      ...(res.runningByMode != null && typeof res.runningByMode === "object"
        ? { runningByMode: res.runningByMode }
        : {}),
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
    if (res.activeInstanceByMode != null && typeof res.activeInstanceByMode === "object") {
      useAppStore.setState({
        activeInstanceByMode: parseActiveInstanceByModeFromServer(res.activeInstanceByMode),
      });
    }
    const httpSlug = tradingModeToApiModeSlug(String(res.mode || ""));
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

