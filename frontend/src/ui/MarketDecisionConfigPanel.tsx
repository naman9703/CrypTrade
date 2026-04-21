import type { MarketDecisionEngineConfig } from "../lib/marketDecision/types";
import { DEFAULT_MARKET_DECISION_CONFIG } from "../lib/marketDecision/configDefaults";

const D = DEFAULT_MARKET_DECISION_CONFIG;

type Props = {
  md: MarketDecisionEngineConfig;
  onPatch: (patch: Partial<MarketDecisionEngineConfig>) => void;
};

function LayerCheck({
  id,
  label,
  sub,
  checked,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  sub?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded border border-transparent px-1 py-0.5 hover:border-violet-300/40 dark:hover:border-violet-600/30">
      <input
        id={id}
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className="min-w-0 flex-1 text-[11px] leading-snug text-slate-700 dark:text-slate-300">
        <span className="font-semibold text-slate-800 dark:text-slate-200">{label}</span>
        {sub ? <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-500">{sub}</span> : null}
      </span>
    </label>
  );
}

/**
 * Filter-layer style toggles for the market decision engine (maps 1:1 to server `marketDecision` keys).
 */
export function MarketDecisionConfigPanel({ md, onPatch }: Props) {
  const scoreOn = md.signalQualityEnabled === true;
  const chopOn = md.chopEnabled === true;

  const setWeight = (key: keyof MarketDecisionEngineConfig, def: number, on: boolean) => {
    onPatch({ [key]: on ? def : 0 } as Partial<MarketDecisionEngineConfig>);
  };

  return (
    <div className="mt-2 space-y-3 border-t border-violet-200/50 pt-2 dark:border-violet-800/40">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-800 dark:text-violet-200">
        Filter layers (server pipeline)
      </div>
      <div className="grid gap-x-3 gap-y-1 sm:grid-cols-2">
        <LayerCheck
          id="md-regime"
          label="Regime (ADX · EMA trend)"
          sub="LTF classification + confidence gate"
          checked={md.regimeFilterEnabled === true}
          onChange={(on) => onPatch({ regimeFilterEnabled: on })}
        />
        <LayerCheck
          id="md-transition"
          label="Transition block"
          sub="Block when chop + trend mix in lookback"
          checked={md.transitionBlockEnabled === true}
          onChange={(on) => onPatch({ transitionBlockEnabled: on })}
        />
        <LayerCheck
          id="md-chop"
          label="Chop (microstructure)"
          sub="ADX / range / regime flips"
          checked={chopOn}
          onChange={(on) => onPatch({ chopEnabled: on })}
        />
        <LayerCheck
          id="md-htf"
          label="HTF regime"
          sub="Higher timeframe slice (when LTF/HTF bars align)"
          checked={md.htfEnabled === true}
          onChange={(on) => onPatch({ htfEnabled: on })}
        />
        <LayerCheck
          id="md-btc"
          label="BTC filter"
          sub="Global BTC regime quality"
          checked={md.btcFilterEnabled === true}
          onChange={(on) => onPatch({ btcFilterEnabled: on })}
        />
        <LayerCheck
          id="md-score"
          label="Composite signal score"
          sub="ST · EMA · RSI · HTF match weights"
          checked={scoreOn}
          onChange={(on) => onPatch({ signalQualityEnabled: on })}
        />
        <LayerCheck
          id="md-fee"
          label="Fee vs expected move"
          sub="Round-trip fees + buffer + slippage"
          checked={md.feeGateEnabled === true}
          onChange={(on) => onPatch({ feeGateEnabled: on })}
        />
        <div className="col-span-full rounded border border-dashed border-slate-300/80 bg-slate-50/80 px-2 py-1.5 dark:border-slate-600/60 dark:bg-slate-900/40">
          <div className="text-[10px] font-semibold text-slate-600 dark:text-slate-400">Volume · ATR expansion · body</div>
          <p className="mt-0.5 text-[10px] leading-snug text-slate-500 dark:text-slate-500">
            Not part of this engine. Use <span className="font-semibold text-cyan-800 dark:text-cyan-200">Move quality</span> below for
            volume vs average, ATR expansion, directional body, and composite MQ score on opens.
          </p>
        </div>
      </div>

      {chopOn ? (
        <div className="rounded-md bg-violet-50/80 px-2 py-1.5 dark:bg-violet-950/35">
          <div className="mb-1 text-[10px] font-semibold text-violet-900 dark:text-violet-100">Chop sub-layers</div>
          <div className="grid gap-1 sm:grid-cols-3">
            <LayerCheck
              id="md-chop-adx"
              label="ADX weak"
              checked={md.chopAdxEnabled === true}
              onChange={(on) => onPatch({ chopAdxEnabled: on })}
            />
            <LayerCheck
              id="md-chop-range"
              label="Range compression"
              checked={md.chopRangeEnabled === true}
              onChange={(on) => onPatch({ chopRangeEnabled: on })}
            />
            <LayerCheck
              id="md-chop-flip"
              label="Regime flips"
              checked={md.chopFlipEnabled === true}
              onChange={(on) => onPatch({ chopFlipEnabled: on })}
            />
          </div>
        </div>
      ) : null}

      {scoreOn ? (
        <div className="rounded-md bg-violet-50/80 px-2 py-1.5 dark:bg-violet-950/35">
          <div className="mb-1 text-[10px] font-semibold text-violet-900 dark:text-violet-100">Score components (weights)</div>
          <div className="grid gap-1 sm:grid-cols-2">
            <LayerCheck
              id="md-w-st"
              label="Supertrend confirm"
              checked={Number(md.weightSupertrend) > 0}
              onChange={(on) => setWeight("weightSupertrend", D.weightSupertrend, on)}
            />
            <LayerCheck
              id="md-w-ema"
              label="EMA alignment"
              checked={Number(md.weightEmaAlign) > 0}
              onChange={(on) => setWeight("weightEmaAlign", D.weightEmaAlign, on)}
            />
            <LayerCheck
              id="md-w-rsi"
              label="RSI bias"
              sub="Long: RSI≥50 · Short: RSI≤50"
              checked={Number(md.weightRsi) > 0}
              onChange={(on) => setWeight("weightRsi", D.weightRsi, on)}
            />
            <LayerCheck
              id="md-w-htf"
              label="HTF trend match"
              checked={Number(md.weightHtfMatch) > 0}
              onChange={(on) => setWeight("weightHtfMatch", D.weightHtfMatch, on)}
            />
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <div className="text-[10px] font-semibold text-violet-900 dark:text-violet-100">Entry timing</div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-slate-600 dark:text-slate-400">Mode</span>
          <select
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            value={md.entryMode}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "INSTANT" || v === "PULLBACK" || v === "BREAKOUT") onPatch({ entryMode: v });
            }}
          >
            <option value="INSTANT">Instant (always ENTER)</option>
            <option value="PULLBACK">Pullback (wait until near EMA)</option>
            <option value="BREAKOUT">Breakout (wait until stretched from EMA)</option>
          </select>
        </div>
        <p className="text-[10px] leading-snug text-slate-500 dark:text-slate-500">
          Pullback / breakout are <span className="font-semibold">entry timing</span> rules (distance to EMA vs ATR band), not the separate chart breakout-confirm setting.
        </p>
      </div>

      {md.htfEnabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-slate-600 dark:text-slate-400">HTF timeframe</span>
          <select
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            value={String(md.htfTimeframe || "15m")}
            onChange={(e) => onPatch({ htfTimeframe: e.target.value })}
          >
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="30m">30m</option>
            <option value="1h">1h</option>
            <option value="4h">4h</option>
            <option value="1d">1d</option>
          </select>
        </div>
      ) : null}
    </div>
  );
}
