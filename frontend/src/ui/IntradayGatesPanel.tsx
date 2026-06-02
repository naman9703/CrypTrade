import { api } from "../api/client";
import { deferTask } from "../lib/deferTask";
import { intradayGateTogglePatch, type IntradayGateUiKey } from "../lib/intradayGatesUi";
import {
  SMC_ICT_GAP_ROWS,
  smcGapSupportLabel,
  smcSweepStrictGateWarning,
} from "../lib/smcIctGapGuide";
import { useGuardedCheckbox } from "./useGuardedCheckbox";
import { useState } from "react";

export const INTRADAY_GATE_KEYS = [
  ["intradayGateLiquidity", "Liquidity sweep + reclaim", "liq_sweep scoring"],
  ["intradayGateSession", "Session S/R", "PDH/PDL + Asian range reclaim"],
  ["intradayGateInstitutionalSr", "Institutional S/R (A+)", "HTF zone + sweep + BOS + confirm + volume"],
  ["intradayGateSmcIct", "SMC / ICT", "ICT 2022: sweep → MSS → FVG/OB retrace entry"],
  ["intradayGateFib", "Fibonacci", "Swing fib proximity"],
  ["intradayGateVp", "Volume profile filter", "POC/VA/HVN scoring (not standalone VP strategy)"],
  ["intradayGateOrderFlow", "Order flow", "CVD + delta imbalance"],
  ["intradayGateHtfRegime", "HTF + regime", "1h EMA trend, chop filter, learned vetoes"],
] as const;

export type IntradayGateKey = (typeof INTRADAY_GATE_KEYS)[number][0];

type GateCfg = Record<IntradayGateKey, boolean>;

export type IntradayLiqExitCfg = {
  intradayLiqTp1Enabled?: boolean;
  intradayLiqTp2Enabled?: boolean;
  intradayLiqBreakevenAfterPartial?: boolean;
  intradayLiqMinRr?: number;
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

function patchBot(patch: Record<string, unknown>, pushLog: (msg: { level: string; msg: string }) => void, okMsg: string) {
  deferTask(() => {
    void api
      .botConfig(patch)
      .then(() => pushLog({ level: "info", msg: okMsg }))
      .catch(() => pushLog({ level: "error", msg: "Failed to update bot config" }));
  });
}

function LiquidityExitStages({
  liq,
  pushLog,
}: {
  liq: IntradayLiqExitCfg;
  pushLog: (msg: { level: string; msg: string }) => void;
}) {
  const minRr = Math.max(0, Math.min(5, Number(liq.intradayLiqMinRr ?? 1.5)));
  const rrUnits = Math.round(minRr * 100);

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
              patchBot(patch, pushLog, on ? `${label} ON` : `${label} OFF`);
            }}
          />
          <span className="text-[11px] text-slate-700 dark:text-slate-300">{label}</span>
        </label>
      ))}
      <label className="mt-1 block text-[10px] text-slate-600 dark:text-slate-400">
        <span className="font-semibold text-slate-700 dark:text-slate-300">Min R:R</span>
        <span className="ml-1 font-mono text-amber-900 dark:text-amber-100">{minRr.toFixed(2)}</span>
        <span className="ml-1 text-slate-500">(0 = off)</span>
        <input
          type="range"
          min={0}
          max={500}
          step={5}
          value={rrUnits}
          className="mt-1 block w-full accent-amber-600"
          onChange={(e) => {
            const u = Number(e.currentTarget.value);
            const next = Math.max(0, Math.min(5, u / 100));
            patchBot({ intradayLiqMinRr: next }, pushLog, `Liquidity min R:R ${next.toFixed(2)}`);
          }}
        />
      </label>
    </div>
  );
}

