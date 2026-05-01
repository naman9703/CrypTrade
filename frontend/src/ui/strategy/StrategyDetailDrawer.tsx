import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { useAppStore } from "../../ws/store";
import { tradingModeToApiModeSlug } from "../../lib/tradingModeSlug";
import { EMPTY_STRATEGIES } from "../../lib/stableEmptyArrays";
import type { Strategy, StrategyVersion } from "../../types/strategy";
import type { StrategyPerformance } from "../../types/performance";
import {
  toneClass,
  toneMaxDrawdown,
  toneProfitFactor,
  toneWinRate,
} from "../../lib/performanceMetricsUi";
import { CloneVersionModal } from "./CloneVersionModal";
import { SwitchStrategyModal } from "./SwitchStrategyModal";

function formatAgo(iso: string) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

function capitalSummary(v: StrategyVersion) {
  const mode = v.cfgCapitalMode;
  if (mode === "WALLET_PCT" && v.cfgCapitalPct != null) {
    return `${v.cfgCapitalPct}% wallet`;
  }
  if (v.cfgCapitalFixedUsdt != null && v.cfgCapitalFixedUsdt > 0) {
    return `$${Number(v.cfgCapitalFixedUsdt).toLocaleString()} fixed`;
  }
  return "—";
}

type Props = {
  strategyId: string | null;
  open: boolean;
  onClose: () => void;
  /** Called after set-active so parent can refresh */
  onActivated?: () => void;
};

