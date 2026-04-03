const HTTP =
  import.meta.env.VITE_BACKEND_HTTP ??
  (import.meta.env.DEV ? "" : "http://localhost:8000");

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
  async state() {
    return json<any>(await fetch(`${HTTP}/api/state`));
  },
  async universeScan() {
    return json<any>(await fetch(`${HTTP}/api/universe/scan`));
  },
  async aiHealth() {
    return json<any>(await fetch(`${HTTP}/api/ai/health`));
  },
  async aiValidationSummary() {
    return json<any>(await fetch(`${HTTP}/api/ai/validation-summary`));
  },
  async botMetrics() {
    return json<any>(await fetch(`${HTTP}/api/metrics`));
  },
  async aiRetrain(minRows?: number) {
    return json<any>(
      await fetch(`${HTTP}/api/ai/retrain`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(minRows ? { minRows } : {}),
      })
    );
  },
  async botStart() {
    return json<any>(await fetch(`${HTTP}/api/bot/start`, { method: "POST" }));
  },
  async botStop() {
    return json<any>(await fetch(`${HTTP}/api/bot/stop`, { method: "POST" }));
  },
  async botConfig(patch: any) {
    return json<any>(
      await fetch(`${HTTP}/api/bot/config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      })
    );
  },
  async manualTrade(payload: { side: "BUY" | "SELL"; amountUsd: number; stopLossPct: number; takeProfitPct: number }) {
    return json<any>(
      await fetch(`${HTTP}/api/trade/manual`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
  },
  async closeTrade(id: string) {
    return json<any>(
      await fetch(`${HTTP}/api/trade/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id }),
      })
    );
  },
  async paperReset() {
    return json<any>(
      await fetch(`${HTTP}/api/paper/reset`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      })
    );
  },
  async backtest(limit = 600) {
    return json<any>(await fetch(`${HTTP}/api/backtest?limit=${encodeURIComponent(String(limit))}`));
  },
  async tradingEvaluation() {
    return json<any>(await fetch(`${HTTP}/api/trading/evaluation`));
  },
  async setMode(mode: "PAPER" | "BINANCE_DEMO" | "BINANCE_DEMO_FUTURES" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_FUTURES_TESTNET") {
    return json<any>(
      await fetch(`${HTTP}/api/mode/set`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode, confirm: true }),
      })
    );
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
      await fetch(`${HTTP}/api/ai/train-real`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(opts ?? {}),
      })
    );
  },
};

