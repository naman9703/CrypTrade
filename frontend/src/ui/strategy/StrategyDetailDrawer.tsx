import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { useAppStore } from "../../ws/store";
import { tradingModeToApiModeSlug } from "../../lib/tradingModeSlug";
import { EMPTY_BOT_INSTANCES, EMPTY_STRATEGIES } from "../../lib/stableEmptyArrays";
import { isStrategyInUseForInstance } from "../../lib/strategyInUse";
import { renameStrategyWithGuard } from "../../lib/strategyInstanceBind";
import { buildStrategyVersionConfigSections } from "../../lib/strategyVersionFullConfig";
import { strategyVersionBadgeLabels, pickBotFromStrategyVersion } from "../../lib/strategyVersionDisplay";
import { strategyTypeLabel } from "../../lib/strategyConfigProfile";
import type { Strategy } from "../../types/strategy";
import type { StrategyPerformance } from "../../types/performance";
import {
  toneClass,
  toneMaxDrawdown,
  toneProfitFactor,
  toneWinRate,
} from "../../lib/performanceMetricsUi";
import { CloneStrategyModal } from "./CloneStrategyModal";
import { StrategyConfigDetail } from "./StrategyConfigDetail";
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

type Props = {
  strategyId: string | null;
  open: boolean;
  onClose: () => void;
  onActivated?: () => void;
};

