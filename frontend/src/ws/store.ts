import { create } from "zustand";
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
};

type LogPayload = { level: "info" | "warn" | "error"; msg: string; [k: string]: unknown };

type TradePayload = Record<string, unknown>;

type HelloPayload = { serverTs: string; state: any; mode: string };

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
const WS_URL =
  import.meta.env.VITE_BACKEND_WS ??
  (import.meta.env.DEV ? defaultDevWsUrl() : productionSameOriginWsUrl());
const WS_RECONNECT_BASE_MS = 1000;
const WS_RECONNECT_MAX_MS = 30000;
let wsReconnectDelay = WS_RECONNECT_BASE_MS;
let wsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

    const ws = new WebSocket(WS_URL);
    (window as any).__app_ws = ws;

    ws.onopen = () => {
      wsReconnectDelay = WS_RECONNECT_BASE_MS;
      set((s) => ({ ws: { ...s.ws, connected: true, lastError: undefined } }));
    };
    const scheduleReconnect = () => {
      set((s) => ({ ws: { ...s.ws, connected: false } }));
      if (wsReconnectTimer) return;
      wsReconnectTimer = setTimeout(() => {
        wsReconnectTimer = null;
        (window as any).__app_ws = undefined;
        get().connect();
        wsReconnectDelay = Math.min(wsReconnectDelay * 2, WS_RECONNECT_MAX_MS);
      }, wsReconnectDelay);
    };
    ws.onclose = scheduleReconnect;
    ws.onerror = () => set((s) => ({ ws: { ...s.ws, lastError: "ws_error" } }));

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        const { type, payload } = msg;
        if (type === "hello") {
          const p = payload as HelloPayload;
          set({
            mode: p.mode,
            bot: p.state,
            account: (p as any).account ?? get().account,
            positions: (p as any).positions ?? get().positions,
          });
          return;
        }
        if (type === "trades_snapshot") {
          const arr = Array.isArray(payload) ? payload : [];
          set((s) => {
            const existingIds = new Set(s.trades.map((t: any) => t?.id).filter(Boolean));
            const deduped = arr.filter((t: any) => !existingIds.has(t?.id));
            return { trades: [...deduped, ...s.trades].slice(0, 300) };
          });
          return;
        }
        if (type === "state") {
          const prev = get();
          const nextAccount = payload?.account ?? prev.account;
          const rawPos = payload?.positions;
          const nextPositions = Array.isArray(rawPos)
            ? rawPos
            : rawPos === undefined
              ? prev.positions
              : prev.positions;
          set({ mode: payload?.mode ?? prev.mode, bot: payload, account: nextAccount, positions: nextPositions });
          return;
        }
        if (type === "market") {
          const p = payload as MarketPayload;
          set((s) => {
            const c = p.candle;
            const prevSymbol = s.market?.symbol;
            const symbolChanged = prevSymbol && prevSymbol !== p.symbol;
            const prev = symbolChanged ? [] : s.candles;
            // Same as backend buffer: updates for the current bar share `ts`; appending would duplicate
            // bar times and crash lightweight-charts (blank screen).
            let next: Candle[];
            if (prev.length && Number(prev[prev.length - 1]?.ts) === Number(c?.ts)) {
              next = [...prev.slice(0, -1), { ...prev[prev.length - 1], ...c }];
            } else {
              next = [...prev, c];
            }
            next = next.slice(-300);
            return { market: p, candles: next };
          });
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
          set((s) => ({ trades: [p, ...s.trades].slice(0, 200) }));
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
    set((s) => ({
      logs: [{ ts: new Date().toISOString(), ...p }, ...s.logs].slice(0, 300),
    })),
}));

