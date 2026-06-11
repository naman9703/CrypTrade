import { intradayGateTogglePatch, type IntradayGateUiKey } from "../lib/intradayGatesUi";
import {
  SMC_ICT_GAP_ROWS,
  smcGapSupportLabel,
  smcSweepStrictGateWarning,
} from "../lib/smcIctGapGuide";
import { useGuardedCheckbox } from "./useGuardedCheckbox";
import { useState } from "react";
import { RangeSliderReleaseCommit } from "./RangeSliderReleaseCommit";

export const INTRADAY_GATE_KEYS = [
  ["intradayGateLiquidity", "Liquidity sweep + reclaim", "liq_sweep scoring"],
  ["intradayGateSession", "Session S/R", "PDH/PDL + Asian range reclaim"],
  ["intradayGateInstitutionalSr", "Institutional S/R (A+)", "HTF zone + sweep + BOS + confirm + volume"],
  ["intradayGateSmcIct", "SMC / ICT", "ICT 2022: sweep → MSS → FVG/OB retrace entry"],
  ["intradayGateFib", "Fibonacci", "Swing fib proximity"],
  ["intradayGateVp", "Volume profile filter", "POC/VA/HVN scoring (not standalone VP strategy)"],
  ["intradayGateOrderFlow", "Order flow", "Layer 3: absorption + stacked delta + CVD div at key levels (live aggTrade / backtest taker-buy)"],
  ["intradayGateHtfRegime", "HTF + regime", "1h EMA trend, chop filter, learned vetoes"],
] as const;

export type IntradayGateKey = (typeof INTRADAY_GATE_KEYS)[number][0];

type GateCfg = Record<IntradayGateKey, boolean>;

export type IntradayLiqExitCfg = {
  intradayLiqTp1Enabled?: boolean;
  intradayLiqTp2Enabled?: boolean;
  intradayLiqBreakevenAfterPartial?: boolean;
  intradayLiqMinRr?: number;
  /** Cap TP2 at N×R when opposing pool is farther (0 = uncapped PDH/PDL). */
  intradayLiqMaxTpRr?: number;
  /** Closed bars before `time_stop` (0 = disabled). On 15m, 48 ≈ 12 hours. */
  intradayLiqMaxHoldBars?: number;
};

export type InstitutionalSrCfg = {
  intradaySrAPlusMode?: boolean;
  intradaySrMinVolRatio?: number;
  intradaySrMinHtfSep?: number;
  intradaySrZoneWidthPct?: number;
  intradaySrBosMaxBarsAfterReclaim?: number;
  intradaySrMinConfirmWick?: number;
  intradayLiqMinSweepExtensionPct?: number;
};

