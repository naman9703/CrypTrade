import type { MarketDecisionEngineConfig } from "../lib/marketDecision/types";
import { DEFAULT_MARKET_DECISION_CONFIG } from "../lib/marketDecision/configDefaults";
import {
  MARKET_DECISION_ENGINE_OVERVIEW,
  MARKET_DECISION_PARAM_TOOLTIPS,
  marketDecisionNumericDefaultsPatch,
} from "../lib/marketDecision/configUiMeta";

const D = DEFAULT_MARKET_DECISION_CONFIG;
const T = MARKET_DECISION_PARAM_TOOLTIPS;

type Props = {
  md: MarketDecisionEngineConfig;
  onPatch: (patch: Partial<MarketDecisionEngineConfig>) => void;
};

function MdNumField({
  k,
  label,
  value,
  onPatch,
  step = 1,
  min,
  max,
  suffix,
}: {
  k: keyof MarketDecisionEngineConfig;
  label: string;
  value: number;
  onPatch: Props["onPatch"];
  step?: number;
  min?: number;
  max?: number;
  suffix?: string;
}) {
  const tip = T[k];
  return (
    <label className="flex flex-col gap-0.5 text-[10px] text-slate-600 dark:text-slate-400" title={tip}>
      <span className="inline-flex items-center gap-0.5">
        <span>{label}</span>
        <span className="cursor-help text-[9px] font-normal text-slate-400 dark:text-slate-500" title={tip}>
          ⓘ
        </span>
        {suffix ? <span className="font-normal text-slate-500">{suffix}</span> : null}
      </span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onPatch({ [k]: Number(e.target.value) } as Partial<MarketDecisionEngineConfig>)}
      />
    </label>
  );
}

function LayerCheck({
  id,
  label,
  sub,
  checked,
  onChange,
  disabled,
  tipKey,
}: {
  id: string;
  label: string;
  sub?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  tipKey?: keyof MarketDecisionEngineConfig;
}) {
  const tip = tipKey ? T[tipKey] : undefined;
  return (
    <label
      className="flex cursor-pointer items-start gap-2 rounded border border-transparent px-1 py-0.5 hover:border-violet-300/40 dark:hover:border-violet-600/30"
      title={tip}
    >
      <input
        id={id}
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span className="min-w-0 flex-1 text-[11px] leading-snug text-slate-700 dark:text-slate-300">
        <span className="inline-flex items-center gap-0.5 font-semibold text-slate-800 dark:text-slate-200">
          {label}
          {tip ? (
            <span className="cursor-help text-[9px] font-normal text-slate-400 dark:text-slate-500" title={tip}>
              ⓘ
            </span>
          ) : null}
        </span>
        {sub ? <span className="mt-0.5 block text-[10px] text-slate-500 dark:text-slate-500">{sub}</span> : null}
      </span>
    </label>
  );
}

/**
 * Filter-layer toggles + numeric thresholds for the market decision engine (maps 1:1 to server `marketDecision` keys).
 */
