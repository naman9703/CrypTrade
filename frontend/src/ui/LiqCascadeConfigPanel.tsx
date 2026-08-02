import { useGuardedCheckbox } from "./useGuardedCheckbox";
import { RangeSliderReleaseCommit } from "./RangeSliderReleaseCommit";
import type { LiqCascadeCfgUi } from "../lib/liqCascadeConfigUi";
import { liqCascadeOiGateEnabled } from "../lib/liqCascadeConfigUi";

type Props = {
  cfg: LiqCascadeCfgUi;
  onPatch: (patch: Record<string, unknown>) => void;
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded border border-orange-300/40 bg-white/60 p-2 dark:border-orange-800/40 dark:bg-slate-950/40">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-orange-900/90 dark:text-orange-200/90">
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
      {checked && children ? <div className="ml-5 border-l-2 border-orange-400/30 pl-2.5">{children}</div> : null}
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
  suffix,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  ariaLabel: string;
  onCommit: (v: number) => void;
  suffix?: string;
}) {
  return (
    <label className="block text-[10px] text-slate-600 dark:text-slate-400">
      <span className="font-semibold text-slate-700 dark:text-slate-300">{label}</span>
      <span className="ml-1 font-mono text-orange-900 dark:text-orange-100">{format(value)}</span>
      {suffix ? <span className="ml-1 text-slate-500">{suffix}</span> : null}
      <RangeSliderReleaseCommit
        className="mt-1 block w-full accent-orange-600"
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

/**
 * LIQ_CASCADE threshold + gate toggles — maps 1:1 to bot config keys.
 * Changes stage immediately; persist with Save strategy on the bar.
 */
export function LiqCascadeConfigPanel({ cfg, onPatch }: Props) {
  const oiOn = liqCascadeOiGateEnabled(cfg);

  return (
    <div
      id="liq-cascade-config-panel"
      className="mt-2 space-y-2 rounded-lg border border-orange-500/35 bg-orange-50/40 p-2 dark:border-orange-600/30 dark:bg-slate-950/50"
    >
      <div className="text-[11px] font-semibold text-orange-950 dark:text-orange-100">Cascade gates & thresholds</div>
      <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
        Toggle each gate on/off and adjust thresholds. Unchecking disables that filter (sets threshold to 0 or mode off).
        Click <span className="font-semibold">Save strategy</span> on the bar to persist.
      </p>

      <Section title="Trigger (liq bar close)">
        <GateToggle
          label="Liq z-score spike"
          hint="Current bar liq vs lookback baseline"
          enabled={cfg.liqCascadeZScoreMin > 0}
          onToggle={(on) => onPatch({ liqCascadeZScoreMin: on ? 2 : 0 })}
        >
          <NumSlider
            label="Min z"
            value={Math.round(cfg.liqCascadeZScoreMin * 10)}
            min={5}
            max={40}
            step={1}
            format={(u) => (u / 10).toFixed(1)}
            ariaLabel="Liq cascade min z-score"
            onCommit={(u) => onPatch({ liqCascadeZScoreMin: Math.max(0.5, u / 10) })}
          />
        </GateToggle>

        <GateToggle
          label="Min liquidation USD / bar"
          hint="Ignore small liq buckets"
          enabled={cfg.liqCascadeMinLiqUsdBar > 0}
          onToggle={(on) => onPatch({ liqCascadeMinLiqUsdBar: on ? 50_000 : 0 })}
        >
          <NumSlider
            label="Min $"
            value={Math.min(200, Math.round(cfg.liqCascadeMinLiqUsdBar / 1000))}
            min={1}
            max={200}
            step={1}
            format={(u) => `$${(u * 1000).toLocaleString()}`}
            ariaLabel="Min liq USD per bar"
            onCommit={(u) => onPatch({ liqCascadeMinLiqUsdBar: u * 1000 })}
          />
        </GateToggle>

        <GateToggle
          label="In-bar displacement (ATR)"
          hint="Price must move with the liq bar"
          enabled={cfg.liqCascadeMinDispAtr > 0}
          onToggle={(on) =>
            onPatch({
              liqCascadeMinDispAtr: on ? 1 : 0,
              liqCascadeStrongDispAtr: on ? Math.max(cfg.liqCascadeStrongDispAtr, 1.5) : 0,
            })
          }
        >
          <NumSlider
            label="Min disp × ATR"
            value={Math.round(cfg.liqCascadeMinDispAtr * 10)}
            min={0}
            max={30}
            step={1}
            format={(u) => (u / 10).toFixed(1)}
            ariaLabel="Min displacement ATR"
            onCommit={(u) => onPatch({ liqCascadeMinDispAtr: u / 10 })}
          />
          <NumSlider
            label="Tier A (immediate) × ATR"
            value={Math.round(cfg.liqCascadeStrongDispAtr * 10)}
            min={5}
            max={40}
            step={1}
            format={(u) => (u / 10).toFixed(1)}
            ariaLabel="Strong displacement ATR"
            onCommit={(u) => onPatch({ liqCascadeStrongDispAtr: u / 10 })}
          />
        </GateToggle>

        <GateToggle
          label="ATR volatility floor"
          hint="Skip dead/chop bars"
          enabled={cfg.liqCascadeMinAtrPct > 0}
          onToggle={(on) => onPatch({ liqCascadeMinAtrPct: on ? 0.035 : 0 })}
        >
          <NumSlider
            label="Min ATR %"
            value={Math.round(cfg.liqCascadeMinAtrPct * 1000)}
            min={0}
            max={100}
            step={1}
            format={(u) => `${(u / 1000).toFixed(3)}%`}
            ariaLabel="Min ATR percent"
            onCommit={(u) => onPatch({ liqCascadeMinAtrPct: u / 1000 })}
          />
        </GateToggle>
      </Section>

      <Section title="Open interest gate">
        <GateToggle
          label="OI unwind drop"
          hint="Binance OI ingest (5m) — confirms positions closing"
          enabled={oiOn}
          onToggle={(on) =>
            onPatch({
              liqCascadeOiGateMode: on ? "window" : "off",
              liqCascadeMinOiDropPct: on ? 0.12 : 0,
            })
          }
        >
          <label className="block text-[10px] text-slate-600 dark:text-slate-400">
            OI source
            <select
              className="mt-0.5 block w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
              value={cfg.liqCascadeOiSource}
              onChange={(e) => onPatch({ liqCascadeOiSource: e.target.value })}
            >
              <option value="binance">Binance (recommended)</option>
              <option value="coinalyze">Coinalyze</option>
            </select>
          </label>
          <label className="mt-1 block text-[10px] text-slate-600 dark:text-slate-400">
            Gate mode
            <select
              className="mt-0.5 block w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
              value={cfg.liqCascadeOiGateMode}
              onChange={(e) => onPatch({ liqCascadeOiGateMode: e.target.value })}
            >
              <option value="window">Window (N-bar drop)</option>
              <option value="same_bar">Same bar drop</option>
              <option value="off">Off</option>
            </select>
          </label>
          <NumSlider
            label="Min OI drop %"
            value={Math.round(cfg.liqCascadeMinOiDropPct * 100)}
            min={1}
            max={50}
            step={1}
            format={(u) => `${(u / 100).toFixed(2)}%`}
            ariaLabel="Min OI drop percent"
            onCommit={(u) => onPatch({ liqCascadeMinOiDropPct: u / 100 })}
          />
          <NumSlider
            label="OI window (liq bars)"
            value={cfg.liqCascadeOiWindowBars}
            min={1}
            max={24}
            step={1}
            format={(u) => String(u)}
            ariaLabel="OI window bars"
            suffix="(wall-clock scales for 1m liq + 5m OI)"
            onCommit={(u) => onPatch({ liqCascadeOiWindowBars: u })}
          />
        </GateToggle>
      </Section>

      <Section title="Confirm ladder">
        <label className="block text-[10px] text-slate-600 dark:text-slate-400">
          Confirm mode
          <select
            className="mt-0.5 block w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
            value={cfg.liqCascadeConfirmMode}
            onChange={(e) => onPatch({ liqCascadeConfirmMode: e.target.value })}
          >
            <option value="ladder">Ladder (Tier A + B stall/exhaustion)</option>
            <option value="stall_reclaim">Stall / reclaim only</option>
            <option value="exhaustion_decay">Liq exhaustion decay</option>
            <option value="either">Either stall or exhaustion</option>
          </select>
        </label>
        <NumSlider
          label="Confirm window (liq bars)"
          value={cfg.liqCascadeConfirmLiqBars}
          min={1}
          max={12}
          step={1}
          format={(u) => String(u)}
          ariaLabel="Confirm liq bars"
          onCommit={(u) => onPatch({ liqCascadeConfirmLiqBars: u })}
        />
        <NumSlider
          label="Exhaustion decay ratio"
          value={Math.round(cfg.liqCascadeExhaustionDecay * 100)}
          min={20}
          max={90}
          step={1}
          format={(u) => (u / 100).toFixed(2)}
          ariaLabel="Exhaustion decay ratio"
          suffix="(liq rate vs peak)"
          onCommit={(u) => onPatch({ liqCascadeExhaustionDecay: u / 100 })}
        />
      </Section>

      <Section title="Brackets & exits">
        <GateToggle
          label="Min risk:reward floor"
          hint="Reject setups where TP/SL ratio is too low"
          enabled={cfg.liqCascadeMinRr > 0}
          onToggle={(on) => onPatch({ liqCascadeMinRr: on ? 0.8 : 0 })}
        >
          <NumSlider
            label="Min R:R"
            value={Math.round(cfg.liqCascadeMinRr * 100)}
            min={0}
            max={300}
            step={5}
            format={(u) => (u / 100).toFixed(2)}
            ariaLabel="Min risk reward"
            onCommit={(u) => onPatch({ liqCascadeMinRr: u / 100 })}
          />
        </GateToggle>

        <GateToggle
          label="TP at fixed R (vs ATR)"
          hint="When on, TP distance = SL distance × R; when off, TP = ATR mult"
          enabled={cfg.liqCascadeTpRr > 0}
          onToggle={(on) => onPatch({ liqCascadeTpRr: on ? 1 : 0, liqCascadeTpAtrMult: on ? cfg.liqCascadeTpAtrMult : 5 })}
        >
          <NumSlider
            label="TP × R"
            value={Math.round(cfg.liqCascadeTpRr * 100)}
            min={50}
            max={500}
            step={5}
            format={(u) => `${(u / 100).toFixed(2)}R`}
            ariaLabel="TP risk reward mult"
            onCommit={(u) => onPatch({ liqCascadeTpRr: u / 100 })}
          />
        </GateToggle>

        {!cfg.liqCascadeTpRr ? (
          <NumSlider
            label="TP × ATR"
            value={Math.round(cfg.liqCascadeTpAtrMult * 10)}
            min={5}
            max={100}
            step={1}
            format={(u) => (u / 10).toFixed(1)}
            ariaLabel="TP ATR mult"
            onCommit={(u) => onPatch({ liqCascadeTpAtrMult: u / 10 })}
          />
        ) : null}

        <NumSlider
          label="SL buffer %"
          value={Math.round(cfg.liqCascadeSlBufferPct * 10000)}
          min={5}
          max={50}
          step={1}
          format={(u) => `${(u / 10000).toFixed(3)}%`}
          ariaLabel="SL buffer percent"
          onCommit={(u) => onPatch({ liqCascadeSlBufferPct: u / 10000 })}
        />
        <NumSlider
          label="Max hold (1m chart bars)"
          value={cfg.liqCascadeMaxHoldBars}
          min={0}
          max={120}
          step={1}
          format={(u) => (u === 0 ? "off" : String(u))}
          ariaLabel="Max hold bars"
          onCommit={(u) => onPatch({ liqCascadeMaxHoldBars: u })}
        />
      </Section>

      <Section title="Frequency & churn control">
        <NumSlider
          label="One-shot cooldown (liq bars)"
          value={cfg.liqCascadeEventCooldownLiqBars}
          min={0}
          max={48}
          step={1}
          format={(u) => (u === 0 ? "off" : String(u))}
          ariaLabel="Event cooldown liq bars"
          suffix="0 = allow re-entry on same cascade"
          onCommit={(u) => onPatch({ liqCascadeEventCooldownLiqBars: u })}
        />
        <NumSlider
          label="Max trades / day"
          value={cfg.liqCascadeMaxTradesPerDay}
          min={1}
          max={30}
          step={1}
          format={(u) => String(u)}
          ariaLabel="Max trades per day"
          onCommit={(u) => onPatch({ liqCascadeMaxTradesPerDay: u })}
        />
        <NumSlider
          label="Min bar gap (1m bars)"
          value={cfg.liqCascadeMinBarGap}
          min={0}
          max={30}
          step={1}
          format={(u) => String(u)}
          ariaLabel="Min bar gap"
          onCommit={(u) => onPatch({ liqCascadeMinBarGap: u })}
        />
      </Section>

      <Section title="Data & direction">
        <label className="block text-[10px] text-slate-600 dark:text-slate-400">
          Liq bar interval
          <select
            className="mt-0.5 block w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
            value={cfg.liqCascadeInterval}
            onChange={(e) => onPatch({ liqCascadeInterval: e.target.value })}
          >
            <option value="1min">1 min (high freq)</option>
            <option value="5min">5 min (default prod)</option>
            <option value="15min">15 min</option>
          </select>
        </label>
        <label className="mt-1 block text-[10px] text-slate-600 dark:text-slate-400">
          Liq data source
          <select
            className="mt-0.5 block w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
            value={cfg.liqCascadeLiqSource}
            onChange={(e) => onPatch({ liqCascadeLiqSource: e.target.value })}
          >
            <option value="force_orders">Binance force_orders (live archive)</option>
            <option value="coinalyze">Coinalyze</option>
          </select>
        </label>
        <label className="mt-1 block text-[10px] text-slate-600 dark:text-slate-400">
          Direction
          <select
            className="mt-0.5 block w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
            value={cfg.liqCascadeDirectionMode}
            onChange={(e) => onPatch({ liqCascadeDirectionMode: e.target.value })}
          >
            <option value="fade">Fade forced flow (mean revert)</option>
            <option value="continuation">Continuation (ride cascade)</option>
          </select>
        </label>
        <label className="mt-1 flex cursor-pointer items-start gap-2 text-[11px] text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={cfg.liqCascadeLiveTickEnabled}
            onChange={(e) => onPatch({ liqCascadeLiveTickEnabled: e.currentTarget.checked })}
          />
          <span>
            Live tick executor (paper unless LIQ_CASCADE_LIVE_ALLOW=1)
            {cfg.liqCascadeLiveTickEnabled ? (
              <span className="mt-0.5 block text-[10px] text-amber-700 dark:text-amber-300">
                Requires bot <b>Start</b>. Leave off for bar-close-only (default prod presets).
              </span>
            ) : null}
          </span>
        </label>
        <NumSlider
          label="Z lookback (liq bars)"
          value={cfg.liqCascadeLookbackBars}
          min={20}
          max={120}
          step={1}
          format={(u) => String(u)}
          ariaLabel="Liq lookback bars"
          onCommit={(u) => onPatch({ liqCascadeLookbackBars: u })}
        />
      </Section>
    </div>
  );
}