export function StrategyDetailDrawer({ strategyId, open, onClose, onActivated }: Props) {
  const mode = useAppStore((s) => s.mode);
  const modeSlug = tradingModeToApiModeSlug(mode);
  const runningByMode = useAppStore((s) => s.runningByMode);
  const bot = useAppStore((s) => s.bot);
  const strategies = useAppStore((s) => s.strategiesByMode[modeSlug] ?? EMPTY_STRATEGIES);
  const activeVid = useAppStore((s) => s.activeStrategyVersionByMode[modeSlug]);
  const fetchVersionsForStrategy = useAppStore((s) => s.fetchVersionsForStrategy);
  const versionsByStrategyId = useAppStore((s) => s.versionsByStrategyId);
  const setActiveStrategyVersionForMode = useAppStore((s) => s.setActiveStrategyVersionForMode);
  const saveNewStrategyVersionSnapshot = useAppStore((s) => s.saveNewStrategyVersionSnapshot);
  const cloneStrategyVersionStore = useAppStore((s) => s.cloneStrategyVersionStore);
  const updateStrategyMetaStore = useAppStore((s) => s.updateStrategyMetaStore);
  const fetchStrategiesForMode = useAppStore((s) => s.fetchStrategiesForMode);

  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedVid, setExpandedVid] = useState<string | null>(null);
  const [cloneCtx, setCloneCtx] = useState<{ versionId: string } | null>(null);
  const [switchCtx, setSwitchCtx] = useState<{
    versionId: string;
    label: string;
    currentLabel: string;
  } | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [perfByVid, setPerfByVid] = useState<Record<string, StrategyPerformance>>({});

  const versions = strategyId ? versionsByStrategyId[strategyId] : undefined;

  const running = Boolean(runningByMode?.[String(mode || "").toUpperCase()] ?? bot?.running);

  const load = useCallback(async () => {
    if (!strategyId) return;
    setLoading(true);
    try {
      const { strategy: st } = await api.getStrategyDetail(strategyId);
      setStrategy(st);
      await fetchVersionsForStrategy(strategyId);
      try {
        const pr = await api.getStrategyPerformance(strategyId);
        const m: Record<string, StrategyPerformance> = {};
        for (const row of pr) {
          if (row.metrics) m[row.versionId] = row.metrics;
        }
        setPerfByVid(m);
      } catch {
        setPerfByVid({});
      }
    } catch {
      setStrategy(null);
      setPerfByVid({});
    } finally {
      setLoading(false);
    }
  }, [strategyId, fetchVersionsForStrategy]);

  useEffect(() => {
    if (open && strategyId) void load();
  }, [open, strategyId, load]);

  async function runSetActive(versionId: string, label: string) {
    const go = async () => {
      await setActiveStrategyVersionForMode(modeSlug, versionId);
      await fetchStrategiesForMode(modeSlug);
      onActivated?.();
    };
    if (!running) {
      await go();
      useAppStore.getState().pushLog({
        level: "info",
        msg: `Active strategy set: ${label}`,
        category: "config",
        reason: "strategy_active",
      });
      return;
    }
    const owning = strategies.find((s) => s.latestVersion?.id === activeVid);
    const cur = owning ? `${owning.name} (active)` : "Current strategy";
    setSwitchCtx({ versionId, label, currentLabel: cur });
  }

  async function confirmSwitch() {
    if (!switchCtx) return;
    setSwitchBusy(true);
    try {
      await api.botStop({
        reason: "strategy_switch",
        mode: mode as "PAPER" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_LIVE",
      });
      await setActiveStrategyVersionForMode(modeSlug, switchCtx.versionId);
      await fetchStrategiesForMode(modeSlug);
      onActivated?.();
      setSwitchCtx(null);
      useAppStore.getState().pushLog({
        level: "info",
        msg: `Bot stopped and active strategy set: ${switchCtx.label}`,
        category: "config",
        reason: "strategy_switch",
      });
    } finally {
      setSwitchBusy(false);
    }
  }

  if (!open || !strategyId) return null;

  const latest = strategy?.latestVersion;
  const list: StrategyVersion[] = versions ?? [];

  function perfSummaryEl(versionId: string) {
    const pm = perfByVid[versionId];
    if (!pm || pm.totalTrades <= 0) {
      return <p className="mt-1 text-[10px] text-slate-500">No closed trades yet</p>;
    }
    const pnlStr =
      pm.totalPnlUsdt >= 0
        ? `+$${Math.abs(pm.totalPnlUsdt).toFixed(pm.totalPnlUsdt >= 100 ? 0 : 2)}`
        : `−$${Math.abs(pm.totalPnlUsdt).toFixed(2)}`;
    const pfStr =
      pm.profitFactor != null && Number.isFinite(pm.profitFactor) ? pm.profitFactor.toFixed(1) : "—";
    const ddStr =
      pm.maxDrawdownPct != null && Number.isFinite(pm.maxDrawdownPct) ? `${pm.maxDrawdownPct.toFixed(1)}%` : "—";
    return (
      <p className="mt-1 text-[10px] leading-relaxed text-slate-600 dark:text-slate-400">
        <span className={toneClass(toneWinRate(pm.winRatePct))}>W:{pm.winRatePct.toFixed(0)}%</span>
        <span className="text-slate-400"> · </span>
        <span
          className={
            pm.totalPnlUsdt >= 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
          }
        >
          PnL:{pnlStr}
        </span>
        <span className="text-slate-400"> · </span>
        <span className={toneClass(toneProfitFactor(pm.profitFactor))}>PF:{pfStr}</span>
        <span className="text-slate-400"> · </span>
        <span className={toneClass(toneMaxDrawdown(pm.maxDrawdownPct))}>DD:{ddStr}</span>
      </p>
    );
  }

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/40" aria-hidden onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-[75] flex w-full max-w-lg flex-col border-l border-slate-200 bg-slate-50 shadow-2xl dark:border-slate-700 dark:bg-slate-950">
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <button
            type="button"
            className="text-sm text-sky-600 dark:text-sky-400"
            onClick={onClose}
          >
            ← Back
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {loading ? "…" : strategy?.name ?? "Strategy"}
            </h2>
            <p className="text-[10px] text-slate-500">
              {strategy?.modeSlug?.toUpperCase()}{" "}
              {strategy?.tags?.length ? `· ${strategy.tags.join(", ")}` : ""}
            </p>
          </div>
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px] text-slate-600 dark:text-slate-400"
            onClick={() => {
              const n = window.prompt("Strategy name", strategy?.name ?? "");
              if (n == null || !strategyId) return;
              void updateStrategyMetaStore(strategyId, { name: n.trim() || strategy?.name }).then(() => load());
            }}
          >
            Edit
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {latest ? (
            <section className="mb-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Active version</h3>
              <div
                className={`rounded-lg border p-3 ${
                  activeVid === latest.id
                    ? "border-sky-500 bg-sky-50/80 dark:border-sky-600 dark:bg-sky-950/40"
                    : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                }`}
              >
                <p className="text-sm font-medium text-slate-800 dark:text-slate-100">
                  {latest.label ?? `v${latest.versionNumber}`}
                </p>
                <p className="text-[11px] text-slate-500">{formatAgo(latest.createdAt)}</p>
                <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">
                  {latest.cfgSymbol ?? "—"} · {latest.cfgTimeframe ?? "—"} · {latest.cfgMarketMode ?? "—"}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  ST: {latest.cfgStPeriod ?? "—"} × {latest.cfgStMultiplier ?? "—"} · Cap: {capitalSummary(latest)}
                </p>
                <p className="text-xs text-slate-600 dark:text-slate-300">
                  Trailing: {latest.cfgTrailingMode ?? "—"}
                </p>
                {perfSummaryEl(latest.id)}
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="rounded-md border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-600"
                    onClick={() => setCloneCtx({ versionId: latest.id })}
                  >
                    Clone
                  </button>
                  <button
                    type="button"
                    className="rounded-md bg-sky-600 px-2 py-1 text-[11px] font-semibold text-white"
                    onClick={() =>
                      void runSetActive(
                        latest.id,
                        `${strategy?.name ?? "Strategy"} v${latest.versionNumber}`,
                      )
                    }
                  >
                    Set active
                  </button>
                </div>
              </div>
            </section>
          ) : null}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Version history</h3>
              <button
                type="button"
                className="text-[11px] text-sky-600 dark:text-sky-400"
                onClick={() => {
                  if (!strategyId) return;
                  void saveNewStrategyVersionSnapshot(strategyId, "Manual save").then(() => load());
                }}
              >
                Save snapshot
              </button>
            </div>
            <ul className="space-y-2">
              {list
                .slice()
                .reverse()
                .map((v) => (
                  <li
                    key={v.id}
                    className={`rounded-lg border p-2 text-xs ${
                      activeVid === v.id
                        ? "border-sky-500 bg-sky-50/50 dark:border-sky-600 dark:bg-sky-950/30"
                        : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-1">
                      <span className="font-semibold">
                        v{v.versionNumber}{" "}
                        <span className="font-normal text-slate-600 dark:text-slate-400">
                          {v.label ?? ""}
                        </span>
                      </span>
                      <span className="text-[10px] text-slate-500">{formatAgo(v.createdAt)}</span>
                    </div>
                    <p className="text-[10px] text-slate-500">
                      {v.cfgSymbol} · {v.cfgTimeframe} · ST {v.cfgStPeriod}×{v.cfgStMultiplier}
                    </p>
                    {perfSummaryEl(v.id)}
                    <div className="mt-2 flex flex-wrap gap-1">
                      <button
                        type="button"
                        className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] dark:border-slate-600"
                        onClick={() => setExpandedVid((x) => (x === v.id ? null : v.id))}
                      >
                        {expandedVid === v.id ? "Hide" : "View JSON"}
                      </button>
                      <button
                        type="button"
                        className="rounded border border-slate-200 px-1.5 py-0.5 text-[10px] dark:border-slate-600"
                        onClick={() => setCloneCtx({ versionId: v.id })}
                      >
                        Clone
                      </button>
                      <button
                        type="button"
                        className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-white dark:bg-slate-200 dark:text-slate-900"
                        onClick={() =>
                          void runSetActive(v.id, `${strategy?.name ?? "Strategy"} v${v.versionNumber}`)
                        }
                      >
                        Set active
                      </button>
                    </div>
                    {expandedVid === v.id ? (
                      <pre className="mt-2 max-h-48 overflow-auto rounded bg-slate-100 p-2 text-[10px] dark:bg-slate-950">
                        {JSON.stringify(v.cfgRaw, null, 2)}
                      </pre>
                    ) : null}
                  </li>
                ))}
            </ul>
          </section>
        </div>
      </div>

      <CloneVersionModal
        open={cloneCtx != null}
        onClose={() => setCloneCtx(null)}
        strategies={strategies}
        defaultTargetStrategyId={strategyId}
        onClone={async (targetStrategyId, label) => {
          if (!cloneCtx || !strategyId) return;
          await cloneStrategyVersionStore(strategyId, cloneCtx.versionId, {
            targetStrategyId: targetStrategyId !== strategyId ? targetStrategyId : undefined,
            label: label || undefined,
          });
          await load();
          setCloneCtx(null);
        }}
      />

      <SwitchStrategyModal
        open={switchCtx != null}
        onClose={() => !switchBusy && setSwitchCtx(null)}
        onConfirm={confirmSwitch}
        busy={switchBusy}
        currentLabel={switchCtx?.currentLabel ?? ""}
        targetLabel={switchCtx?.label ?? ""}
      />
    </>
  );
}