export function MarketDecisionConfigPanel({ md, onPatch }: Props) {
  const scoreOn = md.signalQualityEnabled === true;
  const chopOn = md.chopEnabled === true;

  const setWeight = (key: keyof MarketDecisionEngineConfig, def: number, on: boolean) => {
    onPatch({ [key]: on ? def : 0 } as Partial<MarketDecisionEngineConfig>);
  };

  const num = (k: keyof MarketDecisionEngineConfig, fallback: number): number => {
    const v = md[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
    return fallback;
  };

  return (
    <div className="mt-2 space-y-3 border-t border-violet-200/50 pt-2 dark:border-violet-800/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-800 dark:text-violet-200">
          Filter layers (server pipeline)
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md border border-slate-300/90 bg-white px-2 py-1 text-[10px] font-semibold text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800"
          title="Restore all numeric thresholds and weights in this panel to package defaults (does not change checkboxes or dropdown modes)."
          onClick={() => onPatch(marketDecisionNumericDefaultsPatch())}
        >
          Reset numeric thresholds to defaults
        </button>
      </div>

      <details className="rounded-md border border-violet-200/60 bg-violet-50/40 px-2 py-1.5 dark:border-violet-800/40 dark:bg-violet-950/25">
        <summary className="cursor-pointer select-none text-[11px] font-semibold text-violet-900 dark:text-violet-100">
          How this engine works — what the parameters mean
        </summary>
        <p className="mt-2 whitespace-pre-wrap text-[10px] leading-relaxed text-slate-600 dark:text-slate-400">
          {MARKET_DECISION_ENGINE_OVERVIEW}
        </p>
        <p className="mt-2 text-[10px] text-slate-500 dark:text-slate-500">
          Hover any <span className="font-mono">ⓘ</span> next to a field for that setting’s role in the pipeline and what a stricter or looser
          value implies.
        </p>
      </details>

      <div className="grid gap-x-3 gap-y-1 sm:grid-cols-2">
        <LayerCheck
          id="md-regime"
          label="Regime (ADX · EMA trend)"
          sub="LTF classification + confidence gate"
          tipKey="regimeFilterEnabled"
          checked={md.regimeFilterEnabled === true}
          onChange={(on) => onPatch({ regimeFilterEnabled: on })}
        />
        <LayerCheck
          id="md-transition"
          label="Transition block"
          sub="Block when chop + trend mix in lookback"
          tipKey="transitionBlockEnabled"
          checked={md.transitionBlockEnabled === true}
          onChange={(on) => onPatch({ transitionBlockEnabled: on })}
        />
        <LayerCheck
          id="md-chop"
          label="Chop (microstructure)"
          sub="ADX / range / regime flips"
          tipKey="chopEnabled"
          checked={chopOn}
          onChange={(on) => onPatch({ chopEnabled: on })}
        />
        <LayerCheck
          id="md-htf"
          label="HTF regime"
          sub="Higher timeframe slice (when LTF/HTF bars align)"
          tipKey="htfEnabled"
          checked={md.htfEnabled === true}
          onChange={(on) => onPatch({ htfEnabled: on })}
        />
        <LayerCheck
          id="md-btc"
          label="BTC filter"
          sub="Global BTC regime quality"
          tipKey="btcFilterEnabled"
          checked={md.btcFilterEnabled === true}
          onChange={(on) => onPatch({ btcFilterEnabled: on })}
        />
        <LayerCheck
          id="md-score"
          label="Composite signal score"
          sub="ST · EMA · RSI · HTF match weights"
          tipKey="signalQualityEnabled"
          checked={scoreOn}
          onChange={(on) => onPatch({ signalQualityEnabled: on })}
        />
        <LayerCheck
          id="md-fee"
          label="Fee vs expected move"
          sub="Compare ATR/SR-based expected move to a required % (classic fees or T02 trail gate)"
          tipKey="feeGateEnabled"
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

      <div className="rounded-md border border-slate-200/80 bg-slate-50/80 px-2 py-1.5 dark:border-slate-600/50 dark:bg-slate-900/40">
        <div className="mb-1 text-[10px] font-semibold text-slate-800 dark:text-slate-200" title={T.regimeFilterEnabled}>
          Regime classifier & stability <span className="cursor-help text-[9px] text-slate-400">ⓘ</span>
        </div>
        <div className="grid gap-1.5 sm:grid-cols-3 lg:grid-cols-4">
          <MdNumField k="adxStrong" label="ADX strong" value={num("adxStrong", D.adxStrong)} onPatch={onPatch} min={0} max={60} />
          <MdNumField k="adxWeak" label="ADX weak floor" value={num("adxWeak", D.adxWeak)} onPatch={onPatch} min={0} max={60} />
          <MdNumField k="emaLength" label="EMA length" value={num("emaLength", D.emaLength)} onPatch={onPatch} min={2} max={200} />
          <MdNumField
            k="atrVolThreshold"
            label="ATR/price (VOL)"
            value={num("atrVolThreshold", D.atrVolThreshold)}
            onPatch={onPatch}
            step={0.0005}
            min={0.001}
            max={0.2}
            suffix="(frac)"
          />
          <MdNumField
            k="stabilityLookback"
            label="Stability lookback"
            value={num("stabilityLookback", D.stabilityLookback)}
            onPatch={onPatch}
            min={2}
            max={30}
          />
          <MdNumField
            k="stabilityMinAgree"
            label="Stability min agree"
            value={num("stabilityMinAgree", D.stabilityMinAgree)}
            onPatch={onPatch}
            min={2}
            max={30}
          />
          <MdNumField
            k="transitionLookback"
            label="Transition lookback"
            value={num("transitionLookback", D.transitionLookback)}
            onPatch={onPatch}
            min={2}
            max={20}
          />
        </div>
      </div>

      <div className="rounded-md border border-slate-200/80 bg-slate-50/80 px-2 py-1.5 dark:border-slate-600/50 dark:bg-slate-900/40">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold text-slate-800 dark:text-slate-200" title={T.minRegimeConfidence}>
            Regime confidence gate <span className="cursor-help text-[9px] text-slate-400">ⓘ</span>
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <MdNumField
            k="minRegimeConfidence"
            label="Min confidence (0–100)"
            value={num("minRegimeConfidence", D.minRegimeConfidence)}
            onPatch={onPatch}
            min={0}
            max={100}
          />
          <label className="flex flex-col gap-0.5 text-[10px] text-slate-600 dark:text-slate-400" title={T.confidenceMode}>
            <span className="inline-flex items-center gap-0.5">
              Mode
              <span className="cursor-help text-[9px] text-slate-400" title={T.confidenceMode}>
                ⓘ
              </span>
            </span>
            <select
              className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
              value={md.confidenceMode}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "BLOCK" || v === "PENALTY") onPatch({ confidenceMode: v });
              }}
            >
              <option value="BLOCK">BLOCK below min</option>
              <option value="PENALTY">PENALTY below min</option>
            </select>
          </label>
          <MdNumField
            k="confidencePenalty"
            label="Confidence penalty"
            value={num("confidencePenalty", D.confidencePenalty)}
            onPatch={onPatch}
            min={0}
            max={100}
            suffix="(score pts)"
          />
        </div>
      </div>

      {chopOn ? (
        <div className="rounded-md bg-violet-50/80 px-2 py-1.5 dark:bg-violet-950/35">
          <div className="mb-1 text-[10px] font-semibold text-violet-900 dark:text-violet-100">Chop sub-layers & thresholds</div>
          <div className="grid gap-1 sm:grid-cols-3">
            <LayerCheck
              id="md-chop-adx"
              label="ADX weak"
              tipKey="chopAdxEnabled"
              checked={md.chopAdxEnabled === true}
              onChange={(on) => onPatch({ chopAdxEnabled: on })}
            />
            <LayerCheck
              id="md-chop-range"
              label="Range compression"
              tipKey="chopRangeEnabled"
              checked={md.chopRangeEnabled === true}
              onChange={(on) => onPatch({ chopRangeEnabled: on })}
            />
            <LayerCheck
              id="md-chop-flip"
              label="Regime flips"
              tipKey="chopFlipEnabled"
              checked={md.chopFlipEnabled === true}
              onChange={(on) => onPatch({ chopFlipEnabled: on })}
            />
          </div>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-3">
            <MdNumField
              k="chopRangeThreshold"
              label="Min range₁₀"
              value={num("chopRangeThreshold", D.chopRangeThreshold)}
              onPatch={onPatch}
              step={0.0005}
              min={0.001}
              max={0.2}
              suffix="(frac)"
            />
            <MdNumField k="chopMaxFlips" label="Max flips" value={num("chopMaxFlips", D.chopMaxFlips)} onPatch={onPatch} min={0} max={20} />
            <MdNumField k="penaltyChop" label="Soft chop penalty" value={num("penaltyChop", D.penaltyChop)} onPatch={onPatch} min={0} max={50} />
          </div>
          <div className="mt-2">
            <LayerCheck
              id="md-chop-hard"
              label="Chop hard block"
              sub="Off = only subtract penalty when chop fires"
              tipKey="chopHardBlock"
              checked={md.chopHardBlock === true}
              onChange={(on) => onPatch({ chopHardBlock: on })}
            />
          </div>
        </div>
      ) : null}

      <div className="rounded-md border border-slate-200/80 bg-slate-50/80 px-2 py-1.5 dark:border-slate-600/50 dark:bg-slate-900/40">
        <div className="mb-1 text-[10px] font-semibold text-slate-800 dark:text-slate-200">Direction vs regime & BTC</div>
        <div className="mb-2 flex flex-wrap gap-2">
          <label className="flex flex-col gap-0.5 text-[10px] text-slate-600 dark:text-slate-400" title={T.directionMismatchMode}>
            <span className="inline-flex items-center gap-0.5">
              Direction mismatch
              <span className="cursor-help text-[9px] text-slate-400" title={T.directionMismatchMode}>
                ⓘ
              </span>
            </span>
            <select
              className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
              value={md.directionMismatchMode}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "BLOCK" || v === "PENALTY") onPatch({ directionMismatchMode: v });
              }}
            >
              <option value="BLOCK">BLOCK</option>
              <option value="PENALTY">PENALTY</option>
            </select>
          </label>
          <MdNumField
            k="directionMismatchPenalty"
            label="Direction penalty"
            value={num("directionMismatchPenalty", D.directionMismatchPenalty)}
            onPatch={onPatch}
            min={0}
            max={100}
          />
          <label className="flex cursor-pointer items-center gap-2 pt-5 text-[10px] text-slate-600 dark:text-slate-400" title={T.allowSidewaysWithSignal}>
            <input
              type="checkbox"
              checked={md.allowSidewaysWithSignal === true}
              onChange={(e) => onPatch({ allowSidewaysWithSignal: e.target.checked })}
            />
            <span>
              Allow sideways with signal <span className="cursor-help text-slate-400">ⓘ</span>
            </span>
          </label>
        </div>
        <div className="flex flex-wrap gap-2 border-t border-slate-200/60 pt-2 dark:border-slate-600/40">
          <label className="flex flex-col gap-0.5 text-[10px] text-slate-600 dark:text-slate-400" title={T.btcBlockMode}>
            <span className="inline-flex items-center gap-0.5">
              BTC mode
              <span className="cursor-help text-[9px] text-slate-400" title={T.btcBlockMode}>
                ⓘ
              </span>
            </span>
            <select
              className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
              value={md.btcBlockMode}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "BLOCK" || v === "PENALTY") onPatch({ btcBlockMode: v });
              }}
            >
              <option value="BLOCK">BLOCK</option>
              <option value="PENALTY">PENALTY</option>
            </select>
          </label>
          <MdNumField k="btcMinAdx" label="BTC min ADX" value={num("btcMinAdx", D.btcMinAdx)} onPatch={onPatch} min={0} max={60} />
          <MdNumField
            k="btcFilterPenalty"
            label="BTC penalty"
            value={num("btcFilterPenalty", D.btcFilterPenalty)}
            onPatch={onPatch}
            min={0}
            max={100}
          />
          <label className="flex flex-col gap-0.5 text-[10px] text-slate-600 dark:text-slate-400" title={T.btcSymbol}>
            <span className="inline-flex items-center gap-0.5">
              BTC symbol
              <span className="cursor-help text-[9px] text-slate-400" title={T.btcSymbol}>
                ⓘ
              </span>
            </span>
            <input
              type="text"
              className="rounded border border-slate-300 bg-white px-1 py-0.5 font-mono text-[11px] dark:border-slate-600 dark:bg-slate-900"
              value={String(md.btcSymbol ?? D.btcSymbol)}
              onChange={(e) => onPatch({ btcSymbol: e.target.value.trim() || D.btcSymbol })}
            />
          </label>
        </div>
      </div>

      {md.feeGateEnabled ? (
        <div className="rounded-md border border-amber-200/70 bg-amber-50/60 px-2 py-1.5 dark:border-amber-900/50 dark:bg-amber-950/30">
          <div className="mb-1 text-[10px] font-semibold text-amber-950 dark:text-amber-100">Fee gate — required move %</div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-slate-600 dark:text-slate-400" title={T.feeGateRequiredMoveBasis}>
              Basis{" "}
              <span className="cursor-help text-slate-400" title={T.feeGateRequiredMoveBasis}>
                ⓘ
              </span>
            </span>
            <select
              className="max-w-[280px] rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
              title={T.feeGateRequiredMoveBasis}
              value={md.feeGateRequiredMoveBasis ?? "FEE_BUFFER_SLIP"}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "FEE_BUFFER_SLIP" || v === "T02_ACTIVATION") onPatch({ feeGateRequiredMoveBasis: v });
              }}
            >
              <option value="FEE_BUFFER_SLIP">Round-trip fee % + buffer + slippage bps</option>
              <option value="T02_ACTIVATION">T02 activation (fee-BE + slip + trail buffer)</option>
            </select>
          </div>
          {(md.feeGateRequiredMoveBasis ?? "FEE_BUFFER_SLIP") === "T02_ACTIVATION" ? (
            <div className="mt-2 space-y-1.5">
              <LayerCheck
                id="md-fee-t02-sync"
                label="Sync T02 inputs from bot trailing settings"
                sub="Uses trail fee-BE mult, activation slippage, trail buffer on the server for each open check"
                tipKey="feeGateT02SyncFromBotTrailing"
                checked={md.feeGateT02SyncFromBotTrailing !== false}
                onChange={(on) => onPatch({ feeGateT02SyncFromBotTrailing: on })}
              />
              {md.feeGateT02SyncFromBotTrailing === false ? (
                <div className="grid gap-1.5 sm:grid-cols-3">
                  <MdNumField
                    k="feeGateT02FeeBeMultiplier"
                    label="Fee-BE ×"
                    value={num("feeGateT02FeeBeMultiplier", D.feeGateT02FeeBeMultiplier)}
                    onPatch={onPatch}
                    step={0.05}
                    min={1}
                    max={2}
                  />
                  <MdNumField
                    k="feeGateT02ActivationSlippageFrac"
                    label="Act. slip (frac)"
                    value={num("feeGateT02ActivationSlippageFrac", D.feeGateT02ActivationSlippageFrac)}
                    onPatch={onPatch}
                    step={0.0001}
                    min={0}
                    max={0.05}
                  />
                  <MdNumField
                    k="feeGateT02TrailBufferRate"
                    label="Trail buffer (frac)"
                    value={num("feeGateT02TrailBufferRate", D.feeGateT02TrailBufferRate)}
                    onPatch={onPatch}
                    step={0.0001}
                    min={0}
                    max={0.05}
                  />
                </div>
              ) : null}
              <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
                Pass when estimated favorable move (ATR · room to S/R · bar range) is at least as large as the % move from entry to the
                tiered <span className="font-semibold">T02 activation</span> price — same geometry as Supertrend trailing.
              </p>
            </div>
          ) : (
            <p className="mt-1 text-[10px] leading-snug text-slate-600 dark:text-slate-500">
              Classic mode uses fields below plus bot env where applicable.
            </p>
          )}
          <div className="mt-2 grid gap-1.5 border-t border-amber-200/50 pt-2 dark:border-amber-900/40 sm:grid-cols-3">
            <MdNumField
              k="feeSlippageBps"
              label="Slippage (bps)"
              value={num("feeSlippageBps", D.feeSlippageBps)}
              onPatch={onPatch}
              min={0}
              max={100}
            />
            <MdNumField
              k="feeBufferPct"
              label="Fee buffer %"
              value={num("feeBufferPct", D.feeBufferPct)}
              onPatch={onPatch}
              step={0.01}
              min={0}
              max={5}
              suffix="(e.g. 0.15)"
            />
            <MdNumField
              k="defaultRoundTripFeeRate"
              label="Round-trip fee (frac)"
              value={num("defaultRoundTripFeeRate", D.defaultRoundTripFeeRate)}
              onPatch={onPatch}
              step={0.0001}
              min={0}
              max={0.02}
              suffix="e.g. 0.0016"
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
              tipKey="weightSupertrend"
              checked={Number(md.weightSupertrend) > 0}
              onChange={(on) => setWeight("weightSupertrend", D.weightSupertrend, on)}
            />
            <LayerCheck
              id="md-w-ema"
              label="EMA alignment"
              tipKey="weightEmaAlign"
              checked={Number(md.weightEmaAlign) > 0}
              onChange={(on) => setWeight("weightEmaAlign", D.weightEmaAlign, on)}
            />
            <LayerCheck
              id="md-w-rsi"
              label="RSI bias"
              sub={`Long: RSI≥${Number(md.scoreRsiLongMin ?? D.scoreRsiLongMin)} · Short: RSI≤${Number(md.scoreRsiShortMax ?? D.scoreRsiShortMax)} (score bands)`}
              tipKey="weightRsi"
              checked={Number(md.weightRsi) > 0}
              onChange={(on) => setWeight("weightRsi", D.weightRsi, on)}
            />
            <LayerCheck
              id="md-w-htf"
              label="HTF trend match"
              tipKey="weightHtfMatch"
              checked={Number(md.weightHtfMatch) > 0}
              onChange={(on) => setWeight("weightHtfMatch", D.weightHtfMatch, on)}
            />
          </div>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-3 lg:grid-cols-5">
            <MdNumField
              k="scoreRsiLongMin"
              label="Min RSI (long)"
              value={num("scoreRsiLongMin", D.scoreRsiLongMin)}
              onPatch={onPatch}
              min={0}
              max={100}
            />
            <MdNumField
              k="scoreRsiShortMax"
              label="Max RSI (short)"
              value={num("scoreRsiShortMax", D.scoreRsiShortMax)}
              onPatch={onPatch}
              min={0}
              max={100}
            />
            <MdNumField k="scoreThreshold" label="Pass total ≥" value={num("scoreThreshold", D.scoreThreshold)} onPatch={onPatch} min={0} max={20} />
            <MdNumField
              k="penaltyWeakTrend"
              label="Pen. weak trend"
              value={num("penaltyWeakTrend", D.penaltyWeakTrend)}
              onPatch={onPatch}
              min={0}
              max={50}
            />
            <MdNumField
              k="penaltyOverextension"
              label="Pen. overextension"
              value={num("penaltyOverextension", D.penaltyOverextension)}
              onPatch={onPatch}
              min={0}
              max={50}
            />
          </div>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
            <MdNumField k="weightSupertrend" label="Points · Supertrend" value={num("weightSupertrend", D.weightSupertrend)} onPatch={onPatch} min={0} max={20} />
            <MdNumField k="weightEmaAlign" label="Points · EMA" value={num("weightEmaAlign", D.weightEmaAlign)} onPatch={onPatch} min={0} max={20} />
            <MdNumField k="weightRsi" label="Points · RSI" value={num("weightRsi", D.weightRsi)} onPatch={onPatch} min={0} max={20} />
            <MdNumField k="weightHtfMatch" label="Points · HTF" value={num("weightHtfMatch", D.weightHtfMatch)} onPatch={onPatch} min={0} max={20} />
          </div>
          <p className="mt-1 text-[10px] leading-snug text-slate-500 dark:text-slate-500">
            Default pass total matches typical LTF-only max (6). With HTF on and HTF weight &gt; 0, HTF must align even if the numeric total
            clears the threshold. Set any point weight to 0 to disable that line (same as unchecking). Checkboxes snap weights to package defaults when toggled.
          </p>
        </div>
      ) : null}

      <div className="space-y-1.5 rounded-md border border-slate-200/80 bg-slate-50/80 px-2 py-1.5 dark:border-slate-600/50 dark:bg-slate-900/40">
        <div className="text-[10px] font-semibold text-violet-900 dark:text-violet-100" title={T.entryMode}>
          Entry timing <span className="cursor-help text-[9px] text-slate-400">ⓘ</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-slate-600 dark:text-slate-400">Mode</span>
          <select
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            title={T.entryMode}
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
          <MdNumField
            k="pullbackAtrMult"
            label="Pullback ATR ×"
            value={num("pullbackAtrMult", D.pullbackAtrMult)}
            onPatch={onPatch}
            step={0.05}
            min={0.05}
            max={3}
          />
        </div>
        <p className="text-[10px] leading-snug text-slate-500 dark:text-slate-500">
          Pullback / breakout use distance to EMA vs an ATR-scaled band; not the separate chart breakout-confirm flag.
        </p>
      </div>

      {md.htfEnabled ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-slate-600 dark:text-slate-400" title={T.htfTimeframe}>
            HTF timeframe ⓘ
          </span>
          <select
            className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[11px] text-slate-900 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-100"
            title={T.htfTimeframe}
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
