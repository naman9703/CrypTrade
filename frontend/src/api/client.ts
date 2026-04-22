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
      tradingUiPersistBotSnapshot(
        useAppStore.getState().mode,
        data.bot as Record<string, unknown>,
        useAppStore.getState().authUiUserTag ?? null,
      );
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
};
