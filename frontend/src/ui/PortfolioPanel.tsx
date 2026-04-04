import { useMemo, useState } from "react";
import { useAppStore } from "../ws/store";
import { api } from "../api/client";
import { isIncomeLedgerClose } from "../lib/tradeClassification";

function isLedgerClose(t: any): boolean {
  return isIncomeLedgerClose(t);
}

function tradeTsMs(t: any): number {
  const ts = t?.ts;
  if (ts == null) return 0;
  const ms = new Date(String(ts)).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function PortfolioPanel() {
  const trades = useAppStore((s) => s.trades);
  const account = useAppStore((s) => s.account);
  const bot = useAppStore((s) => s.bot);
  const positions = useAppStore((s) => s.positions) || [];
  const pushLog = useAppStore((s) => s.pushLog);
  const mode = useAppStore((s) => s.mode);
  const exchName = useAppStore((s) => s.bot?.exchange?.name) as string | undefined;

  const [tradeHistoryView, setTradeHistoryView] = useState<"ALL" | "OPEN_ONLY" | "CLOSED_ONLY">("ALL");
  // Default "Strategy" (APP): futures demo emits many unmatched income shards; hide unless debugging.
  const [closeSourceFilter, setCloseSourceFilter] = useState<"ALL" | "APP" | "LEDGER">("APP");

  const closeTrades = (trades || []).filter((t: any) => t?.type === "CLOSE");
  const closeTradesApp = closeTrades.filter((t: any) => !isLedgerClose(t));
  const closeTradesLedger = closeTrades.filter((t: any) => isLedgerClose(t));

  const wins = closeTradesApp.reduce((a: number, t: any) => a + (Number(t?.pnl) > 0 ? 1 : 0), 0);
  const losses = closeTradesApp.reduce((a: number, t: any) => a + (Number(t?.pnl) < 0 ? 1 : 0), 0);
  const netRealizedPnlStrategy = closeTradesApp.reduce((a: number, t: any) => a + (Number(t?.pnl) || 0), 0);
  const netRealizedPnlLedger = closeTradesLedger.reduce((a: number, t: any) => a + (Number(t?.pnl) || 0), 0);
  const netRealizedPnlAll = netRealizedPnlStrategy + netRealizedPnlLedger;
  const winrate = wins + losses > 0 ? wins / (wins + losses) : null;

  const last10Min = useMemo(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    let appN = 0;
    let appPnl = 0;
    let ledN = 0;
    let ledPnl = 0;
    for (const t of trades || []) {
      if (t?.type !== "CLOSE") continue;
      if (tradeTsMs(t) < cutoff) continue;
      const p = Number(t?.pnl) || 0;
      if (isLedgerClose(t)) {
        ledN += 1;
        ledPnl += p;
      } else {
        appN += 1;
        appPnl += p;
      }
    }
    return { appN, appPnl, ledN, ledPnl };
  }, [trades]);

  const openPositionIdTokens = useMemo(() => {
    const set = new Set<string>();
    for (const p of positions) {
      const pid = String(p?.id ?? "");
      if (!pid) continue;
      set.add(pid);
      // Binance adapters sometimes use ids like `bn_<orderId>` / `demo_<orderId>`,
      // while older OPEN trade rows might store only `<orderId>`.
      const parts = pid.split("_");
      if (parts.length >= 2) set.add(parts.slice(1).join("_"));
    }
    return set;
  }, [positions]);

  const openTrades = useMemo(() => {
    const rows = (trades || []).filter((t: any) => t?.type === "OPEN");
    return rows.filter((t: any) => openPositionIdTokens.has(String(t?.id ?? "")));
  }, [trades, openPositionIdTokens]);

  const closedTrades = useMemo(() => {
    return (trades || []).filter((t: any) => t?.type === "CLOSE");
  }, [trades]);

  const displayedTrades = useMemo(() => {
    const rows = trades || [];
    const keepClose = (t: any) => {
      if (t?.type !== "CLOSE") return false;
      const led = isLedgerClose(t);
      if (closeSourceFilter === "APP" && led) return false;
      if (closeSourceFilter === "LEDGER" && !led) return false;
      return true;
    };
    if (tradeHistoryView === "OPEN_ONLY") return openTrades;
    if (tradeHistoryView === "CLOSED_ONLY") return closedTrades.filter(keepClose);
    if (closeSourceFilter === "ALL") return rows;
    return rows.filter((t: any) => (t?.type === "OPEN" ? true : keepClose(t)));
  }, [tradeHistoryView, openTrades, closedTrades, trades, closeSourceFilter]);

  /** BINANCE_DEMO_FUTURES without API keys uses local paper only — not Binance positions. */
  const isPaperFuturesLocal =
    mode === "BINANCE_DEMO_FUTURES" && exchName === "binance_demo_futures";

  const hasFuturesPositions = (positions || []).some((p: any) => p?.venue === "FUTURES");
  const isFuturesVenue =
    mode === "BINANCE_DEMO_FUTURES" ||
    mode === "BINANCE_FUTURES_TESTNET" ||
    exchName === "binance_demo_futures" ||
    exchName === "binance_demo_futures_usdm" ||
    exchName === "binance_futures_testnet_usdm" ||
    (exchName === "hybrid" && hasFuturesPositions);

  /** Realized-PnL income stream on demo USD-M muddies "winrate" on CLOSE rows. */
  const showFuturesIncomeLedgerNote =
    exchName === "binance_demo_futures_usdm" || (mode === "BINANCE_DEMO_API" && exchName === "hybrid");

  const canManualClosePosition =
    mode === "PAPER" ||
    mode === "BINANCE_DEMO" ||
    mode === "BINANCE_DEMO_FUTURES" ||
    mode === "BINANCE_DEMO_API" ||
    mode === "BINANCE_FUTURES_TESTNET" ||
    mode === "BINANCE_TESTNET";

  const subtitle =
    mode === "BINANCE_DEMO_API" || exchName === "binance_demo_spot"
      ? "Binance Demo Trading account"
      : mode === "BINANCE_TESTNET" || exchName === "binance_testnet_spot"
        ? "Binance Spot Testnet account"
        : mode === "BINANCE_DEMO" || exchName === "binance_demo"
          ? "Simulated account (live Binance feed) · persisted locally"
          : isPaperFuturesLocal
            ? "Simulated futures · positions are local files only (not Binance). Set BINANCE_DEMO_API_KEY + BINANCE_DEMO_API_SECRET to use Demo Futures (demo-fapi) in this mode."
            : exchName === "binance_demo_futures_usdm"
              ? "Binance Demo Futures (USD-M): positions and wallet from demo-fapi.binance.com."
              : mode === "BINANCE_FUTURES_TESTNET" || exchName === "binance_futures_testnet_usdm"
                ? "Binance Futures Testnet: positions from the futures account API."
                : isFuturesVenue
                  ? "Futures tools active; check exchange name in bot status for live vs local sim."
                  : "Paper account · persisted locally";

  const totalUnrealizedPnl = useMemo(() => {
    if (!positions?.length) return null;
    let sum = 0;
    let hasAny = false;
    for (const p of positions) {
      const u = Number(p?.unrealizedPnl ?? NaN);
      if (Number.isFinite(u)) { sum += u; hasAny = true; }
    }
    return hasAny ? sum : null;
  }, [positions]);

  const equityDisplay = useMemo(() => {
    const venues = (account as any)?.venues;
    if (venues?.spot || venues?.futures) {
      const mm = String((bot as any)?.marketMode || "AUTO").toUpperCase();
      const sRaw = venues?.spot?.equity;
      const fRaw = venues?.futures?.equity;
      const s = sRaw != null && Number.isFinite(Number(sRaw)) ? Number(sRaw) : null;
      const f = fRaw != null && Number.isFinite(Number(fRaw)) ? Number(fRaw) : null;
      if (mm === "FUTURES" && f != null) return f;
      if (mm === "SPOT" && s != null) return s;
      if (s != null && f != null) return s + f;
      if (s != null) return s;
      if (f != null) return f;
    }
    if ((account as any)?.equityWithUnrealized != null) return Number((account as any).equityWithUnrealized);
    if ((account as any)?.equity != null) return Number((account as any).equity);
    return null;
  }, [account, bot]);

  return (
    <div className="p-4">
      <div className="mb-2">
        <div className="text-sm font-semibold">Portfolio</div>
        <div className="text-xs text-slate-400">{subtitle}</div>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs">
          <div className="text-slate-400">Equity</div>
          <div className="mt-1 text-lg font-semibold text-slate-100">
            {equityDisplay != null && Number.isFinite(Number(equityDisplay)) ? `$${Number(equityDisplay).toFixed(2)}` : "—"}
          </div>
          {account?.accountError ? (
            <div className="mt-1 space-y-1 text-[11px] text-rose-300">
              <div>Account error: {String(account.accountError)}</div>
              {/451|restricted location/i.test(String(account.accountError)) ? (
                <div className="text-amber-200/90">
                  Binance is blocking this host (HTTP 451). Demo API keys will not load balance here — use{" "}
                  <span className="font-semibold">TRADING_MODE=PAPER</span> for local equity, or deploy where Binance allows your IP.
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-1 text-slate-500">
            Daily PnL (worst leg):{" "}
            <span className={Number(account?.dailyPnlPct || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}>
              {account?.dailyPnlPct != null ? `${(Number(account.dailyPnlPct) * 100).toFixed(2)}%` : "—"}
            </span>
          </div>
          {(account as any)?.dailyPnlPctByVenue ? (
            <div className="mt-1 text-[11px] text-slate-500">
              Spot day:{" "}
              <span
                className={
                  Number((account as any).dailyPnlPctByVenue.spot || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                }
              >
                {(account as any).dailyPnlPctByVenue.spot != null
                  ? `${(Number((account as any).dailyPnlPctByVenue.spot) * 100).toFixed(2)}%`
                  : "—"}
              </span>
              {" · "}
              Futures day:{" "}
              <span
                className={
                  Number((account as any).dailyPnlPctByVenue.futures || 0) >= 0 ? "text-emerald-400" : "text-rose-400"
                }
              >
                {(account as any).dailyPnlPctByVenue.futures != null
                  ? `${(Number((account as any).dailyPnlPctByVenue.futures) * 100).toFixed(2)}%`
                  : "—"}
              </span>
            </div>
          ) : null}
          <div className="mt-1 text-slate-500">
            Unrealized:{" "}
            <span className={(totalUnrealizedPnl ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400"}>
              {totalUnrealizedPnl != null ? `${totalUnrealizedPnl.toFixed(2)}` : "—"}
            </span>
          </div>
          {account?.venues?.spot || account?.venues?.futures ? (
            <div className="mt-2 rounded-md border border-slate-800 bg-slate-950/30 p-2 text-[11px] text-slate-300">
              <div className="text-slate-400">Breakdown</div>
              <div className="mt-1 grid grid-cols-2 gap-2">
                <div>
                  Spot:{" "}
                  <span className="text-slate-100">
                    {account?.venues?.spot?.equity != null ? `$${Number(account.venues.spot.equity).toFixed(2)}` : "—"}
                  </span>
                </div>
                <div>
                  Futures:{" "}
                  <span className="text-slate-100">
                    {account?.venues?.futures?.equity != null ? `$${Number(account.venues.futures.equity).toFixed(2)}` : "—"}
                  </span>
                </div>
              </div>
              <div className="mt-1 text-slate-500">
                Spot wallet: demo-api.binance.com · Futures wallet: demo-fapi.binance.com (when connected).
              </div>
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs">
          <div className="text-slate-400">Open positions</div>
          <div className="mt-1 text-lg font-semibold text-slate-100">{positions.length}</div>
          <div className="mt-1 text-slate-500">
            {mode === "PAPER" || mode === "BINANCE_DEMO"
              ? "SL/TP enforced (simulated)"
              : isPaperFuturesLocal
                ? "Rows are local simulated positions, not Binance open positions"
                : isFuturesVenue
                  ? "SL/TP enforced locally (exchange brackets not supported on demo)"
                  : "SL/TP enforced (OCO)"}
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs">
          <div className="text-slate-400">Net realised PnL</div>
          <div
            className={`mt-1 text-lg font-semibold ${netRealizedPnlAll >= 0 ? "text-emerald-400" : "text-rose-400"}`}
          >
            {Number.isFinite(netRealizedPnlAll) ? `$${netRealizedPnlAll.toFixed(2)}` : "—"}
          </div>
          <div className="mt-1 text-slate-500">Sum of all CLOSE rows (strategy + unmatched exchange income)</div>
          {(closeTradesApp.length > 0 || closeTradesLedger.length > 0) && (
            <div className="mt-2 space-y-0.5 border-t border-slate-800 pt-2 text-[11px] text-slate-500">
              <div>
                Strategy / bracket-attributed:{" "}
                <span className={netRealizedPnlStrategy >= 0 ? "text-emerald-400" : "text-rose-400"}>
                  ${netRealizedPnlStrategy.toFixed(2)}
                </span>{" "}
                <span className="text-slate-600">({closeTradesApp.length} CLOSE)</span>
              </div>
              {closeTradesLedger.length > 0 ? (
                <div>
                  Unmatched income ledger:{" "}
                  <span className={netRealizedPnlLedger >= 0 ? "text-emerald-400" : "text-rose-400"}>
                    ${netRealizedPnlLedger.toFixed(2)}
                  </span>{" "}
                  <span className="text-slate-600">({closeTradesLedger.length} CLOSE)</span>
                </div>
              ) : null}
            </div>
          )}
          <div className="mt-2 text-[11px] leading-snug text-slate-500">
            <span className="font-medium text-slate-400">Last 10 min:</span> strategy{" "}
            <span className="text-slate-300">{last10Min.appN}</span> closes ·{" "}
            <span className={last10Min.appPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>${last10Min.appPnl.toFixed(2)}</span>
            {closeTradesLedger.length > 0 || last10Min.ledN > 0 ? (
              <>
                {" "}
                · ledger <span className="text-slate-300">{last10Min.ledN}</span> ·{" "}
                <span className={last10Min.ledPnl >= 0 ? "text-emerald-400" : "text-rose-400"}>
                  ${last10Min.ledPnl.toFixed(2)}
                </span>
              </>
            ) : null}
          </div>
          {showFuturesIncomeLedgerNote ? (
            <div className="mt-1 text-[10px] leading-snug text-slate-500">
              Futures history may include income ledger rows; realized PnL is not one row per round-trip — use strategy
              PnL / filters above.
            </div>
          ) : null}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs">
          <div className="text-slate-400">Winrate</div>
          <div
            className={`mt-1 text-lg font-semibold ${winrate == null ? "text-slate-100" : winrate >= 0.5 ? "text-emerald-400" : "text-rose-400"}`}
          >
            {winrate == null ? "—" : `${(winrate * 100).toFixed(1)}%`}
          </div>
          <div className="mt-1 text-slate-500">
            Wins: <span className="text-slate-300">{wins}</span> · Losses: <span className="text-slate-300">{losses}</span>
            <span className="text-slate-600"> (strategy only)</span>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs">
          <div className="text-slate-400">Recent events</div>
          <div className="mt-1 text-lg font-semibold text-slate-100">{trades.length}</div>
          {mode === "PAPER" && (
            <div className="mt-2">
              <button
                className="w-full rounded-md border border-rose-700/40 bg-rose-950/40 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-950/70"
                onClick={async () => {
                  const ok = window.confirm("Reset simulated account? This deletes snapshot + trades.csv.");
                  if (!ok) return;
                  try {
                    await api.paperReset();
                    pushLog({ level: "warn", msg: "Paper account reset" });
                  } catch {
                    pushLog({ level: "error", msg: "Paper reset failed" });
                  }
                }}
              >
                Reset simulated account
              </button>
            </div>
          )}
        </div>
      </div>

      {bot?.lastTradeBlock ? (
        <div className="mt-3 rounded-lg border border-amber-900/40 bg-amber-950/20 p-3 text-xs">
          <div className="font-semibold text-amber-100/90">Last trade gate</div>
          <div className="mt-1 font-mono text-[11px] text-amber-200/85">
            {String((bot.lastTradeBlock as any).reason || "—")}
            {(bot.lastTradeBlock as any).symbol ? ` · ${(bot.lastTradeBlock as any).symbol}` : ""}
          </div>
          {(bot.lastTradeBlock as any).detail != null && String((bot.lastTradeBlock as any).detail) !== "" ? (
            <div className="mt-1 text-[11px] text-slate-400">{(bot.lastTradeBlock as any).detail}</div>
          ) : null}
          <div className="mt-1 text-[10px] text-slate-500">{(bot.lastTradeBlock as any).ts || ""}</div>
        </div>
      ) : null}

      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <div className="rounded-lg border border-slate-800 bg-slate-950/40">
          <div className="border-b border-slate-800 px-3 py-2 text-xs font-semibold text-slate-200">Positions</div>
          <div className="max-h-[260px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-950">
                <tr className="text-left text-slate-400">
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2">Venue</th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Lev</th>
                  <th className="px-3 py-2">Entry</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">SL</th>
                  <th className="px-3 py-2">TP</th>
                  <th className="px-3 py-2">uPnL</th>
                  <th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-slate-500" colSpan={10}>
                      No open positions
                    </td>
                  </tr>
                ) : (
                  positions.map((p: any) => (
                    <tr key={p.id} className="border-t border-slate-900">
                      <td className="px-3 py-2 text-slate-300">{p.symbol}</td>
                      <td className="px-3 py-2 text-[10px] uppercase text-slate-500">
                        {p.venue === "FUTURES" ? "Fut" : "Spot"}
                      </td>
                      <td className="px-3 py-2 text-slate-300">{p.side}</td>
                      <td className="px-3 py-2 text-amber-300/80">
                        {p.leverage != null && Number(p.leverage) > 0 ? `${Number(p.leverage)}x` : "—"}
                      </td>
                      <td className="px-3 py-2 text-slate-300">{Number(p.entryPrice).toFixed(2)}</td>
                      <td className="px-3 py-2 text-slate-300">{Number(p.qty).toFixed(6)}</td>
                      <td className="px-3 py-2 text-slate-300">{p.stopLoss != null ? Number(p.stopLoss).toFixed(2) : "—"}</td>
                      <td className="px-3 py-2 text-slate-300">
                        {p.takeProfit != null ? Number(p.takeProfit).toFixed(2) : "—"}
                      </td>
                      <td className={`px-3 py-2 ${Number(p.unrealizedPnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                        {p.unrealizedPnl != null ? Number(p.unrealizedPnl).toFixed(2) : "—"}
                      </td>
                      <td className="px-3 py-2">
                        {(() => {
                          const positionSourceHint =
                            p.syncSource === "fapi_v2_account" ? (
                              <span className="text-[11px] text-slate-500" title="Position size from GET /fapi/v2/account">
                                Exchange
                              </span>
                            ) : p.syncSource === "paper_local" ? (
                              <span
                                className="text-[11px] text-amber-200/80"
                                title="Local simulated futures (data/binance-demo-futures). Not an open position on Binance."
                              >
                                Local sim
                              </span>
                            ) : p.venue === "FUTURES" ? (
                              <span className="text-[11px] text-slate-500" title={String(p.syncSource || "futures")}>
                                Futures
                              </span>
                            ) : mode === "PAPER" || mode === "BINANCE_DEMO" ? null : (
                              <span className="text-[11px] text-slate-500">OCO-managed</span>
                            );
                          return (
                            <div className="flex items-center justify-end gap-2">
                              {canManualClosePosition ? (
                                <button
                                  type="button"
                                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-rose-800/55 bg-rose-950/35 text-lg font-light leading-none text-rose-100 hover:bg-rose-950/55"
                                  title="Close position (paper: last candle; futures: market reduce-only)"
                                  aria-label="Close position"
                                  onClick={async () => {
                                    try {
                                      await api.closeTrade(p.id);
                                      pushLog({ level: "info", msg: "Position closed", id: p.id });
                                    } catch (e: unknown) {
                                      pushLog({
                                        level: "error",
                                        msg: `Close failed: ${e instanceof Error ? e.message : String(e)}`,
                                        id: p.id,
                                      });
                                    }
                                  }}
                                >
                                  ×
                                </button>
                              ) : null}
                              {positionSourceHint}
                            </div>
                          );
                        })()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/40">
          <div className="border-b border-slate-800 px-3 py-2">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs font-semibold text-slate-200">Trade history</div>
              <div className="flex flex-wrap items-center gap-1">
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "ALL" ? "border-emerald-600/50 bg-emerald-600/20 text-emerald-200" : "border-slate-700 bg-slate-900/30 text-slate-200 hover:bg-slate-900"
                  }`}
                  onClick={() => setTradeHistoryView("ALL")}
                >
                  All
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "OPEN_ONLY" ? "border-emerald-600/50 bg-emerald-600/20 text-emerald-200" : "border-slate-700 bg-slate-900/30 text-slate-200 hover:bg-slate-900"
                  }`}
                  onClick={() => setTradeHistoryView("OPEN_ONLY")}
                >
                  Open
                </button>
                <button
                  type="button"
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "CLOSED_ONLY" ? "border-emerald-600/50 bg-emerald-600/20 text-emerald-200" : "border-slate-700 bg-slate-900/30 text-slate-200 hover:bg-slate-900"
                  }`}
                  onClick={() => setTradeHistoryView("CLOSED_ONLY")}
                >
                  Closed
                </button>
                <span className="mx-1 hidden text-slate-600 sm:inline">|</span>
                <button
                  type="button"
                  disabled={tradeHistoryView === "OPEN_ONLY"}
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "OPEN_ONLY"
                      ? "cursor-not-allowed border-slate-800 text-slate-600"
                      : closeSourceFilter === "ALL"
                        ? "border-sky-600/50 bg-sky-600/20 text-sky-200"
                        : "border-slate-700 bg-slate-900/30 text-slate-200 hover:bg-slate-900"
                  }`}
                  onClick={() => setCloseSourceFilter("ALL")}
                >
                  Src all
                </button>
                <button
                  type="button"
                  disabled={tradeHistoryView === "OPEN_ONLY"}
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "OPEN_ONLY"
                      ? "cursor-not-allowed border-slate-800 text-slate-600"
                      : closeSourceFilter === "APP"
                        ? "border-sky-600/50 bg-sky-600/20 text-sky-200"
                        : "border-slate-700 bg-slate-900/30 text-slate-200 hover:bg-slate-900"
                  }`}
                  onClick={() => setCloseSourceFilter("APP")}
                  title="Strategy / app closes only"
                >
                  Strategy
                </button>
                <button
                  type="button"
                  disabled={tradeHistoryView === "OPEN_ONLY"}
                  className={`rounded-md border px-2 py-1 text-[11px] font-semibold ${
                    tradeHistoryView === "OPEN_ONLY"
                      ? "cursor-not-allowed border-slate-800 text-slate-600"
                      : closeSourceFilter === "LEDGER"
                        ? "border-sky-600/50 bg-sky-600/20 text-sky-200"
                        : "border-slate-700 bg-slate-900/30 text-slate-200 hover:bg-slate-900"
                  }`}
                  onClick={() => setCloseSourceFilter("LEDGER")}
                  title="Futures income ledger REALIZED_PNL rows"
                >
                  Ledger
                </button>
              </div>
            </div>
          </div>
          <div className="max-h-[260px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-950">
                <tr className="text-left text-slate-400">
                  <th className="px-3 py-2">Type</th>
                  <th className="px-3 py-2">Symbol</th>
                  <th className="px-3 py-2">Side</th>
                  <th className="px-3 py-2">Lev</th>
                  <th className="px-3 py-2">Price</th>
                  <th className="px-3 py-2">Qty</th>
                  <th className="px-3 py-2">SL/TP</th>
                  <th className="px-3 py-2">Src</th>
                  <th className="px-3 py-2">PnL</th>
                </tr>
              </thead>
              <tbody>
                {displayedTrades.length === 0 ? (
                  <tr>
                    <td className="px-3 py-3 text-slate-500" colSpan={9}>
                      No trades yet
                    </td>
                  </tr>
                ) : (
                  displayedTrades.map((t: any, idx) => {
                    const lev = t?.meta?.leverage ?? t?.leverage;
                    const sl = t?.stopLoss;
                    const tp = t?.takeProfit;
                    return (
                      <tr key={idx} className="border-t border-slate-900">
                        <td className="px-3 py-2 text-slate-300">{t.type ?? t.reason ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-300">{t.symbol ?? "—"}</td>
                        <td className="px-3 py-2 text-slate-300">{t.side ?? "—"}</td>
                        <td className="px-3 py-2 text-amber-300/80">
                          {lev != null && Number(lev) > 0 ? `${Number(lev)}x` : "—"}
                        </td>
                        <td className="px-3 py-2 text-slate-300">{t.price != null ? Number(t.price).toFixed(2) : "—"}</td>
                        <td className="px-3 py-2 text-slate-300">{t.qty != null ? Number(t.qty).toFixed(6) : "—"}</td>
                        <td className="px-3 py-2 text-[10px] text-slate-400">
                          {sl != null || tp != null
                            ? `${sl != null ? Number(sl).toFixed(2) : "—"} / ${tp != null ? Number(tp).toFixed(2) : "—"}`
                            : "—"}
                        </td>
                        <td className="px-3 py-2 text-[10px] uppercase text-slate-500">
                          {t.type === "CLOSE" ? (isLedgerClose(t) ? "ledger" : "strat") : t.type === "OPEN" ? "strat" : "—"}
                        </td>
                        <td className={`px-3 py-2 ${Number(t.pnl || 0) >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                          {t.pnl != null ? Number(t.pnl).toFixed(2) : "—"}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

