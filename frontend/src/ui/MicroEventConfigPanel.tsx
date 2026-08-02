import { useGuardedCheckbox } from "./useGuardedCheckbox";
import { RangeSliderReleaseCommit } from "./RangeSliderReleaseCommit";
import type { MicroEventCfgUi } from "../lib/microEventConfigUi";

type Props = {
  cfg: MicroEventCfgUi;
  onPatch: (patch: Record<string, unknown>) => void;
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded border border-violet-300/40 bg-white/60 p-2 dark:border-violet-800/40 dark:bg-slate-950/40">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-900/90 dark:text-violet-200/90">
        {title}
      </div>
      {children}
    </div>
  );
}

function GateToggle({
  label,
  hint,
  enabled,
  onToggle,
  children,
}: {
  label: string;
  hint?: string;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  children?: React.ReactNode;
}) {
  const [checked, setChecked] = useGuardedCheckbox(enabled);
  return (
    <div className="space-y-1">
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={checked}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            setChecked(on);
            onToggle(on);
          }}
        />
        <span className="min-w-0 flex-1 text-[11px] leading-snug text-slate-700 dark:text-slate-300">
          <span className="font-semibold text-slate-800 dark:text-slate-200">{label}</span>
          {hint ? <span className="mt-0.5 block text-[10px] text-slate-500">{hint}</span> : null}
        </span>
      </label>
      {checked && children ? <div className="ml-5 border-l-2 border-violet-400/30 pl-2.5">{children}</div> : null}
    </div>
  );
}

function NumSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  ariaLabel,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  ariaLabel: string;
  onCommit: (v: number) => void;
}) {
  return (
    <label className="block text-[10px] text-slate-600 dark:text-slate-400">
      <span className="font-semibold text-slate-700 dark:text-slate-300">{label}</span>
      <span className="ml-1 font-mono text-violet-900 dark:text-violet-100">{format(value)}</span>
      <RangeSliderReleaseCommit
        className="mt-1 block w-full accent-violet-600"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={ariaLabel}
        onCommit={onCommit}
      />
    </label>
  );
}