export function StrategyDetailDrawer({ strategyId, open, onClose, onActivated }: Props) {
  const mode = useAppStore((s) => s.mode);
  const modeSlug = tradingModeToApiModeSlug(mode);
  const runningByMode = useAppStore((s) => s.runningByMode);
  const bot = useAppStore((s) => s.bot);
  const strategies = useAppStore((s) => s.strategiesByMode[modeSlug] ?? EMPTY_STRATEGIES);
  const instances = useAppStore((s) => s.instancesByMode[modeSlug] ?? EMPTY_BOT_INSTANCES);
  const activeInstanceId = useAppStore((s) => s.activeInstanceByMode[modeSlug]);
  const bindInstanceStrategyStore = useAppStore((s) => s.bindInstanceStrategyStore);
  const cloneStrategyAsNewStore = useAppStore((s) => s.cloneStrategyAsNewStore);
  const fetchStrategiesForMode = useAppStore((s) => s.fetchStrategiesForMode);
  const fetchInstancesForMode = useAppStore((s) => s.fetchInstancesForMode);
  const pushLog = useAppStore((s) => s.pushLog);

  const [strategy, setStrategy] = useState<Strategy | null>(null);
  const [loading, setLoading] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [switchCtx, setSwitchCtx] = useState<{
    strategyId: string;
    label: string;
    currentLabel: string;
  } | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [perf, setPerf] = useState<StrategyPerformance | null>(null);

  const running = Boolean(runningByMode?.[String(mode || "").toUpperCase()] ?? bot?.running);

  const load = useCallback(async () => {
    if (!strategyId) return;
    setLoading(true);
    try {
      const { strategy: st } = await api.getStrategyDetail(strategyId);
      setStrategy(st);
      try {
        const pr = await api.getStrategyPerformance(strategyId);
        const vid = st.latestVersion?.id;
        const row = vid ? pr.find((r) => r.versionId === vid) : pr[0];
        setPerf(row?.metrics ?? null);
      } catch {
        setPerf(null);
      }
    } catch (e) {
      setStrategy(null);
      setPerf(null);
      pushLog({
        level: "error",
        msg: `Could not load strategy: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setLoading(false);
    }
  }, [strategyId, pushLog]);

  useEffect(() => {
    if (open && strategyId) void load();
  }, [open, strategyId, load]);

  const latest = strategy?.latestVersion;
  const strategyType = latest
    ? strategyTypeLabel(String(pickBotFromStrategyVersion(latest).manualStrategy ?? ""))
    : null;
  const inUse = strategyId
    ? isStrategyInUseForInstance(strategyId, instances, activeInstanceId)
    : false;
  const configSections = useMemo(
    () => (latest ? buildStrategyVersionConfigSections(latest) : []),
    [latest],
  );

  async function runSetActiveForInstance() {
    if (!strategyId || !strategy) return;
    if (!activeInstanceId) {
      pushLog({ level: "warn", msg: "Select an instance tab first, then Set active." });
      return;
    }
    const label = strategy.name;
    const go = async () => {
      await bindInstanceStrategyStore(activeInstanceId, strategyId);
      await fetchStrategiesForMode(modeSlug);
      await fetchInstancesForMode(modeSlug);
      onActivated?.();
      pushLog({
        level: "info",
        msg: `Instance now uses strategy: ${label}`,
        category: "config",
        reason: "strategy_instance_bind",
      });
    };
    if (!running) {
      try {
        await go();
      } catch (e) {
        pushLog({
          level: "error",
          msg: `Set active failed: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
      return;
    }
    const cur = strategies.find((s) => isStrategyInUseForInstance(s.id, instances, activeInstanceId));
    setSwitchCtx({
      strategyId,
      label,
      currentLabel: cur?.name ? `${cur.name} (in use)` : "Current strategy",
    });
  }

  async function confirmSwitch() {
    if (!switchCtx || !activeInstanceId) return;
    setSwitchBusy(true);
    try {
      await api.botStop({
        reason: "strategy_switch",
        mode: mode as "PAPER" | "BINANCE_DEMO_API" | "BINANCE_TESTNET" | "BINANCE_LIVE",
      });
      await bindInstanceStrategyStore(activeInstanceId, switchCtx.strategyId);
      await fetchStrategiesForMode(modeSlug);
      await fetchInstancesForMode(modeSlug);
      onActivated?.();
      pushLog({
        level: "info",
        msg: `Bot stopped — instance now uses: ${switchCtx.label}`,
        category: "config",
        reason: "strategy_switch",
      });
      setSwitchCtx(null);
    } catch (e) {
      pushLog({
        level: "error",
        msg: `Strategy switch failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setSwitchBusy(false);
    }
  }

  if (!open || !strategyId) return null;

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/40" aria-hidden onClick={onClose} />
      <div className="fixed inset-y-0 right-0 z-[75] flex w-full max-w-lg flex-col border-l border-slate-200 bg-slate-50 shadow-2xl dark:border-slate-700 dark:bg-slate-950">
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
          <button type="button" className="text-sm text-sky-600 dark:text-sky-400" onClick={onClose}>
            ← Back
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100">
              {loading ? "…" : strategy?.name ?? "Strategy"}
            </h2>
            <p className="text-[10px] text-slate-500">
              Signal brain · shared across modes
              {strategyType ? (
                <span className="ml-1.5 rounded bg-sky-100 px-1.5 py-0.5 font-medium text-sky-800 dark:bg-sky-950 dark:text-sky-300">
                  {strategyType}
                </span>
              ) : null}
            </p>
          </div>
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px] text-slate-600 dark:text-slate-400"
            onClick={() => {
              const n = window.prompt("Strategy name", strategy?.name ?? "");
              if (n == null || !strategyId) return;
              void renameStrategyWithGuard(strategyId, n.trim() || strategy?.name)
                .then(() => load())
                .catch((e) =>
                  pushLog({
                    level: "error",
                    msg: e instanceof Error ? e.message : `Rename failed: ${String(e)}`,
                  }),
                );
            }}
          >
            Edit
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          {loading ? (
            <p className="text-xs text-slate-500">Loading…</p>
          ) : !latest ? (
            <p className="text-xs text-slate-500">
              No config saved yet. Use Save in the Trading panel to store the current signal-brain settings.
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {strategyVersionBadgeLabels(latest).map((b) => (
                  <span
                    key={b}
                    className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300"
                  >
                    {b}
                  </span>
                ))}
                {inUse ? (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800 dark:text-amber-300">
                    ★ In use by active instance
                  </span>
                ) : null}
              </div>
              <p className="mb-3 text-[10px] text-slate-500">Last saved {formatAgo(latest.createdAt)}</p>

              {perf && perf.totalTrades > 0 ? (
                <p className="mb-3 text-[10px] leading-relaxed text-slate-600 dark:text-slate-400">
                  <span className={toneClass(toneWinRate(perf.winRatePct))}>W:{perf.winRatePct.toFixed(0)}%</span>
                  <span className="text-slate-400"> · </span>
                  <span className={toneClass(toneProfitFactor(perf.profitFactor))}>
                    PF:{perf.profitFactor != null ? perf.profitFactor.toFixed(1) : "—"}
                  </span>
                  <span className="text-slate-400"> · </span>
                  <span className={toneClass(toneMaxDrawdown(perf.maxDrawdownPct))}>
                    DD:{perf.maxDrawdownPct != null ? `${perf.maxDrawdownPct.toFixed(1)}%` : "—"}
                  </span>
                </p>
              ) : (
                <p className="mb-3 text-[10px] text-slate-500">No closed trades yet</p>
              )}

              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                Saved configuration
              </h3>
              <StrategyConfigDetail sections={configSections} />

              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  className="rounded-md border border-slate-300 px-2 py-1 text-[11px] dark:border-slate-600"
                  onClick={() => setCloneOpen(true)}
                >
                  Duplicate strategy
                </button>
                {!inUse ? (
                  <button
                    type="button"
                    className="rounded-md bg-sky-600 px-2 py-1 text-[11px] font-semibold text-white disabled:opacity-40"
                    disabled={!activeInstanceId}
                    title={!activeInstanceId ? "Select an instance tab first" : undefined}
                    onClick={() => void runSetActiveForInstance()}
                  >
                    Set active
                  </button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      <CloneStrategyModal
        open={cloneOpen}
        sourceName={strategy?.name ?? "Strategy"}
        onClose={() => setCloneOpen(false)}
        onClone={async (name) => {
          if (!strategyId) return;
          await cloneStrategyAsNewStore(strategyId, name);
          await load();
          pushLog({ level: "info", msg: `Created strategy “${name}”`, category: "config" });
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
