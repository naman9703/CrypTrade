import { useCallback, useEffect, useMemo, useState } from "react";
import { tradingModeToApiModeSlug, type ApiTradingModeSlug } from "../../lib/tradingModeSlug";
import { EMPTY_BOT_INSTANCES, EMPTY_STRATEGIES } from "../../lib/stableEmptyArrays";
import { useAppStore } from "../../ws/store";
import type { BotInstance } from "../../types/instance";
import { InstanceTabBar } from "./InstanceTabBar";
import { InstanceTabContent } from "./InstanceTabContent";
import { CreateInstanceModal } from "./CreateInstanceModal";
import { EditInstanceLabelModal } from "./EditInstanceLabelModal";
import { DeleteInstanceModal } from "./DeleteInstanceModal";

export function InstancesPanel() {
  const mode = useAppStore((s) => s.mode);
  const modeSlug = useMemo(() => tradingModeToApiModeSlug(mode), [mode]);
  const instances = useAppStore((s) => s.instancesByMode[modeSlug] ?? EMPTY_BOT_INSTANCES);
  const instancesLoading = useAppStore((s) => s.instancesLoading);
  const selectedInstanceId = useAppStore((s) => s.selectedInstanceId);
  const activeInstanceByMode = useAppStore((s) => s.activeInstanceByMode);
  const activeTradingId = activeInstanceByMode[modeSlug];
  const layout = useAppStore((s) => s.layout);
  const strategies = useAppStore((s) => s.strategiesByMode[modeSlug] ?? EMPTY_STRATEGIES);
  const versionsByStrategyId = useAppStore((s) => s.versionsByStrategyId);

  const fetchInstancesForMode = useAppStore((s) => s.fetchInstancesForMode);
  const fetchStrategiesForMode = useAppStore((s) => s.fetchStrategiesForMode);
  const selectInstance = useAppStore((s) => s.selectInstance);
  const setActiveTradingInstanceForMode = useAppStore((s) => s.setActiveTradingInstanceForMode);
  const setInstancesPanelCollapsed = useAppStore((s) => s.setInstancesPanelCollapsed);

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteCtx, setDeleteCtx] = useState<BotInstance | null>(null);

  useEffect(() => {
    void fetchInstancesForMode(modeSlug);
  }, [fetchInstancesForMode, modeSlug]);

  /** Create-instance modal needs `latestVersion` per strategy; that list was only loaded by StrategySidebar before. */
  useEffect(() => {
    void fetchStrategiesForMode(modeSlug);
  }, [fetchStrategiesForMode, modeSlug]);

  const selected = useMemo(
    () => instances.find((i) => i.id === selectedInstanceId) ?? null,
    [instances, selectedInstanceId],
  );

  useEffect(() => {
    if (instances.length === 0) {
      selectInstance(null);
      return;
    }
    if (selectedInstanceId && instances.some((i) => i.id === selectedInstanceId)) return;
    const prefer =
      activeTradingId && instances.some((i) => i.id === activeTradingId) ? activeTradingId : instances[0].id;
    selectInstance(prefer);
  }, [instances, selectedInstanceId, activeTradingId, selectInstance]);

  const fetchVersionsForStrategy = useAppStore((s) => s.fetchVersionsForStrategy);
  useEffect(() => {
    const sid = selected?.strategyId;
    if (sid) void fetchVersionsForStrategy(sid);
  }, [selected?.strategyId, fetchVersionsForStrategy]);

  const versionForSelected = useMemo(() => {
    if (!selected?.strategyId) return null;
    const vid = selected.strategyVersionId;
    const list = versionsByStrategyId[selected.strategyId];
    return list?.find((v) => v.id === vid) ?? null;
  }, [selected, versionsByStrategyId]);

  const onTabSelect = useCallback(
    async (id: string) => {
      selectInstance(id);
      try {
        await setActiveTradingInstanceForMode(modeSlug, id);
      } catch {
        /* offline */
      }
    },
    [selectInstance, setActiveTradingInstanceForMode, modeSlug],
  );

  const onRefresh = useCallback(() => {
    void fetchInstancesForMode(modeSlug);
  }, [fetchInstancesForMode, modeSlug]);

  const onDeleteTab = useCallback((inst: BotInstance) => {
    const st = String(inst.status).toLowerCase();
    if (st === "running" || st === "paused") {
      useAppStore.getState().pushLog({ level: "warn", msg: "Stop the bot before deleting this instance" });
      return;
    }
    setDeleteCtx(inst);
  }, []);

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-100/80 shadow-glow-light dark:border-slate-800 dark:bg-slate-950/50 dark:shadow-glow">
      <InstanceTabBar
        instances={instances}
        selectedId={selectedInstanceId}
        activeTradingId={activeTradingId}
        onSelect={(id) => void onTabSelect(id)}
        onAdd={() => {
          void fetchStrategiesForMode(modeSlug);
          setCreateOpen(true);
        }}
        onDeleteTab={onDeleteTab}
        collapsed={layout.instancesPanelCollapsed}
        onToggleCollapse={() => setInstancesPanelCollapsed(!layout.instancesPanelCollapsed)}
      />
      {instancesLoading && instances.length === 0 ? (
        <div className="p-4 text-center text-xs text-slate-500">Loading instances…</div>
      ) : null}
      {!layout.instancesPanelCollapsed && selected ? (
        <InstanceTabContent
          modeSlug={modeSlug}
          instance={selected}
          version={versionForSelected}
          onEditLabel={() => setEditOpen(true)}
          onDelete={() => setDeleteCtx(selected)}
          onRefresh={onRefresh}
        />
      ) : null}
      {!layout.instancesPanelCollapsed && !selected && instances.length === 0 && !instancesLoading ? (
        <div className="p-4 text-center text-xs text-slate-500">No instances yet — click + to create one.</div>
      ) : null}

      <CreateInstanceModal
        modeSlug={modeSlug}
        strategies={strategies}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          void onTabSelect(id);
          onRefresh();
        }}
      />
      {selected ? (
        <EditInstanceLabelModal
          instanceId={selected.id}
          initialLabel={selected.label ?? ""}
          open={editOpen}
          onClose={() => setEditOpen(false)}
          onSaved={onRefresh}
        />
      ) : null}
      {deleteCtx ? (
        <DeleteInstanceModal
          instance={deleteCtx}
          open={Boolean(deleteCtx)}
          onClose={() => setDeleteCtx(null)}
          onDeleted={() => {
            onRefresh();
            setDeleteCtx(null);
          }}
        />
      ) : null}
    </div>
  );
}