function SmcBoolCheckbox({
  cfgKey,
  label,
  serverChecked,
  pushLog,
}: {
  cfgKey:
    | "intradaySmcRequireMss"
    | "intradaySmcRequireRetrace"
    | "intradaySmcRequireHtfBias"
    | "intradaySmcRequireChoch"
    | "intradaySmcRequireBos"
    | "intradaySmcRequireConfirm"
    | "intradaySmcRequireFvgRetrace";
  label: string;
  serverChecked: boolean;
  pushLog: (msg: { level: string; msg: string }) => void;
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
          patchBot({ [cfgKey]: on }, pushLog, `${label} ${on ? "ON" : "OFF"}`);
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
  pushLog,
}: {
  smc: Record<string, unknown>;
  pushLog: (msg: { level: string; msg: string }) => void;
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
            patchBot(
              {
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
              },
              pushLog,
              `ICT profile ${v}`,
            );
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
            const v = e.target.value;
            patchBot({ intradaySmcPickMode: e.target.value, intradaySmcOneTradePerDay: e.target.value !== "per_signal" }, pushLog, `Pick mode ${e.target.value}`);
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
            patchBot({ intradaySmcKillzoneMode: e.target.value }, pushLog, `Kill-zone ${e.target.value}`);
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
            patchBot({ intradaySmcEntryZoneMode: e.target.value }, pushLog, `Entry zone ${e.target.value}`);
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
            patchBot({ intradaySmcHtfStrictness: e.target.value }, pushLog, `HTF strictness ${e.target.value}`);
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
            patchBot({ intradaySmcHtfBiasMode: e.target.value }, pushLog, `HTF bias mode ${e.target.value}`);
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
        pushLog={pushLog}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequireMss"
        label="Require MSS (BOS + displacement)"
        serverChecked={smc.intradaySmcRequireMss === true}
        pushLog={pushLog}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequireBos"
        label="Require BOS (when MSS off)"
        serverChecked={smc.intradaySmcRequireBos === true}
        pushLog={pushLog}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequireRetrace"
        label="Require retrace into FVG/OB"
        serverChecked={smc.intradaySmcRequireRetrace === true}
        pushLog={pushLog}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequireHtfBias"
        label="Require HTF bias alignment"
        serverChecked={smc.intradaySmcRequireHtfBias !== false}
        pushLog={pushLog}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequirePremiumDiscount"
        label="Require premium/discount (dealing range)"
        serverChecked={smc.intradaySmcRequirePremiumDiscount === true}
        pushLog={pushLog}
      />
      <SmcBoolCheckbox
        cfgKey="intradaySmcRequireConfirm"
        label="Require entry-bar confirm candle (extra)"
        serverChecked={smc.intradaySmcRequireConfirm === true}
        pushLog={pushLog}
      />
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        <span className="font-semibold text-slate-700 dark:text-slate-300">Min ADX</span>
        <span className="ml-1 font-mono text-violet-900 dark:text-violet-100">{minAdx}</span>
        <span className="ml-1 text-slate-500">(0 = off)</span>
        <input
          type="range"
          min={0}
          max={50}
          step={1}
          value={minAdx}
          className="mt-1 block w-full accent-violet-600"
          onChange={(e) => {
            const v = Number(e.currentTarget.value);
            patchBot({ intradaySmcMinAdx: v }, pushLog, `SMC min ADX ${v}`);
          }}
        />
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        <span className="font-semibold text-slate-700 dark:text-slate-300">Min R:R</span>
        <span className="ml-1 font-mono text-violet-900 dark:text-violet-100">{minRr.toFixed(2)}</span>
        <span className="ml-1 text-slate-500">(0 = off)</span>
        <input
          type="range"
          min={0}
          max={500}
          step={5}
          value={Math.round(minRr * 100)}
          className="mt-1 block w-full accent-violet-600"
          onChange={(e) => {
            const v = Math.max(0, Math.min(5, Number(e.currentTarget.value) / 100));
            patchBot({ intradaySmcMinRr: v }, pushLog, `SMC min R:R ${v.toFixed(2)}`);
          }}
        />
      </label>
    </div>
  );
}

