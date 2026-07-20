import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { clsx } from "clsx";
import type { ApiTradingModeSlug } from "../../lib/tradingModeSlug";
import { apiModeSlugToModeLabel } from "../../lib/tradingModeSlug";
import type { BotInstance } from "../../types/instance";
import type { StrategyVersion } from "../../types/strategy";
import type { Account } from "../../types/accounts";
import type { Trade, TradeFill } from "../../types/trade";
import { api } from "../../api/client";
import { useAppStore } from "../../ws/store";
import {
  effectiveInstanceRiskLabel,
  effectiveInstanceSymbol,
  effectiveInstanceTimeframe,
} from "../../lib/backtestInstanceConfig";
import {
  strategyVersionStLine,
  strategyVersionTrailingLabel,
} from "../../lib/strategyVersionDisplay";
import { ApiKeyModal } from "../accounts/ApiKeyModal";

const TRADE_PAGE = 20;

function fmtPx(n: number | null) {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: 8 })}`;
}

function sortTradesForDisplay(list: Trade[]): Trade[] {
  return [...list].sort((a, b) => {
    const st = (s: string) => String(s).toLowerCase();
    const ao = st(a.status) === "open" || st(a.status) === "pending" ? 0 : 1;
    const bo = st(b.status) === "open" || st(b.status) === "pending" ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const ta = new Date(a.openedAt ?? a.createdAt ?? 0).getTime();
    const tb = new Date(b.openedAt ?? b.createdAt ?? 0).getTime();
    return tb - ta;
  });
}

function fmtUsd(n: number) {
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
}

function relTime(iso: string | null) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

type Props = {
  modeSlug: ApiTradingModeSlug;
  instance: BotInstance;
  version: StrategyVersion | null;
  onEditLabel: () => void;
  onDelete: () => void;
  onRefresh: () => void;
};

export function InstanceTabContent({
  modeSlug,
  instance,
  version,
  onEditLabel,
  onDelete,
  onRefresh,
}: Props) {
  const mode = useAppStore((s) => s.mode);
  const runningByMode = useAppStore((s) => s.runningByMode);
  const pushLog = useAppStore((s) => s.pushLog);
  const fetchAccountsForMode = useAppStore((s) => s.fetchAccountsForMode);
  const fetchTradesForInstance = useAppStore((s) => s.fetchTradesForInstance);
  const tradesForInstance = useAppStore((s) => s.tradesByInstance[instance.id]);
  const tradesLoading = useAppStore((s) => s.tradesLoadingByInstance[instance.id] === true);
  const [log, setLog] = useState<Awaited<ReturnType<typeof api.getInstanceStatusLog>>>([]);
  const [credsOpen, setCredsOpen] = useState(false);
  const [credsAccount, setCredsAccount] = useState<Account | null>(null);
  const [tradeExpandId, setTradeExpandId] = useState<string | null>(null);
  const [tradeDetailById, setTradeDetailById] = useState<Record<string, Trade>>({});
  const [tradeDetailLoadingId, setTradeDetailLoadingId] = useState<string | null>(null);
  const [tradesCanLoadMore, setTradesCanLoadMore] = useState(true);

  const sortedTrades = useMemo(() => sortTradesForDisplay(tradesForInstance ?? []), [tradesForInstance]);

  const loadLog = useCallback(async () => {
    try {
      const entries = await api.getInstanceStatusLog(instance.id, 10);
      setLog(entries);
    } catch {
      setLog([]);
    }
  }, [instance.id]);

  useEffect(() => {
    void loadLog();
  }, [loadLog, instance.status, instance.updatedAt]);

  useEffect(() => {
    setTradeExpandId(null);
    setTradesCanLoadMore(true);
    void (async () => {
      const n = await fetchTradesForInstance(instance.id, { limit: TRADE_PAGE, append: false });
      setTradesCanLoadMore(n >= TRADE_PAGE);
    })();
  }, [instance.id, instance.totalTrades, fetchTradesForInstance]);

  async function onLoadMoreTrades() {
    const n = await fetchTradesForInstance(instance.id, { limit: TRADE_PAGE, append: true });
    if (n < TRADE_PAGE) setTradesCanLoadMore(false);
  }

  async function onToggleTradeRow(t: Trade) {
    const tradeId = t.id;
    if (tradeExpandId === tradeId) {
      setTradeExpandId(null);
      return;
    }
    setTradeExpandId(tradeId);
    if ((tradeDetailById[tradeId]?.fills?.length ?? 0) > 0) return;
    if ((t.fills?.length ?? 0) > 0) {
      setTradeDetailById((m) => ({ ...m, [tradeId]: { ...t, fills: t.fills } }));
      return;
    }
    setTradeDetailLoadingId(tradeId);
    try {
      const detail = await api.getTradeDetail(tradeId);
      if (detail) {
        setTradeDetailById((m) => ({ ...m, [tradeId]: detail }));
      }
    } catch {
      pushLog({ level: "warn", msg: "Could not load trade detail" });
    } finally {
      setTradeDetailLoadingId((cur) => (cur === tradeId ? null : cur));
    }
  }

  const tm = String(mode || "PAPER").toUpperCase() as
    | "PAPER"
    | "BINANCE_DEMO_API"
    | "BINANCE_TESTNET"
    | "BINANCE_LIVE";
  const engineRunning = Boolean(runningByMode?.[tm]);
  const st = String(instance.status).toLowerCase();
  const isError = st === "error";
  const isPaused = st === "paused";

  async function mergeBotFromApi(botNext: unknown, extra?: { runningByMode?: Record<string, boolean> }) {
    useAppStore.setState((s) => ({
      bot: botNext && typeof botNext === "object" ? { ...(s.bot as object), ...(botNext as object) } : s.bot,
      ...(extra?.runningByMode ? { runningByMode: extra.runningByMode } : {}),
    }));
  }

  async function onStartStop() {
    try {
      if (engineRunning) {
        const out = await api.botStop({ reason: "instances_panel", mode: tm });
        await mergeBotFromApi(out?.bot, { runningByMode: out?.runningByMode });
      } else {
        const out = await api.botStart({ reason: "instances_panel", mode: tm });
        await mergeBotFromApi(out?.bot, { runningByMode: out?.runningByMode });
      }
      void loadLog();
      onRefresh();
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e);
      pushLog({ level: "error", msg: `Failed to start/stop bot: ${detail}` });
    }
  }

  async function onClearError() {
    try {
      await api.clearInstanceError(instance.id);
      onRefresh();
      void loadLog();
    } catch {
      pushLog({ level: "error", msg: "Failed to clear error" });
    }
  }

  async function onPause() {
    try {
      const out = await api.pauseInstance(instance.id);
      if (out.bot && typeof out.bot === "object") {
        await mergeBotFromApi(out.bot);
      }
      onRefresh();
      void loadLog();
    } catch {
      pushLog({ level: "error", msg: "Failed to pause instance" });
    }
  }

  async function onResume() {
    try {
      const out = await api.resumeInstance(instance.id);
      if (out.bot && typeof out.bot === "object") {
        await mergeBotFromApi(out.bot);
      }
      onRefresh();
      void loadLog();
    } catch {
      pushLog({ level: "error", msg: "Failed to resume instance" });
    }
  }

  async function onOpenCredentials() {
    try {
      await fetchAccountsForMode(modeSlug);
      const acc =
        useAppStore.getState().accounts.find((a) => String(a.id) === String(instance.accountId)) ?? null;
      if (!acc) {
        pushLog({ level: "warn", msg: "Account not loaded — open Accounts and refresh, then try again" });
        return;
      }
      setCredsAccount(acc);
      setCredsOpen(true);
    } catch {
      pushLog({ level: "error", msg: "Failed to open credentials" });
    }
  }

  const allot = instance.allotment;
  const displaySymbol = effectiveInstanceSymbol(instance, version);
  const displayTf = effectiveInstanceTimeframe(instance, version);
  const displayRisk = effectiveInstanceRiskLabel(instance, version);
  const displaySt = strategyVersionStLine(version);
  const displayTrail = strategyVersionTrailingLabel(version);
  const reservedPct =
    allot && allot.configuredUsdt > 0 ? Math.min(100, (allot.reservedUsdt / allot.configuredUsdt) * 100) : 0;
  const pnl = instance.totalPnlUsdt;

  return (
    <div className="space-y-4 p-3 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
              {instance.label || "Untitled instance"}
            </h3>
            <span
              className={clsx(
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase",
                st === "running" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                st === "paused" && "bg-amber-500/15 text-amber-800 dark:text-amber-200",
                st === "stopped" && "bg-slate-500/15 text-slate-600 dark:text-slate-400",
                isError && "bg-rose-500/15 text-rose-700 dark:text-rose-300",
              )}
            >
              {st}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-600 dark:text-slate-400">
            {instance.strategyName ?? "Strategy"} {instance.strategyVersionLabel ? `— ${instance.strategyVersionLabel}` : instance.strategyVersionNumber != null ? `— v${instance.strategyVersionNumber}` : ""}{" "}
            · {instance.accountLabel ?? "Account"} · {apiModeSlugToModeLabel(modeSlug)}
          </p>
        </div>
      </div>

      {isError ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50/90 p-3 text-xs dark:border-amber-900/50 dark:bg-amber-950/35">
          <div className="font-semibold text-amber-900 dark:text-amber-200">Last error</div>
          <p className="mt-1 whitespace-pre-wrap text-amber-950 dark:text-amber-50">
            {instance.errorMessage ?? "—"}
          </p>
          <p className="mt-2 text-amber-800/90 dark:text-amber-200/90">
            Check your API credentials before restarting.
            {instance.updatedAt ? ` Occurred ${relTime(instance.updatedAt)}.` : ""}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-lg bg-amber-500/90 px-3 py-1.5 text-xs font-medium text-amber-950"
              onClick={() => void onClearError()}
            >
              Clear error
            </button>
            <button
              type="button"
              className="rounded-lg border border-amber-700/40 px-3 py-1.5 text-xs font-medium text-amber-950 dark:border-amber-500/50 dark:text-amber-100"
              onClick={() => void onOpenCredentials()}
            >
              Check credentials
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2 dark:border-slate-700 dark:bg-slate-900/40">
          <div className="text-[10px] font-medium uppercase text-slate-500">Capital</div>
          <div className="font-mono text-slate-900 dark:text-slate-100">
            {allot ? fmtUsd(allot.configuredUsdt) : "—"}
          </div>
          <div className="text-[10px] text-slate-500">{allot?.allotmentMode === "PCT" ? "% of wallet" : "Fixed"}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2 dark:border-slate-700 dark:bg-slate-900/40">
          <div className="text-[10px] font-medium uppercase text-slate-500">Reserved</div>
          <div className="font-mono text-slate-900 dark:text-slate-100">
            {allot ? fmtUsd(allot.reservedUsdt) : "—"}
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded bg-slate-200 dark:bg-slate-700">
            <div className="h-full bg-sky-500 transition-all" style={{ width: `${reservedPct}%` }} />
          </div>
          <div className="text-[10px] text-slate-500">{reservedPct.toFixed(0)}% of cap</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2 dark:border-slate-700 dark:bg-slate-900/40">
          <div className="text-[10px] font-medium uppercase text-slate-500">Realised PnL</div>
          <div
            className={clsx(
              "font-mono",
              pnl > 0 && "text-emerald-600 dark:text-emerald-400",
              pnl < 0 && "text-rose-600 dark:text-rose-400",
              pnl === 0 && "text-slate-900 dark:text-slate-100",
            )}
          >
            {pnl >= 0 ? "+" : ""}
            {fmtUsd(pnl)}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-50/80 p-2 dark:border-slate-700 dark:bg-slate-900/40">
          <div className="text-[10px] font-medium uppercase text-slate-500">Trades</div>
          <div className="font-mono text-slate-900 dark:text-slate-100">{instance.totalTrades}</div>
          <div className="text-[10px] text-slate-500">total</div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-700 dark:bg-slate-950/40">
        <h4 className="mb-2 text-xs font-semibold uppercase text-slate-500">Config</h4>
        <dl className="grid gap-1 text-xs sm:grid-cols-2">
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Strategy</dt>
            <dd className="text-right text-slate-800 dark:text-slate-200">
              {instance.strategyName ?? "—"}{" "}
              {instance.strategyVersionNumber != null ? `— v${instance.strategyVersionNumber}` : ""}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Symbol</dt>
            <dd className="text-right font-mono text-slate-800 dark:text-slate-200">
              {displaySymbol} · {displayTf}
            </dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Risk / trade</dt>
            <dd className="text-right font-mono text-slate-800 dark:text-slate-200">{displayRisk}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Supertrend</dt>
            <dd className="text-right text-slate-800 dark:text-slate-200">{displaySt}</dd>
          </div>
          <div className="flex justify-between gap-2">
            <dt className="text-slate-500">Trailing</dt>
            <dd className="text-right text-slate-800 dark:text-slate-200">{displayTrail}</dd>
          </div>
          <div className="flex justify-between gap-2 sm:col-span-2">
            <dt className="text-slate-500">Started / stopped</dt>
            <dd className="text-right text-slate-800 dark:text-slate-200">
              {instance.lastStartAt ? `Started ${relTime(instance.lastStartAt)}` : "—"}
              {instance.lastStopAt ? ` · Stopped ${relTime(instance.lastStopAt)}` : ""}
            </dd>
          </div>
        </dl>
      </div>

      <div>
        <h4 className="mb-1 text-xs font-semibold uppercase text-slate-500">Status log</h4>
        <ul className="max-h-40 space-y-1 overflow-y-auto text-xs">
          {log.map((row) => (
            <li key={row.id} className="flex flex-wrap gap-2 border-b border-slate-100 py-1 dark:border-slate-800">
              <span
                className={clsx(
                  "font-medium",
                  row.toStatus === "running" && "text-emerald-600",
                  row.toStatus === "paused" && "text-amber-600",
                  row.toStatus === "stopped" && "text-slate-500",
                  row.toStatus === "error" && "text-rose-600",
                )}
              >
                {row.toStatus}
              </span>
              <span className="text-slate-600 dark:text-slate-400">{row.reason ?? "—"}</span>
              <span className="ml-auto text-slate-400">{relTime(row.createdAt)}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-950/40">
        <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-slate-800">
          <h4 className="text-xs font-semibold uppercase text-slate-500">Trade history</h4>
          {tradesCanLoadMore ? (
            <button
              type="button"
              className="text-[11px] font-medium text-sky-600 hover:underline disabled:opacity-50 dark:text-sky-400"
              disabled={tradesLoading}
              onClick={() => void onLoadMoreTrades()}
            >
              Load more
            </button>
          ) : null}
        </div>
        {sortedTrades.length === 0 && !tradesLoading ? (
          <p className="p-3 text-xs text-slate-500">No trades in the log yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-[10px] uppercase text-slate-500 dark:border-slate-800">
                  <th className="px-2 py-2 font-medium">#</th>
                  <th className="px-2 py-2 font-medium">Symbol</th>
                  <th className="px-2 py-2 font-medium">Dir</th>
                  <th className="px-2 py-2 font-medium">Entry</th>
                  <th className="px-2 py-2 font-medium">Exit</th>
                  <th className="px-2 py-2 font-medium text-right">Net PnL</th>
                </tr>
              </thead>
              <tbody>
                {sortedTrades.map((t, idx) => {
                  const st = String(t.status).toLowerCase();
                  const isOpen = st === "open" || st === "pending";
                  const dir = String(t.direction).toUpperCase();
                  const long = dir === "LONG" || dir === "BUY";
                  const net = t.netPnl;
                  const closed = st === "closed";
                  const expanded = tradeExpandId === t.id;
                  const detail = tradeDetailById[t.id];
                  const fills: TradeFill[] = detail?.fills?.length ? detail.fills : t.fills ?? [];
                  return (
                    <Fragment key={t.id}>
                      <tr
                        className={clsx(
                          "cursor-pointer border-b border-slate-50 hover:bg-slate-50/90 dark:border-slate-800/80 dark:hover:bg-slate-900/50",
                          expanded && "bg-slate-50 dark:bg-slate-900/40",
                        )}
                        onClick={() => void onToggleTradeRow(t)}
                      >
                        <td className="px-2 py-2 font-mono text-slate-600 dark:text-slate-400">
                          <span className="inline-flex items-center gap-1.5">
                            {isOpen ? (
                              <span
                                className="inline-block h-2 w-2 shrink-0 rounded-full bg-sky-500 motion-safe:animate-pulse"
                                title="Open"
                              />
                            ) : null}
                            {sortedTrades.length - idx}
                          </span>
                        </td>
                        <td className="px-2 py-2 font-mono text-slate-800 dark:text-slate-200">{t.symbol}</td>
                        <td className="px-2 py-2">
                          <span
                            className={clsx(
                              "inline-flex items-center gap-0.5 font-medium",
                              long ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400",
                            )}
                          >
                            {long ? "▲" : "▼"} {long ? "LONG" : "SHORT"}
                          </span>
                        </td>
                        <td className="px-2 py-2 font-mono text-slate-700 dark:text-slate-300">{fmtPx(t.entryPrice)}</td>
                        <td className="px-2 py-2 font-mono text-slate-700 dark:text-slate-300">
                          {isOpen ? "—" : fmtPx(t.exitPrice)}
                        </td>
                        <td
                          className={clsx(
                            "px-2 py-2 text-right font-mono font-medium",
                            !closed || net == null || !Number.isFinite(net)
                              ? "text-slate-500"
                              : net > 0
                                ? "text-emerald-600 dark:text-emerald-400"
                                : net < 0
                                  ? "text-rose-600 dark:text-rose-400"
                                  : "text-slate-700 dark:text-slate-300",
                          )}
                        >
                          {closed && net != null && Number.isFinite(net) ? (
                            <>
                              {net >= 0 ? "+" : ""}
                              {fmtUsd(net)} {net >= 0 ? "✓" : "✗"}
                            </>
                          ) : isOpen ? (
                            "—"
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                      {expanded ? (
                        <tr className="border-b border-slate-100 bg-slate-50/50 dark:border-slate-800 dark:bg-slate-900/30">
                          <td colSpan={6} className="px-3 py-2">
                            {tradeDetailLoadingId === t.id ? (
                              <p className="text-slate-500">Loading fills…</p>
                            ) : (
                              <div className="space-y-2 text-[11px]">
                                <dl className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                                  <div className="flex justify-between gap-2">
                                    <dt className="text-slate-500">Status</dt>
                                    <dd className="font-medium text-slate-800 dark:text-slate-200">{t.status}</dd>
                                  </div>
                                  <div className="flex justify-between gap-2">
                                    <dt className="text-slate-500">Market</dt>
                                    <dd className="text-slate-800 dark:text-slate-200">{t.marketType}</dd>
                                  </div>
                                  <div className="flex justify-between gap-2">
                                    <dt className="text-slate-500">Leverage</dt>
                                    <dd className="font-mono text-slate-800 dark:text-slate-200">
                                      {t.leverage != null ? `${t.leverage}×` : "—"}
                                    </dd>
                                  </div>
                                  <div className="flex justify-between gap-2">
                                    <dt className="text-slate-500">Gross PnL</dt>
                                    <dd className="font-mono text-slate-800 dark:text-slate-200">
                                      {t.grossPnl != null && Number.isFinite(t.grossPnl) ? fmtUsd(t.grossPnl) : "—"}
                                    </dd>
                                  </div>
                                  <div className="flex justify-between gap-2">
                                    <dt className="text-slate-500">Fees</dt>
                                    <dd className="font-mono text-slate-800 dark:text-slate-200">
                                      {t.feesUsdt != null && Number.isFinite(t.feesUsdt) ? fmtUsd(t.feesUsdt) : "—"}
                                    </dd>
                                  </div>
                                  <div className="flex justify-between gap-2">
                                    <dt className="text-slate-500">ROI</dt>
                                    <dd className="font-mono text-slate-800 dark:text-slate-200">
                                      {t.roiPct != null && Number.isFinite(t.roiPct) ? `${t.roiPct.toFixed(2)}%` : "—"}
                                    </dd>
                                  </div>
                                  <div className="flex justify-between gap-2 sm:col-span-2">
                                    <dt className="text-slate-500">Exit reason</dt>
                                    <dd className="text-right text-slate-800 dark:text-slate-200">{t.exitReason ?? "—"}</dd>
                                  </div>
                                  <div className="flex justify-between gap-2 sm:col-span-2">
                                    <dt className="text-slate-500">Opened / closed</dt>
                                    <dd className="text-right text-slate-600 dark:text-slate-400">
                                      {t.openedAt ?? "—"}
                                      {t.closedAt ? ` → ${t.closedAt}` : ""}
                                    </dd>
                                  </div>
                                </dl>
                                {fills.length ? (
                                  <div>
                                    <div className="mb-1 font-semibold text-slate-600 dark:text-slate-400">Fills</div>
                                    <table className="w-full border border-slate-200 text-[10px] dark:border-slate-700">
                                      <thead className="bg-slate-100 dark:bg-slate-800/80">
                                        <tr>
                                          <th className="px-1.5 py-1 text-left font-medium">Type</th>
                                          <th className="px-1.5 py-1 text-left font-medium">Side</th>
                                          <th className="px-1.5 py-1 text-right font-medium">Price</th>
                                          <th className="px-1.5 py-1 text-right font-medium">Qty</th>
                                          <th className="px-1.5 py-1 text-right font-medium">Fee</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {fills.map((f) => (
                                          <tr key={f.id} className="border-t border-slate-200 dark:border-slate-700">
                                            <td className="px-1.5 py-1">{f.fillType}</td>
                                            <td className="px-1.5 py-1">{f.side}</td>
                                            <td className="px-1.5 py-1 text-right font-mono">{fmtPx(f.price)}</td>
                                            <td className="px-1.5 py-1 text-right font-mono">{f.quantity}</td>
                                            <td className="px-1.5 py-1 text-right font-mono">
                                              {f.feeUsdt != null ? fmtUsd(f.feeUsdt) : f.feeAmount ?? "—"}
                                            </td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>
                                ) : (
                                  <p className="text-slate-500">No fills recorded for this trade.</p>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            {tradesLoading ? (
              <p className="border-t border-slate-100 px-3 py-2 text-[11px] text-slate-500 dark:border-slate-800">
                Loading trades…
              </p>
            ) : null}
          </div>
        )}
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-3 dark:border-slate-700">
        <button
          type="button"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs dark:border-slate-600"
          onClick={onEditLabel}
        >
          Edit label
        </button>
        {engineRunning && !isError && !isPaused ? (
          <button
            type="button"
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-medium text-amber-950"
            onClick={() => void onPause()}
          >
            Pause
          </button>
        ) : null}
        {engineRunning && isPaused ? (
          <button
            type="button"
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white"
            onClick={() => void onResume()}
          >
            Resume
          </button>
        ) : null}
        <button
          type="button"
          className={clsx(
            "rounded-lg px-3 py-1.5 text-xs font-medium text-white",
            engineRunning ? "bg-rose-600" : "bg-emerald-600",
          )}
          onClick={() => void onStartStop()}
        >
          {engineRunning ? "Stop bot" : "Start bot"}
        </button>
        <button
          type="button"
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs dark:border-slate-600"
          onClick={onDelete}
          title={engineRunning ? "Stop bot first" : undefined}
        >
          Delete
        </button>
      </div>

      <ApiKeyModal
        open={credsOpen}
        account={credsAccount}
        onClose={() => {
          setCredsOpen(false);
          setCredsAccount(null);
        }}
        onSaved={() => {
          setCredsOpen(false);
          setCredsAccount(null);
          onRefresh();
        }}
      />
    </div>
  );
}