function LiquidityExitStages({
  liq,
  onStagePatch,
}: {
  liq: IntradayLiqExitCfg;
  onStagePatch: (patch: Record<string, unknown>) => void;
}) {
  const minRr = Math.max(0, Math.min(5, Number(liq.intradayLiqMinRr ?? 1.5)));
  const rrUnits = Math.round(minRr * 100);
  const maxTpRr = Math.max(0, Math.min(20, Number(liq.intradayLiqMaxTpRr ?? 5)));
  const maxTpRrUnits = Math.round(maxTpRr * 100);

  return (
    <div className="ml-5 mt-1.5 space-y-1.5 border-l-2 border-amber-700/25 pl-2.5 dark:border-amber-400/20">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-amber-900/90 dark:text-amber-200/90">
        Exit stages
      </div>
      <p className="text-[10px] leading-snug text-slate-500 dark:text-slate-500">
        Uncheck to disable a leg. Min R:R filters setups at signal (TP2 distance ÷ SL).
      </p>
      {(
        [
          ["intradayLiqTp1Enabled", "TP1 — partial @ 1R", "intradayLiqPartialTp"] as const,
          ["intradayLiqTp2Enabled", "TP2 — opposing session liquidity", null] as const,
          [
            "intradayLiqBreakevenAfterPartial",
            "BE — breakeven at 1R (after TP1 partial, or at 1R if TP1 off)",
            null,
          ] as const,
        ] as const
      ).map(([key, label, legacyKey]) => (
        <label key={key} className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={liq[key] !== false}
            onChange={(e) => {
              const on = e.currentTarget.checked;
              const patch: Record<string, boolean> = { [key]: on };
              if (legacyKey) patch[legacyKey] = on;
              onStagePatch(patch);
            }}
          />
          <span className="text-[11px] text-slate-700 dark:text-slate-300">{label}</span>
        </label>
      ))}
      <label className="mt-1 block text-[10px] text-slate-600 dark:text-slate-400">
        <span className="font-semibold text-slate-700 dark:text-slate-300">Min R:R</span>
        <span className="ml-1 font-mono text-amber-900 dark:text-amber-100">{minRr.toFixed(2)}</span>
        <span className="ml-1 text-slate-500">(0 = off)</span>
        <RangeSliderReleaseCommit
          className="mt-1 block w-full accent-amber-600"
          min={0}
          max={500}
          step={5}
          value={rrUnits}
          aria-label="Liquidity min risk reward"
          onCommit={(u) => {
            const next = Math.max(0, Math.min(5, u / 100));
            onStagePatch({ intradayLiqMinRr: next });
          }}
        />
      </label>
      <label className="mt-1 block text-[10px] text-slate-600 dark:text-slate-400">
        <span className="font-semibold text-slate-700 dark:text-slate-300">Max TP R:R</span>
        <span className="ml-1 font-mono text-amber-900 dark:text-amber-100">
          {maxTpRr > 0 ? maxTpRr.toFixed(2) : "off"}
        </span>
        <span className="ml-1 text-slate-500">(0 = full opposing pool)</span>
        <RangeSliderReleaseCommit
          className="mt-1 block w-full accent-amber-600"
          min={0}
          max={2000}
          step={5}
          value={maxTpRrUnits}
          aria-label="Liquidity max TP risk reward cap"
          onCommit={(u) => {
            const next = Math.max(0, Math.min(20, u / 100));
            onStagePatch({ intradayLiqMaxTpRr: next });
          }}
        />
        <span className="mt-0.5 block text-[10px] text-slate-500">
          TP2 = min(PDH/PDL, entry ± this × SL distance). Lower = closer target; 0 = no LIQ cap.
        </span>
      </label>
      <label className="mt-1 block text-[10px] text-slate-600 dark:text-slate-400">
        <span className="font-semibold text-slate-700 dark:text-slate-300">Max hold (bars)</span>
        <span className="ml-1 font-mono text-amber-900 dark:text-amber-100">
          {Math.max(0, Math.min(2000, Math.round(Number(liq.intradayLiqMaxHoldBars ?? 48))))}
        </span>
        <span className="ml-1 text-slate-500">(0 = no time_stop)</span>
        <RangeSliderReleaseCommit
          className="mt-1 block w-full accent-amber-600"
          min={0}
          max={200}
          step={1}
          value={Math.max(0, Math.min(200, Math.round(Number(liq.intradayLiqMaxHoldBars ?? 48))))}
          aria-label="Liquidity max hold bars before time stop"
          onCommit={(bars) => {
            onStagePatch({ intradayLiqMaxHoldBars: Math.max(0, Math.min(2000, Math.round(bars))) });
          }}
        />
        <span className="mt-0.5 block text-[10px] text-slate-500">
          Forces exit as <span className="font-mono">time_stop</span> if SL/TP not hit — e.g. 48 on 15m ≈ 12h.
        </span>
      </label>
    </div>
  );
}

function SmcBoolCheckbox({
  cfgKey,
  label,
  serverChecked,
  onStagePatch,
}: {
  cfgKey:
    | "intradaySmcRequireMss"
    | "intradaySmcRequireRetrace"
    | "intradaySmcRequireHtfBias"
    | "intradaySmcRequireChoch"
    | "intradaySmcRequireBos"
    | "intradaySmcRequireConfirm"
    | "intradaySmcRequireFvgRetrace"
    | "intradaySmcRequirePremiumDiscount"
    | "intradaySmcUseOrderFlow";
  label: string;
  serverChecked: boolean;
  onStagePatch: (patch: Record<string, unknown>) => void;
}) {
  const [checked, setChecked] = useGuardedCheckbox(serverChecked);
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[11px]">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          const on = e.currentTarget.checked;
          setChecked(on);
          onStagePatch({ [cfgKey]: on });
        }}
      />
      <span>{label}</span>
    </label>
  );
}