function InstitutionalSrControls({
  sr,
  pushLog,
}: {
  sr: InstitutionalSrCfg;
  pushLog: (msg: { level: string; msg: string }) => void;
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
            patchBot({ intradaySrAPlusMode: on, intradayGateInstitutionalSr: on }, pushLog, on ? "A+ mode ON" : "A+ mode OFF");
          }}
        />
        <span>Strict A+ mode (orchestrator)</span>
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        Min sweep extension % <span className="font-mono">{extPct.toFixed(2)}</span>
        <input
          type="range"
          min={0}
          max={200}
          step={5}
          value={Math.round(extPct * 100) / 100}
          className="mt-1 block w-full accent-emerald-600"
          onChange={(e) => {
            const pct = Number(e.currentTarget.value) / 100;
            patchBot({ intradayLiqMinSweepExtensionPct: pct }, pushLog, `Min extension ${pct.toFixed(2)}%`);
          }}
        />
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        Min volume ratio <span className="font-mono">{volR.toFixed(2)}×</span>
        <input
          type="range"
          min={0}
          max={300}
          step={5}
          value={Math.round(volR * 100)}
          className="mt-1 block w-full accent-emerald-600"
          onChange={(e) => {
            const v = Number(e.currentTarget.value) / 100;
            patchBot({ intradaySrMinVolRatio: v }, pushLog, `Min vol ratio ${v.toFixed(2)}`);
          }}
        />
      </label>
      <label className="block text-[10px] text-slate-600 dark:text-slate-400">
        BOS max bars after reclaim <span className="font-mono">{bosBars}</span>
        <input
          type="range"
          min={0}
          max={10}
          step={1}
          value={bosBars}
          className="mt-1 block w-full accent-emerald-600"
          onChange={(e) => {
            const n = Number(e.currentTarget.value);
            patchBot({ intradaySrBosMaxBarsAfterReclaim: n }, pushLog, `BOS window ${n} bars`);
          }}
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
  pushLog,
}: {
  gateKey: IntradayGateKey;
  title: string;
  hint: string;
  cfg: GateCfg;
  liq: IntradayLiqExitCfg;
  sr?: InstitutionalSrCfg;
  smc?: Record<string, unknown>;
  pushLog: (msg: { level: string; msg: string }) => void;
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
            deferTask(() => {
              void api
                .botConfig(patch)
                .then(() =>
                  pushLog({
                    level: "info",
                    msg: on ? `${title} ON` : `${title} OFF`,
                  }),
                )
                .catch(() => pushLog({ level: "error", msg: `Failed to update ${title}` }));
            });
          }}
        />
        <span className="min-w-0 flex-1 text-xs leading-snug text-slate-700 dark:text-slate-300">
          <span className="font-semibold text-slate-800 dark:text-slate-200">{title}</span>
          <span className="mt-0.5 block text-[10px] text-slate-500">{hint}</span>
        </span>
      </label>
      {gateKey === "intradayGateLiquidity" ? <LiquidityExitStages liq={liq} pushLog={pushLog} /> : null}
      {gateKey === "intradayGateInstitutionalSr" && sr ? (
        <InstitutionalSrControls sr={sr} pushLog={pushLog} />
      ) : null}
      {gateKey === "intradayGateSmcIct" && smc ? <SmcIctControls smc={smc} pushLog={pushLog} /> : null}
    </div>
  );
}

export function IntradayGatesPanel({
  cfg,
  liq,
  sr,
  smc,
  pushLog,
  id,
}: {
  cfg: GateCfg;
  liq: IntradayLiqExitCfg;
  sr?: InstitutionalSrCfg;
  smc?: Record<string, unknown>;
  pushLog: (msg: { level: string; msg: string }) => void;
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
        For <span className="font-semibold">SR_INTRADAY</span> / Intraday Pro. Preset <b>BNB 15m Institutional A+</b> enables
        the full professional S/R stack. Backtests use these live panel toggles (not only the last saved strategy).
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
          pushLog={pushLog}
        />
      ))}
    </div>
  );
}
