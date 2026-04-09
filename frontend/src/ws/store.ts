import { create } from "zustand";
import { api } from "../api/client";
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

type HelloPayload = { serverTs: string; state: any; mode: string; chart?: ChartSnapshotPayload | null };

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
  bot?: any;
  account?: any;
  positions?: any[];
  market?: MarketPayload;
  depth?: DepthPayload;
  external?: ExternalPayload;
  candles: Candle[];
  logs: Array<{ ts: string } & LogPayload>;
  trades: TradePayload[];

  connect: () => void;
  setBot: (bot: any) => void;
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

/** Docker sets `ENV VITE_BACKEND_WS=` (empty); `??` does not treat "" as missing, so we normalize. */
const viteWsOverride = String(import.meta.env.VITE_BACKEND_WS ?? "").trim();
const WS_URL =
  (viteWsOverride || undefined) ??
  wsUrlFromBackendHttp() ??
  (import.meta.env.DEV ? defaultDevWsUrl() : productionSameOriginWsUrl());
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
let wsReconnectDelay = WS_RECONNECT_BASE_MS;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** When true, the next `onclose` must not schedule reconnect (logout / auth gate). */
let wsIntentionalClose = false;

/** Coalesce burst `market` WS frames to one store commit per animation frame (bad links / JS backlog). */
let pendingMarketPayload: MarketPayload | null = null;
let pendingMarketRaf = 0;

function mergeMarketIntoState(s: AppState, p: MarketPayload): AppState | Partial<AppState> {
  const c = p.candle;
  const o = Number(c?.open);
  const h = Number(c?.high);
  const l = Number(c?.low);
  const cl = Number(c?.close);
  const prevSymbol = s.market?.symbol;
  const symbolChanged = prevSymbol && prevSymbol !== p.symbol;
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
  candles: [],
  logs: [],
  trades: [],
  account: undefined,
  positions: [],

  connect: () => {
    const existing = (window as any).__app_ws as WebSocket | undefined;
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }

    wsIntentionalClose = false;
    const ws = new WebSocket(WS_URL);
    (window as any).__app_ws = ws;

    const isCurrent = () => (window as any).__app_ws === ws;

    ws.onopen = () => {
      if (!isCurrent()) return;
      wsReconnectDelay = WS_RECONNECT_BASE_MS;
      set((s) => ({ ws: { ...s.ws, connected: true, lastError: undefined } }));
    };
    const scheduleReconnect = () => {
      if (!isCurrent()) return;
      set((s) => ({ ws: { ...s.ws, connected: false } }));
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
    ws.onclose = scheduleReconnect;
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
            const strictAcc =
              p.mode === "BINANCE_LIVE" || p.mode === "BINANCE_TESTNET";
            const accMissing = strictAcc && (p as any).account === null;
            const base: Partial<AppState> = {
              mode: p.mode,
              bot: p.state,
              account:
                (p as any).account !== undefined ? (p as any).account : s.account,
              positions:
                (p as any).positions !== undefined ? (p as any).positions : s.positions,
              ...(logsFromServer.length ? { logs: logsFromServer } : {}),
              ...(accMissing ? { trades: [] } : {}),
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
          return;
        }
        if (type === "trades_snapshot") {
          const raw = payload as any;
          const replace = raw && typeof raw === "object" && !Array.isArray(raw) && raw.replace === true;
          const arr: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.trades) ? raw.trades : [];
          set((s) => {
            const m = s.mode;
            const strict = m === "BINANCE_LIVE" || m === "BINANCE_TESTNET";
            if (replace) {
              return { trades: arr.slice(0, TRADE_HISTORY_UI_MAX) };
            }
            if (arr.length === 0 && strict) {
              return { trades: [] };
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
            if (id != null && id !== "" && s.trades.some((t: any) => t?.id === id)) {
              return s;
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
    return {
      mode: nextMode,
      bot: p,
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
    const payload = { mode: res.mode, ...res.bot, account: res.account, positions: res.positions };
    applyWsStateSnapshot(payload);
    if (Array.isArray(res.trades)) {
      useAppStore.setState({ trades: res.trades.slice(0, TRADE_HISTORY_UI_MAX) });
    }
  } catch {
    /* ignore: auth/network */
  }
}

/** Close the app WebSocket and suppress auto-reconnect (e.g. UI auth logout). */
export function forceDisconnectWebSocket() {
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

