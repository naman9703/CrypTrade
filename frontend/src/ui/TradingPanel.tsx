import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { useAppStore } from "../ws/store";

const STRATS = [
  { key: "EMA_CROSS", label: "Trend (EMA crossover)" },
  { key: "RSI_MEAN", label: "Mean Reversion (RSI)" },
  { key: "BREAKOUT_VOL", label: "Breakout (Volume)" },
];

export function TradingPanel() {
  const bot = useAppStore((s) => s.bot);
  const pushLog = useAppStore((s) => s.pushLog);
  const [top, setTop] = useState<any[]>([]);
  const [btLoading, setBtLoading] = useState(false);
  const [coinBusy, setCoinBusy] = useState(false);
  // Bot configuration is always visible; this toggle only controls manual orders visibility below it.
  const [showManualOrders, setShowManualOrders] = useState(false);

  const [amountUsd, setAmountUsd] = useState(200);
  const [slPct, setSlPct] = useState(0.01);
  const [tpPct, setTpPct] = useState(0.016);

  const cfg = useMemo(() => {
    return {
      aiThreshold: Number(bot?.aiThreshold ?? 0.65),
      riskPerTrade: Number(bot?.riskPerTrade ?? 0.01),
      maxDailyLoss: Number(bot?.maxDailyLoss ?? 0.05),
      strategyMode: bot?.strategyMode ?? "AUTO",
      manualStrategy: bot?.manualStrategy ?? "EMA_CROSS",
      symbolMode: bot?.symbolMode ?? "SINGLE",
      marketMode: bot?.marketMode ?? "AUTO",
      futuresLeverageMode: (bot?.futuresLeverageMode as string) === "MANUAL" ? "MANUAL" : "AUTO",
      futuresLeverage: Number(bot?.futuresLeverage ?? 5),
    };
  }, [bot]);

  const rankedCoins = (bot?.universe?.ranked || []).slice(0, 12);

  useEffect(() => {
    let alive = true;
    const run = async () => {
      if (cfg.strategyMode !== "MANUAL") return;
      try {
        setBtLoading(true);
        const r = await api.backtest(700);
        if (!alive) return;
        setTop((r?.results || []).slice(0, 10));
      } catch {
        if (!alive) return;
        setTop([]);
      } finally {
        if (alive) setBtLoading(false);
      }
    };
    run();
    const id = setInterval(run, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [cfg.strategyMode]);

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">Trading</div>
          <div className="text-xs text-slate-400">Choose Manual or Bot configuration</div>
        </div>
      </div>

      <div className="mb-4">
        <div className="flex rounded-lg border border-slate-800 bg-slate-950/40 p-1">
          <button
            type="button"
            className={`flex-1 rounded-md px-3 py-2 text-xs font-semibold ${
              !showManualOrders
                ? "bg-emerald-600/80 text-slate-50 hover:bg-emerald-600"
                : "bg-slate-950/20 text-slate-300 hover:bg-slate-900"
            }`}
            onClick={() => setShowManualOrders(false)}
          >
            Bot configuration
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md px-3 py-2 text-xs font-semibold ${
              showManualOrders
                ? "bg-emerald-600/80 text-slate-50 hover:bg-emerald-600"
                : "bg-slate-950/20 text-slate-300 hover:bg-slate-900"
            }`}
            onClick={() => setShowManualOrders(true)}
          >
            Manual orders
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
        <div className="text-xs font-semibold text-slate-200">Auto trading / bot configuration</div>
        <div className="mt-2 grid gap-2 text-xs">
            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-400">Mode</span>
              <select
                className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-100"
                value={cfg.strategyMode}
                onChange={async (e) => {
                  try {
                    await api.botConfig({ strategyMode: e.target.value });
                  } catch {
                    pushLog({ level: "error", msg: "Failed to set strategy mode" });
                  }
                }}
              >
                <option value="AUTO">AUTO (regime-based)</option>
                <option value="MANUAL">MANUAL (pick strategy)</option>
              </select>
            </label>

            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-400">Coin select</span>
              <select
                className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-100"
                value={cfg.symbolMode}
                onChange={async (e) => {
                  const v = e.target.value;
                  try {
                    await api.botConfig({ symbolMode: v });
                    if (v === "AUTO") pushLog({ level: "info", msg: "Coin selection enabled (auto)" });
                    else pushLog({ level: "info", msg: "Coin selection disabled (single coin)" });
                  } catch {
                    pushLog({ level: "error", msg: "Failed to set coin selection mode" });
                  }
                }}
              >
                <option value="SINGLE">SINGLE (trade selected symbol)</option>
                <option value="AUTO">AUTO (scan + rank + pick)</option>
              </select>
            </label>

            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-400">Market</span>
              <select
                className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-100"
                value={cfg.marketMode}
                onChange={async (e) => {
                  try {
                    await api.botConfig({ marketMode: e.target.value });
                    pushLog({ level: "info", msg: "Market mode set", marketMode: e.target.value });
                  } catch {
                    pushLog({ level: "error", msg: "Failed to set market mode" });
                  }
                }}
              >
                <option value="AUTO">AUTO (model chooses spot vs futures)</option>
                <option value="SPOT">SPOT only</option>
                <option value="FUTURES">FUTURES only</option>
              </select>
            </label>

            {cfg.marketMode !== "SPOT" && (
              <>
                <label className="grid grid-cols-[110px_1fr] items-center gap-2">
                  <span className="text-slate-400">Lev. mode</span>
                  <select
                    className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-100"
                    value={cfg.futuresLeverageMode}
                    onChange={async (e) => {
                      const v = e.target.value as "AUTO" | "MANUAL";
                      try {
                        await api.botConfig({ futuresLeverageMode: v });
                        pushLog({
                          level: "info",
                          msg:
                            v === "AUTO"
                              ? "Futures leverage: model will choose per trade"
                              : "Futures leverage: using manual multiplier",
                        });
                      } catch {
                        pushLog({ level: "error", msg: "Failed to set leverage mode" });
                      }
                    }}
                  >
                    <option value="AUTO">AUTO (AI + volatility)</option>
                    <option value="MANUAL">MANUAL (fixed)</option>
                  </select>
                </label>
                {cfg.futuresLeverageMode === "MANUAL" ? (
                  <label className="grid grid-cols-[110px_1fr] items-center gap-2">
                    <span className="text-slate-400">Leverage ×</span>
                    <input
                      className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-100"
                      type="number"
                      min={1}
                      max={50}
                      step={1}
                      value={cfg.futuresLeverage}
                      onChange={async (e) => {
                        const v = Number(e.target.value);
                        try {
                          await api.botConfig({ futuresLeverage: v });
                        } catch {
                          pushLog({ level: "error", msg: "Failed to set futures leverage" });
                        }
                      }}
                    />
                  </label>
                ) : (
                  <div className="grid grid-cols-[110px_1fr] gap-2 text-[11px] leading-snug text-slate-500">
                    <span className="text-slate-400">Lev. ×</span>
                    <span>
                      Chosen automatically each trade from model confidence and volatility (conservative caps). Manual
                      value below is ignored until you switch to MANUAL.
                    </span>
                  </div>
                )}
              </>
            )}

            {cfg.symbolMode === "AUTO" && (
              <div className="mt-1 rounded-lg border border-slate-800 bg-slate-950/40">
                <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
                  <div className="text-xs font-semibold text-slate-200">Top coins (ranked)</div>
                  <button
                    disabled={coinBusy}
                    className="rounded-md border border-slate-700 bg-slate-900/50 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-900 disabled:opacity-50"
                    onClick={async () => {
                      setCoinBusy(true);
                      try {
                        await api.universeScan();
                        pushLog({ level: "info", msg: "Universe scan requested" });
                      } catch {
                        pushLog({ level: "warn", msg: "Universe scan failed" });
                      } finally {
                        setCoinBusy(false);
                      }
                    }}
                  >
                    {coinBusy ? "Scanning…" : "Scan now"}
                  </button>
                </div>
                <div className="max-h-[180px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-950">
                      <tr className="text-left text-slate-400">
                        <th className="px-3 py-2">Symbol</th>
                        <th className="px-3 py-2">AI</th>
                        <th className="px-3 py-2">Opp</th>
                        <th className="px-3 py-2">Spr%</th>
                        <th className="px-3 py-2">Pick</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rankedCoins.length === 0 ? (
                        <tr>
                          <td className="px-3 py-3 text-slate-500" colSpan={5}>
                            No scan results yet (set MARKET_FEED=BINANCE or BINANCE_FUTURES and symbol mode AUTO)
                          </td>
                        </tr>
                      ) : (
                        rankedCoins.map((c: any) => (
                          <tr key={c.symbol} className="border-t border-slate-900">
                            <td className="px-3 py-2 font-semibold text-slate-200">{c.symbol}</td>
                            <td className="px-3 py-2 text-slate-300">
                              {c.aiProb != null && Number.isFinite(Number(c.aiProb)) ? Number(c.aiProb).toFixed(3) : "—"}
                            </td>
                            <td className="px-3 py-2 text-slate-300">
                              {c.opportunity != null && Number.isFinite(Number(c.opportunity)) ? Number(c.opportunity).toFixed(2) : "—"}
                            </td>
                            <td className="px-3 py-2 text-slate-300">
                              {c.spreadPct != null && Number.isFinite(Number(c.spreadPct))
                                ? `${(Number(c.spreadPct) * 100).toFixed(2)}`
                                : "—"}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                className="rounded-md border border-slate-700 bg-slate-900/30 px-2 py-1 text-[11px] font-semibold text-slate-200 hover:bg-slate-900"
                                onClick={async () => {
                                  try {
                                    await api.botConfig({ symbolMode: "SINGLE", symbol: c.symbol });
                                    pushLog({ level: "info", msg: "Pinned symbol", symbol: c.symbol });
                                  } catch {
                                    pushLog({ level: "error", msg: "Failed to pin symbol" });
                                  }
                                }}
                              >
                                Pin
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="px-3 py-2 text-[11px] text-slate-500">
                  Selected: <span className="text-slate-300">{(bot?.universe?.selected || []).join(", ") || "—"}</span>
                </div>
              </div>
            )}

            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-400">Strategy</span>
              <select
                disabled={cfg.strategyMode !== "MANUAL"}
                className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-100 disabled:opacity-50"
                value={cfg.manualStrategy}
                onChange={async (e) => {
                  try {
                    await api.botConfig({ manualStrategy: e.target.value });
                  } catch {
                    pushLog({ level: "error", msg: "Failed to set manual strategy" });
                  }
                }}
              >
                {STRATS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>

            {cfg.strategyMode === "MANUAL" && (
              <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/40">
                <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
                  <div className="text-xs font-semibold text-slate-200">Top strategies (backtest)</div>
                  <div className="text-[11px] text-slate-500">{btLoading ? "running…" : "last 700 candles"}</div>
                </div>
                <div className="max-h-[180px] overflow-auto">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-slate-950">
                      <tr className="text-left text-slate-400">
                        <th className="px-3 py-2">Key</th>
                        <th className="px-3 py-2">Trades</th>
                        <th className="px-3 py-2">Win%</th>
                        <th className="px-3 py-2">PF</th>
                        <th className="px-3 py-2">PnL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {top.length === 0 ? (
                        <tr>
                          <td className="px-3 py-3 text-slate-500" colSpan={5}>
                            No backtest results yet
                          </td>
                        </tr>
                      ) : (
                        top.map((r) => (
                          <tr key={r.key} className="border-t border-slate-900">
                            <td className="px-3 py-2">
                              <button
                                className="font-semibold text-slate-200 hover:text-emerald-300"
                                onClick={async () => {
                                  try {
                                    await api.botConfig({ manualStrategy: r.key });
                                  } catch {
                                    pushLog({ level: "error", msg: "Failed to set manual strategy" });
                                  }
                                }}
                              >
                                {r.key}
                              </button>
                              <div className="text-[11px] text-slate-500">{r.name}</div>
                            </td>
                            <td className="px-3 py-2 text-slate-300">{r.trades}</td>
                            <td className="px-3 py-2 text-slate-300">{(Number(r.winRate || 0) * 100).toFixed(1)}</td>
                            <td className="px-3 py-2 text-slate-300">{Number(r.profitFactor || 0).toFixed(2)}</td>
                            <td className={`px-3 py-2 ${Number(r.netPnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                              {Number(r.netPnl || 0).toFixed(2)}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-400">AI threshold</span>
              <input
                className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-100"
                type="number"
                step="0.01"
                value={cfg.aiThreshold}
                onChange={async (e) => {
                  const v = Number(e.target.value);
                  try {
                    await api.botConfig({ aiThreshold: v });
                  } catch {
                    pushLog({ level: "error", msg: "Failed to set AI threshold" });
                  }
                }}
              />
            </label>

            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-400">Risk / trade</span>
              <input
                className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-100"
                type="number"
                step="0.001"
                value={cfg.riskPerTrade}
                onChange={async (e) => {
                  const v = Number(e.target.value);
                  try {
                    await api.botConfig({ riskPerTrade: v });
                  } catch {
                    pushLog({ level: "error", msg: "Failed to set risk per trade" });
                  }
                }}
              />
            </label>

            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-400">Max daily loss</span>
              <input
                className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-100"
                type="number"
                step="0.01"
                value={cfg.maxDailyLoss}
                onChange={async (e) => {
                  const v = Number(e.target.value);
                  try {
                    await api.botConfig({ maxDailyLoss: v });
                  } catch {
                    pushLog({ level: "error", msg: "Failed to set max daily loss" });
                  }
                }}
              />
            </label>
        </div>
      </div>

      {showManualOrders && (
        <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <div className="text-xs font-semibold text-slate-200">Manual trade</div>
          <div className="mt-2 grid gap-2 text-xs">
            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-400">Amount (USD)</span>
              <input
                className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-100"
                type="number"
                value={amountUsd}
                onChange={(e) => setAmountUsd(Number(e.target.value))}
              />
            </label>
            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-400">Stop-loss</span>
              <input
                className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-100"
                type="number"
                step="0.001"
                value={slPct}
                onChange={(e) => setSlPct(Number(e.target.value))}
              />
            </label>
            <label className="grid grid-cols-[110px_1fr] items-center gap-2">
              <span className="text-slate-400">Take-profit</span>
              <input
                className="rounded-md border border-slate-800 bg-slate-950 px-2 py-1 text-slate-100"
                type="number"
                step="0.001"
                value={tpPct}
                onChange={(e) => setTpPct(Number(e.target.value))}
              />
            </label>
            <div className="mt-2 flex gap-2">
              <button
                className="flex-1 rounded-md bg-emerald-600/80 px-3 py-2 font-semibold hover:bg-emerald-600"
                onClick={async () => {
                  try {
                    await api.manualTrade({
                      side: "BUY",
                      amountUsd,
                      stopLossPct: slPct,
                      takeProfitPct: tpPct,
                    });
                  } catch (e: any) {
                    pushLog({ level: "error", msg: "Manual BUY failed", error: String(e?.message || e) });
                  }
                }}
              >
                Buy
              </button>
              <button
                className="flex-1 rounded-md bg-rose-600/80 px-3 py-2 font-semibold hover:bg-rose-600"
                onClick={async () => {
                  try {
                    await api.manualTrade({
                      side: "SELL",
                      amountUsd,
                      stopLossPct: slPct,
                      takeProfitPct: tpPct,
                    });
                  } catch (e: any) {
                    pushLog({ level: "error", msg: "Manual SELL failed", error: String(e?.message || e) });
                  }
                }}
              >
                Sell
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

