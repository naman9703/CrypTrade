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

export const api = {
  async authMe() {
    return json<{ ok?: boolean; enabled?: boolean; authenticated?: boolean }>(await apiFetch(`${HTTP}/api/auth/me`));
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
  async state() {
    return json<any>(await apiFetch(`${HTTP}/api/state`));
  },
  /** Min notional + quote asset from Binance exchangeInfo (via backend). venue: SPOT | FUTURES | BOTH */
  async symbolConstraints(symbol?: string, venue?: string) {
    const q = new URLSearchParams();
    if (symbol) q.set("symbol", symbol);
    if (venue) q.set("venue", venue);
    const qs = q.toString();
    return json<any>(await apiFetch(`${HTTP}/api/symbol/constraints${qs ? `?${qs}` : ""}`));
  },
  /** ~24h window of OHLCV (+ supertrend line) from server Binance buffer; refetch after symbol/timeframe change. */
  async marketCandles(hours = 24) {
    return json<any>(
      await apiFetch(`${HTTP}/api/market/candles?hours=${encodeURIComponent(String(hours))}`),
    );
  },
  async universeScan() {
    return json<any>(await apiFetch(`${HTTP}/api/universe/scan`));
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
  async botStart(opts?: { reason?: string; detail?: Record<string, unknown> }) {
    return json<any>(
      await apiFetch(`${HTTP}/api/bot/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts ?? {}),
      }),
    );
  },
  async botStop(opts?: { reason?: string; detail?: Record<string, unknown> }) {
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
    const data = await json<any>(
      await apiFetch(`${HTTP}/api/bot/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }),
    );
    if (data?.ok && data.bot && typeof data.bot === "object") {
      const { tradingUiPersistBotSnapshot } = await import("../lib/tradingUiPersistence");
      const { useAppStore } = await import("../ws/store");
      tradingUiPersistBotSnapshot(useAppStore.getState().mode, data.bot as Record<string, unknown>);
    }
    return data;
  },
  async manualTrade(payload: { side: "BUY" | "SELL"; amountUsd: number; stopLossPct: number; takeProfitPct: number }) {
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
      const { tradingUiPersistMode } = await import("../lib/tradingUiPersistence");
      tradingUiPersistMode(mode);
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
};