/** MICRO_EVENT confluence + gate toggles — use stageStrategyBotPatch from TradingPanel. */
export function MicroEventConfigPanel({ cfg, onPatch }: Props) {
  return (
    <div
      id="micro-event-config-panel"
      className="mt-2 space-y-2 rounded-lg border border-violet-500/35 bg-violet-50/40 p-2 dark:border-violet-600/30 dark:bg-slate-950/50"
    >
      <div className="text-[11px] font-semibold text-violet-950 dark:text-violet-100">
        Microstructure gates & confluence
      </div>
      <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
        Tick-first continuation scalper — liq spike required + N-of-M confirm layers. Click{" "}
        <span className="font-semibold">Save strategy</span> to persist.
      </p>

      <Section title="Futures direction (required for shorts)">
        <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
          Continuation <span className="font-semibold">SELL</span> after long liquidations opens a{" "}
          <span className="font-semibold">short</span> only in 2-way mode. 1-way blocks new shorts (SELL closes long only).
        </p>
        <div className="flex gap-1.5">
          <button
            type="button"
            className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold ${
              !cfg.supertrendFuturesTwoWay
                ? "bg-violet-600/90 text-white hover:bg-violet-600"
                : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400 dark:hover:bg-slate-900"
            }`}
            onClick={() => {
              if (!cfg.supertrendFuturesTwoWay) return;
              onPatch({ supertrendFuturesTwoWay: false });
            }}
          >
            1-way
          </button>
          <button
            type="button"
            className={`flex-1 rounded-md px-2 py-1.5 text-[11px] font-semibold ${
              cfg.supertrendFuturesTwoWay
                ? "bg-violet-600/90 text-white hover:bg-violet-600"
                : "border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-400 dark:hover:bg-slate-900"
            }`}
            onClick={() => {
              if (cfg.supertrendFuturesTwoWay) return;
              onPatch({ supertrendFuturesTwoWay: true });
            }}
          >
            2-way
          </button>
        </div>
        {!cfg.supertrendFuturesTwoWay ? (
          <p className="text-[10px] font-semibold text-amber-800 dark:text-amber-300">
            Short signals will be skipped until 2-way is enabled and saved.
          </p>
        ) : null}
      </Section>

      <Section title="Playbook">
        <label className="block text-[10px] text-slate-600">
          Direction mode
          <select
            className="mt-0.5 block w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
            value={cfg.microEventDirectionMode}
            onChange={(e) => onPatch({ microEventDirectionMode: e.currentTarget.value })}
          >
            <option value="continuation">Continuation (ride forced flow)</option>
            <option value="fade">Fade (counter cascade)</option>
          </select>
        </label>
        <NumSlider
          label="Min confluence score"
          value={cfg.microEventMinConfluenceScore}
          min={20}
          max={90}
          step={1}
          format={(v) => String(Math.round(v))}
          ariaLabel="Min confluence score"
          onCommit={(v) => onPatch({ microEventMinConfluenceScore: Math.round(v) })}
        />
        <NumSlider
          label="Min confirm layers (ex-liq)"
          value={cfg.microEventMinConfirmLayers}
          min={0}
          max={4}
          step={1}
          format={(v) => String(Math.round(v))}
          ariaLabel="Min confirm layers"
          onCommit={(v) => onPatch({ microEventMinConfirmLayers: Math.round(v) })}
        />
      </Section>

      <Section title="Liq spike (required)">
        <GateToggle
          label="Liq required hard gate"
          enabled={cfg.microEventLiqRequired}
          onToggle={(on) => onPatch({ microEventLiqRequired: on })}
        />
        <NumSlider
          label="Min liq USD (window)"
          value={cfg.microEventLiqMinUsd}
          min={5000}
          max={200_000}
          step={1000}
          format={(v) => `$${Math.round(v).toLocaleString()}`}
          ariaLabel="Min liq USD"
          onCommit={(v) => onPatch({ microEventLiqMinUsd: Math.round(v) })}
        />
        <NumSlider
          label="Liq z-like min"
          value={cfg.microEventLiqZMin}
          min={0.5}
          max={5}
          step={0.1}
          format={(v) => v.toFixed(1)}
          ariaLabel="Liq z min"
          onCommit={(v) => onPatch({ microEventLiqZMin: Number(v.toFixed(2)) })}
        />
      </Section>

      <Section title="Confirm layers">
        <GateToggle
          label="OI unwind"
          enabled={cfg.microEventOiGateEnabled}
          onToggle={(on) => onPatch({ microEventOiGateEnabled: on })}
        />
        <GateToggle
          label="Book imbalance"
          enabled={cfg.microEventBookGateEnabled}
          onToggle={(on) => onPatch({ microEventBookGateEnabled: on })}
        />
        <GateToggle
          label="CVD aggression"
          enabled={cfg.microEventCvdGateEnabled}
          onToggle={(on) => onPatch({ microEventCvdGateEnabled: on })}
        />
        <GateToggle
          label="Funding crowd"
          enabled={cfg.microEventFundingGateEnabled}
          onToggle={(on) => onPatch({ microEventFundingGateEnabled: on })}
        />
      </Section>

      <Section title="Risk & live">
        <NumSlider
          label="TP R multiple"
          value={cfg.microEventTpRr}
          min={0.8}
          max={3}
          step={0.1}
          format={(v) => `${v.toFixed(1)}R`}
          ariaLabel="TP RR"
          onCommit={(v) => onPatch({ microEventTpRr: Number(v.toFixed(2)) })}
        />
        <NumSlider
          label="Max hold (sec)"
          value={cfg.microEventMaxHoldSec}
          min={60}
          max={600}
          step={15}
          format={(v) => `${Math.round(v)}s`}
          ariaLabel="Max hold sec"
          onCommit={(v) => onPatch({ microEventMaxHoldSec: Math.round(v) })}
        />
        <label className="flex cursor-pointer items-center gap-2 text-[11px]">
          <input
            type="checkbox"
            checked={cfg.microEventLiveTickEnabled}
            onChange={(e) => onPatch({ microEventLiveTickEnabled: e.currentTarget.checked })}
          />
          Live tick executor (default ON — disable for bar-close proxy only)
        </label>
      </Section>
    </div>
  );
}