function SmcIctGapTable() {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded border border-violet-200/80 bg-violet-50/50 dark:border-violet-800/50 dark:bg-violet-950/20">
      <button
        type="button"
        className="flex w-full items-center justify-between px-2 py-1 text-left text-[10px] font-medium text-violet-900 dark:text-violet-100"
        onClick={() => setOpen((v) => !v)}
      >
        <span>Sweep preset vs ideal ICT 2022 — step-by-step gap</span>
        <span className="font-mono text-violet-600 dark:text-violet-300">{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="max-h-56 overflow-auto border-t border-violet-200/60 px-1 py-1 dark:border-violet-800/40">
          <table className="w-full border-collapse text-[9px] leading-tight text-slate-600 dark:text-slate-400">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="px-1 py-0.5 font-semibold">#</th>
                <th className="px-1 py-0.5 font-semibold">Step</th>
                <th className="px-1 py-0.5 font-semibold">Ideal ICT</th>
                <th className="px-1 py-0.5 font-semibold">Sweep preset</th>
                <th className="px-1 py-0.5 font-semibold">Code</th>
              </tr>
            </thead>
            <tbody>
              {SMC_ICT_GAP_ROWS.map((row) => (
                <tr key={row.step} className="border-t border-violet-100/80 dark:border-violet-900/40">
                  <td className="px-1 py-0.5 font-mono">{row.step}</td>
                  <td className="px-1 py-0.5 font-medium text-slate-700 dark:text-slate-300">{row.label}</td>
                  <td className="px-1 py-0.5">{row.ideal}</td>
                  <td className="px-1 py-0.5">{row.sweep}</td>
                  <td className="px-1 py-0.5 whitespace-nowrap">{smcGapSupportLabel(row.codeSupport)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function SmcIctControls({
  smc,
  onStagePatch,
}: {
  smc: Record<string, unknown>;
  onStagePatch: (patch: Record<string, unknown>) => void;
}) {
  const kz = String(smc.intradaySmcKillzoneMode ?? "LONDON_NY");
  const minAdx = Math.max(0, Math.min(100, Math.round(Number(smc.intradaySmcMinAdx ?? 18))));
  const minRr = Math.max(0, Math.min(10, Number(smc.intradaySmcMinRr ?? 2)));
  const htf = String(smc.intradaySmcHtfStrictness ?? "either").toLowerCase();
  const strictWarning = smcSweepStrictGateWarning(smc);
  return (
    <div className="ml-5 mt-1.5 space-y-2 border-l-2 border-violet-700/30 pl-2.5 dark:border-violet-400/25">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-violet-900/90 dark:text-violet-200/90">
        ICT 2022 model
      </div>
      <p className="text-[10px] leading-snug text-slate-500">
        <b>Sweep</b> = tuned liquidity reclaim (~69 trades Jan–May 2026). <b>Full</b> = textbook sequence
        (CHoCH → MSS → retrace). Use presets <b>BNB 15m SMC Sweep</b> vs <b>SMC ICT Full</b>.
      </p>
      <SmcIctGapTable />
      {strictWarning ? (
        <p className="rounded border border-amber-300/80 bg-amber-50 px-2 py-1 text-[10px] leading-snug text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          {strictWarning}
        </p>
      ) : null}
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        ICT profile
        <select
          className="mt-0.5 block w-full rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900"
          value={String(smc.intradaySmcIctProfile ?? "sweep")}
          onChange={(e) => {
            const v = e.target.value;
            const full = v === "full";
            const balanced = v === "balanced";
            onStagePatch({
              intradaySmcIctProfile: v,
              ...(full
                ? {
                    intradaySmcRequireChoch: true,
                    intradaySmcChochStrict: true,
                    intradaySmcRequireMss: true,
                    intradaySmcRequireBos: true,
                    intradaySmcRequireRetrace: true,
                    intradaySmcRequireFvgRetrace: true,
                    intradaySmcKillzoneMode: "LONDON_NY",
                    intradaySmcHtfBiasMode: "parallel",
                    intradaySmcRequirePremiumDiscount: true,
                  }
                : balanced
                  ? {
                      intradaySmcRequireChoch: true,
                      intradaySmcChochStrict: false,
                      intradaySmcRequireMss: true,
                      intradaySmcRequireBos: false,
                      intradaySmcRequireRetrace: true,
                      intradaySmcRequireFvgRetrace: true,
                      intradaySmcRequirePremiumDiscount: false,
                    }
                  : {
                      intradaySmcRequireChoch: false,
                      intradaySmcChochStrict: false,
                      intradaySmcRequireMss: false,
                      intradaySmcRequireBos: false,
                      intradaySmcRequireRetrace: false,
                      intradaySmcRequireFvgRetrace: false,
                      intradaySmcRequirePremiumDiscount: false,
                    }),
            });
          }}
        >
          <option value="balanced">Balanced (CHoCH + MSS + retrace, ~1/day)</option>
          <option value="full">Full ICT strict (fewest trades)</option>
          <option value="sweep">Sweep reclaim only (highest frequency)</option>
        </select>
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        Pick mode
        <select
          className="mt-0.5 block w-full rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900"
          value={String(smc.intradaySmcPickMode ?? "per_signal")}
          onChange={(e) => {
            onStagePatch({
              intradaySmcPickMode: e.target.value,
              intradaySmcOneTradePerDay: e.target.value !== "per_signal",
            });
          }}
        >
          <option value="daily_sniper">Daily sniper (1 best trade / day)</option>
          <option value="per_signal">Per signal (up to max/day)</option>
        </select>
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        Kill-zone
        <select
          className="mt-0.5 block w-full rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900"
          value={kz}
          onChange={(e) => {
            onStagePatch({ intradaySmcKillzoneMode: e.target.value });
          }}
        >
          {[
            { v: "LONDON_NY", l: "London + NY" },
            { v: "ALL", l: "24/7 (no filter)" },
            { v: "NY", l: "NY" },
            { v: "LONDON", l: "London" },
            { v: "OVERLAP", l: "Overlap" },
            { v: "SILVER_BULLET", l: "Silver Bullet" },
            { v: "ASIA", l: "Asia" },
          ].map(({ v, l }) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        Entry zone
        <select
          className="mt-0.5 block w-full rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900"
          value={String(smc.intradaySmcEntryZoneMode ?? "EITHER")}
          onChange={(e) => {
            onStagePatch({ intradaySmcEntryZoneMode: e.target.value });
          }}
        >
          <option value="EITHER">FVG or OB</option>
          <option value="FVG">FVG only</option>
          <option value="OB">OB only</option>
        </select>
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        HTF bias strictness
        <select
          className="mt-0.5 block w-full rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900"
          value={htf}
          onChange={(e) => {
            onStagePatch({ intradaySmcHtfStrictness: e.target.value });
          }}
        >
          <option value="either">Either (4h or 1h)</option>
          <option value="4h">4h only</option>
          <option value="1h">1h only</option>
          <option value="both">Both 4h + 1h</option>
        </select>
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        HTF bias mode
        <select
          className="mt-0.5 block w-full rounded border border-slate-200 bg-white px-1 py-0.5 text-[11px] dark:border-slate-700 dark:bg-slate-900"
          value={String(smc.intradaySmcHtfBiasMode ?? "parallel")}
          onChange={(e) => {
            onStagePatch({ intradaySmcHtfBiasMode: e.target.value });
          }}
        >
          <option value="parallel">Parallel (EMA + 4H structure)</option>
          <option value="ema">EMA only</option>
          <option value="structure">4H structure only</option>
        </select>
      </label>
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequireChoch"
        label="Require CHoCH after sweep"
        serverChecked={smc.intradaySmcRequireChoch === true}
        onStagePatch={onStagePatch}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequireMss"
        label="Require MSS (BOS + displacement)"
        serverChecked={smc.intradaySmcRequireMss === true}
        onStagePatch={onStagePatch}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequireBos"
        label="Require BOS (when MSS off)"
        serverChecked={smc.intradaySmcRequireBos === true}
        onStagePatch={onStagePatch}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequireRetrace"
        label="Require retrace into FVG/OB"
        serverChecked={smc.intradaySmcRequireRetrace === true}
        onStagePatch={onStagePatch}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequireHtfBias"
        label="Require HTF bias alignment"
        serverChecked={smc.intradaySmcRequireHtfBias !== false}
        onStagePatch={onStagePatch}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequirePremiumDiscount"
        label="Require premium/discount (dealing range)"
        serverChecked={smc.intradaySmcRequirePremiumDiscount === true}
        onStagePatch={onStagePatch}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcUseOrderFlow"
        label="Require order-flow confirmation at FVG/OB entry"
        serverChecked={smc.intradaySmcUseOrderFlow === true}
        onStagePatch={onStagePatch}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequireConfirm"
        label="Require entry-bar confirm candle (extra)"
        serverChecked={smc.intradaySmcRequireConfirm === true}
        onStagePatch={onStagePatch}
      />
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        <span className="font-semibold text-slate-700 dark:text-slate-300">Min ADX</span>
        <span className="ml-1 font-mono text-violet-900 dark:text-violet-100">{minAdx}</span>
        <span className="ml-1 text-slate-500">(0 = off)</span>
        <RangeSliderReleaseCommit
          className="mt-1 block w-full accent-violet-600"
          min={0}
          max={50}
          step={1}
          value={minAdx}
          aria-label="SMC min ADX"
          onCommit={(v) => {
            onStagePatch({ intradaySmcMinAdx: v });
          }}
        />
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        <span className="font-semibold text-slate-700 dark:text-slate-300">Min R:R</span>
        <span className="ml-1 font-mono text-violet-900 dark:text-violet-100">{minRr.toFixed(2)}</span>
        <span className="ml-1 text-slate-500">(0 = off)</span>
        <RangeSliderReleaseCommit
          className="mt-1 block w-full accent-violet-600"
          min={0}
          max={500}
          step={5}
          value={Math.round(minRr * 100)}
          aria-label="SMC min risk reward"
          onCommit={(v) => {
            const next = Math.max(0, Math.min(5, v / 100));
            onStagePatch({ intradaySmcMinRr: next });
          }}
        />
      </label>
    </div>
  );
}

function InstitutionalSrControls({
  sr,
  onStagePatch,
}: {
  sr: InstitutionalSrCfg;
  onStagePatch: (patch: Record<string, unknown>) => void;
}) {
  const extPct = Math.max(0, Math.min(2, Number(sr.intradayLiqMinSweepExtensionPct ?? 0.004) * 100));
  const volR = Math.max(0, Math.min(3, Number(sr.intradaySrMinVolRatio ?? 1.2)));
  const bosBars = Math.max(0, Math.min(10, Number(sr.intradaySrBosMaxBarsAfterReclaim ?? 3)));

  return (
    <div className="ml-5 mt-1.5 space-y-2 border-l-2 border-emerald-700/30 pl-2.5 dark:border-emerald-400/25">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-emerald-900/90 dark:text-emerald-200/90">
        A+ checklist
      </div>
      <p className="text-[10px] leading-snug text-slate-500">
        HTF trend + daily/weekly zone + liquidity sweep + BOS + confirmation + volume. Enable liquidity + session + HTF
        gates for full stack.
      </p>
      <label className="flex cursor-pointer items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          checked={sr.intradaySrAPlusMode === true}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            onStagePatch({ intradaySrAPlusMode: on, intradayGateInstitutionalSr: on });
          }}
        />
        <span>Strict A+ mode (orchestrator)</span>
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        Min sweep extension % <span className="font-mono">{extPct.toFixed(2)}</span>
        <RangeSliderReleaseCommit
          className="mt-1 block w-full accent-emerald-600"
          min={0}
          max={200}
          step={5}
          value={Math.round(extPct * 100) / 100}
          aria-label="Min sweep extension percent"
          onCommit={(v) => {
            onStagePatch({ intradayLiqMinSweepExtensionPct: v / 100 });
          }}
        />
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        Min volume ratio <span className="font-mono">{volR.toFixed(2)}×</span>
        <RangeSliderReleaseCommit
          className="mt-1 block w-full accent-emerald-600"
          min={0}
          max={300}
          step={5}
          value={Math.round(volR * 100)}
          aria-label="Min volume ratio"
          onCommit={(v) => {
            onStagePatch({ intradaySrMinVolRatio: v / 100 });
          }}
        />
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        BOS max bars after reclaim <span className="font-mono">{bosBars}</span>
        <RangeSliderReleaseCommit
          className="mt-1 block w-full accent-emerald-600"
          min={0}
          max={10}
          step={1}
          value={bosBars}
          aria-label="BOS max bars after reclaim"
          onCommit={(n) => {
            onStagePatch({ intradaySrBosMaxBarsAfterReclaim: n });
          }}
        />
      </label>
    </div>
  );
}

function OrderFlowControls({
  of,
  onStagePatch,
}: {
  of: Record<string, unknown>;
  onStagePatch: (patch: Record<string, unknown>) => void;
}) {
  const kz = String(of.intradayOfKillzoneMode ?? "LONDON_NY");
  const confMode = String(of.intradayOfConfluenceMode ?? "full");
  const minConf = Math.max(1, Math.min(4, Math.round(Number(of.intradayOfMinConfluence ?? 2))));
  const stackBars = Math.max(2, Math.min(8, Math.round(Number(of.intradayOfMinStackBars ?? 3))));

  return (
    <div className="ml-5 mt-1.5 space-y-2 border-l-2 border-sky-700/30 pl-2.5 dark:border-sky-400/25">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-sky-900/90 dark:text-sky-200/90">
        Order flow (Layer 3)
      </div>
      <p className="text-[10px] leading-snug text-slate-500">
        Guide model: premium/discount → key level → approach CVD → absorption/stack → confirmation bar → enter next bar
        open. Full mode skips CVD-only noise; layer3 is for SMC composite gates.
      </p>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        Confluence mode
        <select
          className="mt-0.5 block w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
          value={confMode}
          onChange={(e) => onStagePatch({ intradayOfConfluenceMode: e.currentTarget.value })}
        >
          <option value="full">Full (absorption + CVD + confirm + key)</option>
          <option value="layer3">Layer 3 (confirm + key + absorption — composite)</option>
          <option value="research">Research only (not for live)</option>
        </select>
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        Killzone
        <select
          className="mt-0.5 block w-full rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] dark:border-slate-600 dark:bg-slate-900"
          value={kz}
          onChange={(e) => onStagePatch({ intradayOfKillzoneMode: e.currentTarget.value })}
        >
          {["LONDON", "NY", "LONDON_NY", "OVERLAP"].map((m) => (
            <option key={m} value={m}>
              {m.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </label>
      {(
        [
          ["intradayOfRequireKeyLevel", "Require key level (PDH/PDL/POC/VAH/VAL/VWAP)", true],
          ["intradayOfRequirePremiumDiscount", "Premium/discount filter (longs ≤ VAL, shorts ≥ VAH)", true],
          ["intradayOfRequireConfirmation", "Wait for confirmation bar after absorption", true],
          ["intradayOfUseOrderBook", "Use live order book pressure (USD-M perps)", true],
          ["intradayOfAllowProxy", "Allow OHLCV proxy fallback (Tier C — not footprint)", false],
          ["intradayOfVetoMode", "Hard veto in composite mode (off = score contribution only)", false],
          ["intradayOfTp1Enabled", "Partial TP at 1R", true],
          ["intradayOfTp2Enabled", "Runner TP at opposing VP level", true],
          ["intradayOfBreakevenAfterPartial", "Move SL to breakeven after partial", true],
          ["intradayOfExitOnDeltaAgainst", "Exit on 2 bars delta against position", true],
        ] as const
      ).map(([key, label, defaultOn]) => (
        <label key={key} className="flex cursor-pointer items-start gap-2 text-[11px]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={defaultOn ? of[key] !== false : of[key] === true}
            onChange={(e) => onStagePatch({ [key]: e.currentTarget.checked })}
          />
          <span>{label}</span>
        </label>
      ))}
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        Min pattern confluence <span className="font-mono">{minConf}</span>
        <RangeSliderReleaseCommit
          className="mt-1 block w-full accent-sky-600"
          min={1}
          max={4}
          step={1}
          value={minConf}
          aria-label="Order flow min confluence"
          onCommit={(v) => onStagePatch({ intradayOfMinConfluence: v })}
        />
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        Stacked delta bars <span className="font-mono">{stackBars}</span>
        <RangeSliderReleaseCommit
          className="mt-1 block w-full accent-sky-600"
          min={2}
          max={8}
          step={1}
          value={stackBars}
          aria-label="Stacked delta bars"
          onCommit={(v) => onStagePatch({ intradayOfMinStackBars: v })}
        />
      </label>
    </div>
  );
}

function GateCheckboxRow({
  gateKey,
  title,
  hint,
  cfg,
  liq,
  sr,
  smc,
  of,
  onStagePatch,
}: {
  gateKey: IntradayGateKey;
  title: string;
  hint: string;
  cfg: GateCfg;
  liq: IntradayLiqExitCfg;
  sr?: InstitutionalSrCfg;
  smc?: Record<string, unknown>;
  of?: Record<string, unknown>;
  onStagePatch: (patch: Record<string, unknown>) => void;
}) {
  const [checked, setChecked] = useGuardedCheckbox(cfg[gateKey]);
  return (
    <div>
      <label className="flex cursor-pointer items-start gap-2">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={checked}
          onChange={(e) => {
            const on = e.currentTarget.checked;
            setChecked(on);
            const patch = intradayGateTogglePatch(gateKey as IntradayGateUiKey, on);
            onStagePatch(patch);
          }}
        />
        <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
          <span className="font-semibold text-slate-800 dark:text-slate-200">{title}</span>
          <span className="mt-0.5 block text-[10px] text-slate-500">{hint}</span>
        </span>
      </label>
      {gateKey === "intradayGateLiquidity" ? <LiquidityExitStages liq={liq} onStagePatch={onStagePatch} /> : null}
      {gateKey === "intradayGateInstitutionalSr" && sr ? (
        <InstitutionalSrControls sr={sr} onStagePatch={onStagePatch} />
      ) : null}
      {gateKey === "intradayGateSmcIct" && smc ? <SmcIctControls smc={smc} onStagePatch={onStagePatch} /> : null}
      {gateKey === "intradayGateOrderFlow" && of ? (
        <OrderFlowControls of={of} onStagePatch={onStagePatch} />
      ) : null}
    </div>
  );
}

export function IntradayGatesPanel({
  cfg,
  liq,
  sr,
  smc,
  of,
  onStagePatch,
  id,
}: {
  cfg: GateCfg;
  liq: IntradayLiqExitCfg;
  sr?: InstitutionalSrCfg;
  smc?: Record<string, unknown>;
  of?: Record<string, unknown>;
  onStagePatch: (patch: Record<string, unknown>) => void;
  id?: string;
}) {
  return (
    <div
      id={id}
      className="mt-3 space-y-2 rounded-lg border border-amber-800/35 bg-white/85 p-2 dark:border-amber-400/25 dark:bg-slate-950/50"
    >
      <div className="text-[11px] font-semibold text-amber-900 dark:text-amber-100">
        Intraday gates (8 techniques)
      </div>
      <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-500">
        For <span className="font-semibold">SR_INTRADAY</span> / Intraday Pro. Changes apply in the UI immediately and
        persist when you click <span className="font-semibold">Save</span> on the strategy bar.
      </p>
      {INTRADAY_GATE_KEYS.map(([key, title, hint]) => (
        <GateCheckboxRow
          key={key}
          gateKey={key}
          title={title}
          hint={hint}
          cfg={cfg}
          liq={liq}
          sr={sr}
          smc={smc}
          of={of}
          onStagePatch={onStagePatch}
        />
      ))}
    </div>
  );
}
