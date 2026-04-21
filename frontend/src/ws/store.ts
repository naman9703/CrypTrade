import { create } from "zustand";
import { api } from "../api/client";
import {
  botMatchesPersistedPatch,
  loadTradingUiPrefs,
  mergePersistedBotPatch,
} from "../lib/tradingUiPersistence";
import { isPlausibleCandleClose } from "../lib/symbolPriceSanity";
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

  connect: () => void;
  setBot: (bot: any) => void;
  setChartDisplaySymbol: (sym: string | null) => void;
  pushLog: (p: LogPayload) => void;
};

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

/** Coalesce burst `market` WS frames to one store commit per animation frame (bad links / JS backlog). */
let pendingMarketPayload: MarketPayload | null = null;
let pendingMarketRaf = 0;

/** One-shot: push saved mode + /api/bot/config after load (hello or first HTTP hydrate). */
let tradingUiSessionRestoreStarted = false;

function scheduleTradingUiSessionRestore(serverMode: string) {
  if (typeof window === "undefined" || tradingUiSessionRestoreStarted) return;
  const tag = useAppStore.getState().authUiUserTag ?? null;
  const prefs = loadTradingUiPrefs(tag);
  if (!prefs) return;
  const want = String(prefs.lastMode || "").toUpperCase();
  const have = String(serverMode || "").toUpperCase();
  const modeMismatch = Boolean(want && want !== have);
  const patchForHave = prefs.byMode[have];
  const needBotRestore =
    patchForHave &&
    typeof patchForHave === "object" &&
    Object.keys(patchForHave as Record<string, unknown>).length > 0;
  if (!modeMismatch && !needBotRestore) return;
  tradingUiSessionRestoreStarted = true;

  void (async () => {
    try {
      if (modeMismatch) {
        if (want === "BINANCE_LIVE") {
          const ok = window.confirm(
            "BINANCE LIVE (mainnet): real funds — losses possible. Requires BINANCE_LIVE_TRADING_ENABLED=1 on the server. Restore your saved LIVE mode?",
          );
          if (!ok) return;
        }
        await api.setMode(want as "PAPER" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_LIVE");
      }
    } catch {
      /* ignore */
    }

    try {
      const modeNow = String(useAppStore.getState().mode || serverMode || "").toUpperCase();
      const patch = prefs.byMode[modeNow];
      if (!patch || typeof patch !== "object" || !Object.keys(patch).length) return;
      const botNow = useAppStore.getState().bot as Record<string, unknown> | undefined;
      if (botNow && botMatchesPersistedPatch(botNow, patch as Record<string, unknown>)) return;
      await api.botConfig(patch);
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
  const payloadSym = normWsSym(p.symbol);
  const viewSym = normWsSym(s.chartDisplaySymbol ?? s.bot?.symbol);
  /** Stale or misrouted ticks (WS backlog) must not append into another pair’s candle buffer. */
  if (viewSym && payloadSym && viewSym !== payloadSym) {
    return s;
  }
  /**
   * Must detect pair changes even when `market` was briefly undefined; the old logic used
   * `prevSymbol && prevSymbol !== p.symbol`, which kept `symbolChanged` false and merged
   * BTC (etc.) history with BNB ticks — HUD/chart then flickered plausible-but-wrong prices.
   */
  const prevMarketSym = normWsSym(s.market?.symbol);
  const symbolChanged = prevMarketSym !== payloadSym;
  const prev = symbolChanged ? [] : s.candles;
  const lastPrev = prev.length ? prev[prev.length - 1] : null;
  const prevClose =
    lastPrev && Number.isFinite(Number(lastPrev.close)) ? Number(lastPrev.close) : null;
  if (
    c == null ||
    !Number.isFinite(Number(c.ts)) ||
    ![o, h, l, cl].every((x) => Number.isFinite(x) && x > 0) ||
    !isPlausibleCandleClose(String(p.symbol ?? ""), cl, l, prevClose)
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
  const marketMerged: MarketPayload = {
    ...p,
    supertrendLine: stLine,
    supertrendSignals: stSig,
  };
  return { market: marketMerged, candles: next };
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
  runningByMode: {},
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
            const logsFromServer = act
              .slice(0, 500)
              .map((row: unknown) => {
                const r = row as Record<string, unknown>;
                const tsIso =
                  typeof r.ts === "string" && r.ts.length >= 10
                    ? r.ts
                    : typeof r.serverTs === "string" && r.serverTs.length >= 10
                      ? r.serverTs
                      : new Date().toISOString();
                return { ...(r as LogPayload), ts: tsIso };
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
                ? mergePersistedBotPatch(p.state as Record<string, unknown>, patchHello as Record<string, unknown>)
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
              bot: mergedHelloBot,
              account:
                (p as any).account !== undefined ? (p as any).account : s.account,
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
          applyWsStateSnapshot(payload);
          return;
        }
        if (type === "market") {
          pendingMarketPayload = payload as MarketPayload;
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
          set({ depth: payload as DepthPayload });
          return;
        }
        if (type === "external") {
          set({ external: payload as ExternalPayload });
          return;
        }
      } catch {
        // ignore
      }
    };
  },

  setBot: (bot) => set({ bot }),

  setChartDisplaySymbol: (sym) =>
    set({
      chartDisplaySymbol: sym == null || String(sym).trim() === "" ? null : normWsSym(String(sym)),
    }),

  pushLog: (p) =>
    set((s) => {
      const raw = p as Record<string, unknown>;
      const tsIso =
        typeof raw.ts === "string" && raw.ts.length >= 10
          ? raw.ts
          : typeof raw.serverTs === "string" && raw.serverTs.length >= 10
            ? raw.serverTs
            : new Date().toISOString();
      return {
        logs: [{ ...p, ts: tsIso }, ...s.logs].slice(0, 500),
      };
    }),
}));

function scheduleMarketFlush() {
  if (pendingMarketRaf) return;
  pendingMarketRaf = requestAnimationFrame(() => {
    pendingMarketRaf = 0;
    const p = pendingMarketPayload;
    pendingMarketPayload = null;
    if (!p) return;
    useAppStore.setState((s) => mergeMarketIntoState(s, p) as AppState);
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
      (prevSym && nextSym && prevSym !== nextSym) || (prevTf && nextTf && prevTf !== nextTf);
    const nextMode = p.mode != null ? String(p.mode) : prev.mode;
    const modeChanged = p.mode != null && String(prev.mode ?? "") !== String(p.mode);
    const nextAccount = p.account !== undefined ? p.account : prev.account;
    const rawPos = p.positions;
    const nextPositions =
      rawPos !== undefined ? (Array.isArray(rawPos) ? rawPos : []) : prev.positions;
    const nextRb =
      p.runningByMode != null && typeof p.runningByMode === "object"
        ? (p.runningByMode as Record<string, boolean>)
        : prev.runningByMode ?? {};
    const botPayload = { ...p };
    delete (botPayload as { runningByMode?: unknown }).runningByMode;
    return {
      mode: nextMode,
      runningByMode: nextRb,
      bot: botPayload,
      account: nextAccount,
      positions: nextPositions,
      ...(chartRekey ? { candles: [], market: undefined } : {}),
      ...(modeChanged ? { trades: [] } : {}),
    };
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
        botShape = mergePersistedBotPatch(botShape, patch as Record<string, unknown>);
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
  if (pendingMarketRaf) {
    cancelAnimationFrame(pendingMarketRaf);
    pendingMarketRaf = 0;
  }
  pendingMarketPayload = null;
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

