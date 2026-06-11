/**
 * Form to launch a new backtest. Each strategy has one current saved row (`latestVersion`);
 * manual Save in Trading updates that row in place — we backtest that snapshot only (no version picker).
 */
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import type { ApiTradingModeSlug } from "../../lib/tradingModeSlug";
import type { Strategy, StrategyVersion } from "../../types/strategy";
import type { BotInstance } from "../../types/instance";
import { tradingModeToApiModeSlug } from "../../lib/tradingModeSlug";
import {
  instanceOperationalFromSaved,
  mergeCfgForBacktestPreview,
  resolveBacktestStrategyVersion,
} from "../../lib/backtestInstanceConfig";
import { useAppStore } from "../../ws/store";
import { MultiCoinSelector } from "./MultiCoinSelector";

const TIMEFRAMES = ["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"];

const POPULAR_SYMBOLS = [
  "BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT", "XRPUSDT",
  "DOGEUSDT", "ADAUSDT", "LINKUSDT", "AVAXUSDT", "DOTUSDT",
  "MATICUSDT", "LTCUSDT", "UNIUSDT", "ATOMUSDT", "NEARUSDT",
];

/** Extract the symbol universe from a strategy/instance config snapshot. */
function symbolsFromCfg(cfgRaw: unknown): string[] {
  if (!cfgRaw || typeof cfgRaw !== "object") return [];
  const root = cfgRaw as Record<string, unknown>;
  const b = (root.bot && typeof root.bot === "object" ? root.bot : root) as Record<string, unknown>;
  const arr = (b.universeCustomSymbols ?? b.customSymbols ?? []) as unknown[];
  if (!Array.isArray(arr)) return [];
  return arr.map((s) => String(s).toUpperCase()).filter(Boolean);
}

/** Hide legacy auto-snapshot labels in UI; custom labels still show. */
function versionLabelForUi(label: string | null | undefined): string {
  const t = String(label ?? "").trim();
  if (!t) return "";
  if (/saved from config/i.test(t)) return "";
  return ` · ${t}`;
}

type Props = {
  onCreated: (runId: string) => void | Promise<void>;
  onSymbolChange?: (symbol: string) => void;
  onTfChange?: (tf: string) => void;
};

export function NewBacktestForm({ onCreated, onSymbolChange, onTfChange }: Props) {
  const mode = useAppStore((s) => s.mode);
  const slug: ApiTradingModeSlug = tradingModeToApiModeSlug(mode || "PAPER");
  const strategies = useAppStore((s) => s.strategiesByMode[slug] ?? []);
  const instances = useAppStore((s) => s.instancesByMode[slug] ?? []);
  const versionsByStrategyId = useAppStore((s) => s.versionsByStrategyId);
  const activeInstanceId = useAppStore((s) => s.activeInstanceByMode[slug]);
  const fetchStrategies = useAppStore((s) => s.fetchStrategiesForMode);
  const fetchInstances = useAppStore((s) => s.fetchInstancesForMode);
  const fetchVersions = useAppStore((s) => s.fetchVersionsForStrategy);

  const [configSource, setConfigSource] = useState<"instance" | "strategy">("strategy");
  const [instanceId, setInstanceId] = useState<string>("");
  const [strategyId, setStrategyId] = useState<string>("");
  const [versionId, setVersionId] = useState<string>("");
  const [coinMode, setCoinMode] = useState<"single" | "multiple">("single");
  const [symbol, setSymbol] = useState<string>("BTCUSDT");
  const [portfolioSymbols, setPortfolioSymbols] = useState<string[]>([]);
  const [customSymbolMode, setCustomSymbolMode] = useState<boolean>(false);
  const [timeframe, setTimeframe] = useState<string>("15m");
  const [from, setFrom] = useState<string>(() => defaultFromDate());
  const [to, setTo] = useState<string>(() => defaultToDate());
  const [startingUsdt, setStartingUsdt] = useState<number>(10_000);
  const [fullEquityMargin, setFullEquityMargin] = useState<boolean>(false);
  const [walkForwardOn, setWalkForwardOn] = useState<boolean>(false);
  const [trainPct, setTrainPct] = useState<number>(0.7);
  const [slippagePct, setSlippagePct] = useState<number>(0.05);
  const [coveragePct, setCoveragePct] = useState<number | null>(null);
  const [coverageChecking, setCoverageChecking] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void fetchStrategies(slug, { includeArchived: false });
    void fetchInstances(slug);
  }, [slug, fetchStrategies, fetchInstances]);

  useEffect(() => {
    if (instanceId || !instances.length) return;
    const active = activeInstanceId ? instances.find((i) => i.id === activeInstanceId) : null;
    const fallback = active ?? instances.find((i) => i.status === "running") ?? instances[0];
    if (fallback) {
      setInstanceId(fallback.id);
    }
  }, [activeInstanceId, instanceId, instances]);

  useEffect(() => {
    if (configSource === "instance") return;
    if (!strategyId && strategies.length) setStrategyId(strategies[0].id);
  }, [configSource, strategies, strategyId]);

  const selectedInstance = useMemo(
    () => instances.find((i) => i.id === instanceId) ?? null,
    [instances, instanceId],
  );

  const selectedStrategy = useMemo(
    () => {
      if (configSource === "instance" && selectedInstance?.strategyId) {
        return strategies.find((s) => s.id === selectedInstance.strategyId) ?? null;
      }
      return strategies.find((s) => s.id === strategyId) ?? null;
    },
    [configSource, selectedInstance?.strategyId, strategies, strategyId],
  );
  useEffect(() => {
    if (configSource !== "instance" || !selectedInstance?.strategyId) return;
    const list = versionsByStrategyId[selectedInstance.strategyId] ?? [];
    if (!list.some((v) => v.id === selectedInstance.strategyVersionId)) {
      void fetchVersions(selectedInstance.strategyId);
    }
  }, [
    configSource,
    fetchVersions,
    selectedInstance?.strategyId,
    selectedInstance?.strategyVersionId,
    versionsByStrategyId,
  ]);

  const selectedVersion: StrategyVersion | null = useMemo(
    () =>
      resolveBacktestStrategyVersion(
        configSource,
        selectedInstance,
        selectedStrategy,
        versionsByStrategyId,
      ),
    [configSource, selectedInstance, selectedStrategy, versionsByStrategyId],
  );

  const effectiveCfgRaw = useMemo(
    () =>
      mergeCfgForBacktestPreview(
        selectedVersion?.cfgRaw,
        configSource === "instance" ? selectedInstance : null,
        symbol,
        timeframe,
      ),
    [configSource, selectedInstance, selectedVersion?.cfgRaw, symbol, timeframe],
  );
  const backtestEngineBadge = useMemo(() => effectiveEngineKey(effectiveCfgRaw), [effectiveCfgRaw]);
  const requires1hChart =
    backtestEngineBadge === "UNIFIED_ELITE" || backtestEngineBadge === "SUPERTREND_ELITE";

  /** Elite / Unified paths are validated on 1H only — backtest form defaults to 15m otherwise. */
  useEffect(() => {
    if (requires1hChart && timeframe !== "1h") setTimeframe("1h");
  }, [requires1hChart, timeframe]);

  /** Merged, de-duped symbol list: strategy config first, then popular defaults. */
  const availableSymbols = useMemo(() => {
    const fromCfg = symbolsFromCfg(effectiveCfgRaw);
    const merged = [...fromCfg];
    for (const s of POPULAR_SYMBOLS) {
      if (!merged.includes(s)) merged.push(s);
    }
    return merged;
  }, [effectiveCfgRaw]);

  useEffect(() => {
    if (configSource === "instance" && selectedInstance?.strategyVersionId) {
      setVersionId(String(selectedInstance.strategyVersionId));
      return;
    }
    const stratId = strategyId;
    const strat = strategies.find((s) => s.id === stratId) ?? selectedStrategy;
    const vid = strat?.latestVersion?.id;
    if (vid) setVersionId(vid);
    else setVersionId("");
  }, [
    configSource,
    selectedInstance?.strategyId,
    selectedInstance?.strategyVersionId,
    selectedStrategy?.latestVersion?.id,
    strategyId,
    strategies,
  ]);

  useEffect(() => {
    if (configSource !== "instance" || !selectedInstance) return;
    if (selectedInstance.strategyId) setStrategyId(selectedInstance.strategyId);
    const op = selectedInstance.operational;
    if (op?.symbol) setSymbol(String(op.symbol).toUpperCase());
    if (op?.timeframe && TIMEFRAMES.includes(String(op.timeframe))) setTimeframe(String(op.timeframe));
  }, [configSource, selectedInstance?.id]);

  useEffect(() => {
    onSymbolChange?.(symbol);
  }, [symbol, onSymbolChange]);

  // If the current symbol is in the list, exit custom-entry mode automatically
  useEffect(() => {
    if (customSymbolMode && availableSymbols.includes(symbol)) {
      setCustomSymbolMode(false);
    }
  }, [availableSymbols, customSymbolMode, symbol]);

  useEffect(() => {
    onTfChange?.(timeframe);
  }, [timeframe, onTfChange]);

  useEffect(() => {
    if (coinMode === "multiple") {
      setCoveragePct(null);
      setCoverageChecking(false);
      return;
    }
    if (!symbol || !timeframe || !from || !to) return;
    let cancelled = false;
    setCoverageChecking(true);
    const t = setTimeout(() => {
      void api.getDataCoverage({ symbol: symbol.toUpperCase(), timeframe, from, to })
        .then((d) => {
          if (!cancelled) setCoveragePct(d?.coverage?.coveragePct ?? null);
        })
        .catch(() => {
          if (!cancelled) setCoveragePct(null);
        })
        .finally(() => {
          if (!cancelled) setCoverageChecking(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [coinMode, symbol, timeframe, from, to]);

  useEffect(() => {
    if (coinMode !== "multiple") return;
    const fromCfg = symbolsFromCfg(effectiveCfgRaw);
    if (fromCfg.length >= 2 && portfolioSymbols.length === 0) {
      setPortfolioSymbols(fromCfg.slice(0, 10));
    }
  }, [coinMode, effectiveCfgRaw, portfolioSymbols.length]);

  const canSubmit = useMemo(
    () =>
      Boolean(
        versionId &&
          (configSource !== "instance" || effectiveCfgRaw != null) &&
          (configSource !== "instance" || instanceId) &&
          (coinMode === "multiple" ? portfolioSymbols.length >= 2 : symbol) &&
          timeframe &&
          from &&
          to &&
          startingUsdt > 0 &&
          !submitting,
      ),
    [
      coinMode,
      configSource,
      effectiveCfgRaw,
      instanceId,
      portfolioSymbols.length,
      versionId,
      symbol,
      timeframe,
      from,
      to,
      startingUsdt,
      submitting,
    ],
  );

  async function submit() {
    if (!canSubmit) return;
    if (requires1hChart && timeframe !== "1h") {
      setErr(`${backtestEngineBadge} backtests must use the 1h timeframe (not ${timeframe}).`);
      return;
    }
    setErr(null);
    setSubmitting(true);
    try {
      await fetchStrategies(slug, { includeArchived: false });
      await fetchInstances(slug);
      const freshInstances = useAppStore.getState().instancesByMode[slug] ?? [];
      const freshStrategies = useAppStore.getState().strategiesByMode[slug] ?? [];
      let runVersionId = versionId;
      const runInstance =
        configSource === "instance" && instanceId
          ? freshInstances.find((i) => i.id === instanceId)
          : undefined;
      if (runInstance?.strategyVersionId) {
        runVersionId = String(runInstance.strategyVersionId);
      } else if (strategyId) {
        const strat = freshStrategies.find((s) => s.id === strategyId);
        if (strat?.latestVersion?.id) runVersionId = String(strat.latestVersion.id);
      }
      if (!runVersionId) throw new Error("strategy_version_required");
      /** Hint only — server persists gate_mode from merged strategy snapshot (`intelligenceGateEnabled`). */
      const gateMode: "off" | "approx" = intelligenceGateEnabledInCfgRaw(effectiveCfgRaw) ? "approx" : "off";
      const res = await api.createBacktestRun({
        strategyVersionId: runVersionId,
        botInstanceId: configSource === "instance" ? instanceId : undefined,
        ...(coinMode === "multiple"
          ? { symbols: portfolioSymbols.map((s) => s.toUpperCase()) }
          : { symbol: symbol.toUpperCase() }),
        timeframe,
        from,
        to,
        startingUsdt,
        gateMode,
        costModel: { slippagePct: slippagePct / 100 },
        walkForward: walkForwardOn ? { trainPct } : undefined,
        positionSizing: fullEquityMargin ? "FULL_EQUITY_MARGIN" : "RISK_AT_SL",
        instanceOperational:
          runInstance?.operational
            ? instanceOperationalFromSaved(runInstance.operational, symbol, timeframe)
            : undefined,
      });
      if (!res?.ok || !res.runId) throw new Error(res?.error || "create_failed");
      useAppStore.getState().setBacktestProgress(String(res.runId), { status: "queued", progressPct: 0 });
      await onCreated(res.runId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e ?? "error");
      setErr(msg);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-2 text-xs">
      <Field label="Config source">
        <select
          value={configSource === "instance" ? `instance:${instanceId}` : "strategy"}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "strategy") {
              setConfigSource("strategy");
              setInstanceId("");
              return;
            }
            const id = v.replace(/^instance:/, "");
            setConfigSource("instance");
            setInstanceId(id);
          }}
          className="select-base"
        >
          <option value="strategy">Strategy only (research)</option>
          {instances.map((i: BotInstance) => (
            <option key={i.id} value={`instance:${i.id}`}>
              Instance: {i.label || i.strategyName || i.id.slice(0, 8)}
              {i.id === activeInstanceId ? " · active" : ""}
            </option>
          ))}
        </select>
      </Field>
      <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-400">
        {configSource === "instance" && selectedInstance ? (
          <>
            Uses the <b>saved</b> strategy version bound to this instance plus instance operational overrides (
            <span className="font-mono">{String((effectiveCfgRaw as any)?.bot?.marketMode ?? selectedInstance.operational.marketMode ?? "market?")}</span>
            , risk{" "}
            <span className="font-mono">
              {String((effectiveCfgRaw as any)?.bot?.riskPerTrade ?? selectedInstance.operational.riskPerTrade ?? "?")}
              {(effectiveCfgRaw as any)?.bot?.riskPerTradeUnit || selectedInstance.operational.riskUnit
                ? ` ${(effectiveCfgRaw as any)?.bot?.riskPerTradeUnit ?? selectedInstance.operational.riskUnit}`
                : ""}
            </span>
            ).
          </>
        ) : (
          <>
            Uses the <b>last saved</b> strategy snapshot. Change SMC/ICT in Trading, then <b>Save</b> before
            backtesting — unsaved panel changes are not included.
          </>
        )}
      </p>
      <div className="space-y-1">
        <Field label="Strategy">
          <select
            value={strategyId}
            onChange={(e) => {
              setStrategyId(e.target.value);
            }}
            disabled={configSource === "instance"}
            className="select-base"
          >
            <option value="">-- select --</option>
            {strategies.map((s: Strategy) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        {strategyId && selectedVersion ? (
          <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-400">
            {configSource === "instance" ? (
              <>
                Uses the instance-bound strategy version (v{selectedInstance?.strategyVersionNumber ?? "?"}) and saved
                instance operational fields — not the live trading panel.
              </>
            ) : (
              <>
                Uses this strategy&apos;s <span className="font-medium">current saved config</span>
                {versionLabelForUi(selectedVersion.label)} for research.
              </>
            )}
          </p>
        ) : strategyId && !selectedVersion ? (
          <p className="text-[10px] text-amber-700 dark:text-amber-400">This strategy has no saved version yet.</p>
        ) : null}
      </div>
      {versionId ? (
        <>
          <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-400">
            Engine path from saved config: <span className="font-mono font-semibold">{backtestEngineBadge}</span>.{" "}
            {backtestEngineBadge === "AUTO" && <span>AUTO rotates by regime per bar, like live.</span>}
            {" "}Saved strategy uses <span className="font-mono">intelligenceGateEnabled</span> (
            <span className="font-medium">{intelligenceGateEnabledInCfgRaw(effectiveCfgRaw) ? "Approx replay — on" : "Off"}</span>
            ); server stores gate mode from the merged snapshot only.
          </p>
          {manualStrategyInCfg(effectiveCfgRaw) === "TREND_HTF_ST" && backtestEngineBadge === "SUPERTREND" ? (
            <p className="text-[10px] text-amber-800 dark:text-amber-300">
              <b>Note:</b> <span className="font-mono">manualStrategy</span> is TREND_HTF_ST but{" "}
              <span className="font-mono">supertrendFuturesAuto</span> is on — backtest runs <b>SUPERTREND</b> + intel gate, not HTF_ST.
            </p>
          ) : null}
          {manualStrategyInCfg(effectiveCfgRaw) === "TREND_HTF_ST" &&
          backtestEngineBadge === "TREND_HTF_ST" &&
          !intelligenceGateEnabledInCfgRaw(effectiveCfgRaw) ? (
            <p className="text-[10px] text-amber-800 dark:text-amber-300">
              Saved config is <b>TREND_HTF_ST</b> without intelligence gate / trailing — not the Supertrend+Intel stack. High risk (e.g. 20% @ 50×) can show ~-99% on 1yr BTC.
            </p>
          ) : null}
          {backtestEngineBadge === "SUPERTREND" && intelligenceGateEnabledInCfgRaw(effectiveCfgRaw) ? (
            <p className="text-[10px] text-emerald-800 dark:text-emerald-300">
              <b>ST + Intel 80% WR preset:</b> <span className="font-mono">MANUAL</span> + <span className="font-mono">SUPERTREND</span>, gate on,{" "}
              <span className="font-mono">SL 1.5% / TP 0.7%</span>, trail off, flip exit off, risk 5% @ 10×. Validated{" "}
              <span className="font-mono">BNBUSDT</span> 15m (~87% WR, ~+18% Jan–May 2026). Apply via Trading tab → ★ ST + Intel 80% WR, then Save strategy.
            </p>
          ) : null}
          {backtestEngineBadge === "SUPERTREND_ELITE" || backtestEngineBadge === "UNIFIED_ELITE" ? (
            (() => {
              const issues = eliteStConfigIssues(effectiveCfgRaw, timeframe);
              const label = backtestEngineBadge === "UNIFIED_ELITE" ? "Unified Elite" : "Supertrend Elite";
              const presetHint =
                backtestEngineBadge === "UNIFIED_ELITE"
                  ? "cyan ★ BNB 1H Unified"
                  : "violet BTC 1H Elite";
              if (!issues.length) {
                return (
                  <p className="text-[10px] text-emerald-800 dark:text-emerald-300">
                    <b>{label}:</b> config looks valid for 1H. Simulator auto-corrects legacy fixed SL/TP and ST mult &lt; 3 on each run.
                  </p>
                );
              }
              return (
                <p className="text-[10px] text-amber-800 dark:text-amber-300">
                  <b>{label} — config issues in saved strategy:</b> {issues.join(" · ")}.{" "}
                  Trading tab → <b>{presetHint}</b> preset → <b>Save strategy</b>. Backtests will auto-fix mult/SL/TP, but{" "}
                  <b>1H timeframe</b> and <b>1H EMA gate</b> must be saved in your strategy.
                </p>
              );
            })()
          ) : null}
        </>
      ) : null}

      <p className="text-[10px] leading-snug text-slate-600 dark:text-slate-400">
        OHLC for the symbol and timeframe you choose is loaded from <span className="font-mono">ohlcv_candles</span> (Binance): gaps are backfilled from
        Binance REST using the <span className="font-medium">{configSource === "instance" ? "saved instance + bound strategy version" : "saved strategy snapshot"}</span>.
        Exits (fixed SL/TP vs trailing ST vs intraday structure brackets) come from the <span className="font-medium">strategy config</span>; instance only supplies symbol, timeframe, market mode, and risk. Spot vs futures follows market mode. With Postgres enabled, finalized
        Binance kline closes from the running server are also stored there so recent bars stay aligned with real exchange prints.
      </p>
      {coveragePct != null && coveragePct < 99 ? (
        <div className="rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-100">
          Coverage for this window is {coveragePct.toFixed(1)}%. Results may be unreliable until gaps are synced.
        </div>
      ) : coverageChecking ? (
        <div className="text-[10px] text-slate-500">Checking data coverage…</div>
      ) : null}

      <Field label="Coin mode">
        <div className="flex gap-1">
          {(["single", "multiple"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setCoinMode(mode)}
              className={`flex-1 rounded px-2 py-1 text-[11px] font-semibold ${
                coinMode === mode
                  ? "bg-sky-600 text-white"
                  : "border border-slate-300 text-slate-700 dark:border-slate-600 dark:text-slate-200"
              }`}
            >
              {mode === "single" ? "Single coin" : "Multiple coins"}
            </button>
          ))}
        </div>
        {coinMode === "multiple" ? (
          <p className="mt-1 text-[10px] text-slate-500 dark:text-slate-400">
            Shared-account portfolio replay — same strategy on each coin, one compounded equity curve (like live multi-coin).
          </p>
        ) : null}
      </Field>

      {coinMode === "multiple" ? (
        <Field label="Portfolio coins">
          <MultiCoinSelector
            candidates={availableSymbols}
            selected={portfolioSymbols}
            timeframe={timeframe}
            from={from}
            to={to}
            onChange={setPortfolioSymbols}
          />
        </Field>
      ) : (
      <div className="grid grid-cols-2 gap-2">
        <Field label="Symbol">
          {customSymbolMode ? (
            <div className="flex gap-1">
              <input
                autoFocus
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                onBlur={() => { if (symbol && !availableSymbols.includes(symbol)) return; setCustomSymbolMode(false); }}
                className="input-base min-w-0 flex-1"
                placeholder="e.g. SOLUSDT"
              />
              <button
                type="button"
                onClick={() => { setSymbol("BTCUSDT"); setCustomSymbolMode(false); }}
                className="shrink-0 rounded border border-slate-300 px-1.5 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                title="Cancel"
              >✕</button>
            </div>
          ) : (
            <div className="flex gap-1">
              <select
                value={availableSymbols.includes(symbol) ? symbol : "__custom__"}
                onChange={(e) => {
                  if (e.target.value === "__custom__") {
                    setCustomSymbolMode(true);
                  } else {
                    setSymbol(e.target.value);
                  }
                }}
                className="select-base min-w-0 flex-1"
              >
                {availableSymbols.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
                {!availableSymbols.includes(symbol) && (
                  <option value={symbol}>{symbol}</option>
                )}
                <option value="__custom__">Other (type)…</option>
              </select>
            </div>
          )}
        </Field>
        <Field label="Timeframe">
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className="select-base">
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
          {requires1hChart ? (
            <p className="mt-1 text-[10px] font-medium text-amber-800 dark:text-amber-300">
              <b>{backtestEngineBadge}</b> requires <b>1h</b> candles (15m is not profitable for this path). Timeframe was set to 1h automatically.
            </p>
          ) : null}
        </Field>
      </div>
      )}

      {coinMode === "multiple" ? (
        <Field label="Timeframe">
          <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} className="select-base">
            {TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
          {requires1hChart ? (
            <p className="mt-1 text-[10px] font-medium text-amber-800 dark:text-amber-300">
              <b>{backtestEngineBadge}</b> requires <b>1h</b> candles.
            </p>
          ) : null}
        </Field>
      ) : null}

      <div className="grid grid-cols-2 gap-2">
        <Field label="From">
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="input-base" />
        </Field>
        <Field label="To">
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="input-base" />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Starting USDT">
          <input
            type="number"
            min={1}
            value={startingUsdt}
            onChange={(e) => setStartingUsdt(Number(e.target.value))}
            className="input-base"
          />
        </Field>
        <Field label="Slippage (%)">
          <input
            type="number"
            step="0.01"
            min={0}
            max={1}
            value={slippagePct}
            onChange={(e) => setSlippagePct(Number(e.target.value))}
            className="input-base"
          />
        </Field>
      </div>

      <Field label="Position sizing">
        <label className="flex items-center gap-2 text-[11px] text-slate-700 dark:text-slate-300">
          <input
            type="checkbox"
            checked={fullEquityMargin}
            onChange={(e) => setFullEquityMargin(e.target.checked)}
          />
          Use 100% of equity as margin each trade (compounded)
        </label>
        <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
          Default sizes from risk % at stop. When enabled, each trade margin ≈ full account balance × leverage notional cap.
        </p>
      </Field>

      <Field label="Walk-forward">
        <div className="flex items-center gap-1">
          <input type="checkbox" checked={walkForwardOn} onChange={(e) => setWalkForwardOn(e.target.checked)} />
          {walkForwardOn ? (
            <input
              type="number"
              step="0.05"
              min={0.1}
              max={0.9}
              value={trainPct}
              onChange={(e) => setTrainPct(Number(e.target.value))}
              className="input-base max-w-[6rem]"
            />
          ) : (
            <span className="text-[11px] text-slate-500">In-sample only</span>
          )}
        </div>
        {walkForwardOn ? (
          <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
            Train/test Sharpe appears on the <span className="font-semibold">Results</span> tab after the run completes (not under Optimization).
          </p>
        ) : null}
      </Field>

      {err && <div className="rounded bg-rose-50 px-2 py-1 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{err}</div>}

      <button
        type="button"
        onClick={submit}
        disabled={!canSubmit}
        className="w-full rounded bg-sky-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-sky-500 disabled:opacity-60"
      >
        {submitting ? "Queuing…" : "Run backtest"}
      </button>

      <style>{`
        .input-base { width: 100%; padding: 4px 6px; border-radius: 4px; border: 1px solid rgb(203 213 225); background: white; }
        .dark .input-base { background: rgb(15 23 42 / 0.6); border-color: rgb(51 65 85); color: rgb(226 232 240); }
        .select-base { width: 100%; padding: 3px 6px; border-radius: 4px; border: 1px solid rgb(203 213 225); background: white; }
        .dark .select-base { background: rgb(15 23 42 / 0.6); border-color: rgb(51 65 85); color: rgb(226 232 240); }
      `}</style>
    </div>
  );
}

/**
 * Compute the effective backtest engine key from a strategy version's cfgRaw.
 * Mirrors the live bot's strategy-selection priority exactly:
 *   1. supertrendSpotAuto / supertrendFuturesAuto → "SUPERTREND"
 *   2. strategyMode === "MANUAL" → manualStrategy (or "SUPERTREND" if unset)
 *   3. strategyMode === "AUTO"   → "AUTO" (per-bar regime rotation)
 *   4. fallback                 → "SUPERTREND"
 */
function effectiveEngineKey(cfgRaw: unknown): string {
  if (!cfgRaw || typeof cfgRaw !== "object") return "SUPERTREND";
  const r = cfgRaw as Record<string, unknown>;
  const bot = r.bot;
  const b = bot && typeof bot === "object" ? (bot as Record<string, unknown>) : r;

  const mmUp = String(b.marketMode || b.market || "").toUpperCase();
  const stSpot = Boolean(b.supertrendSpotAuto);
  const stFut = Boolean(b.supertrendFuturesAuto);
  const supertrendAutoOn =
    (mmUp === "SPOT" && stSpot) ||
    (mmUp === "FUTURES" && stFut) ||
    (mmUp === "AUTO" && (stSpot || stFut));
  if (supertrendAutoOn) return "SUPERTREND";

  const stratMode = String(b.strategyMode ?? "").toUpperCase();
  if (stratMode === "MANUAL") {
    const m = String(b.manualStrategy ?? "").toUpperCase();
    return m && m !== "MANUAL" && m !== "AUTO" ? m : "SUPERTREND";
  }
  if (stratMode === "AUTO") return "AUTO";

  return "SUPERTREND";
}

function intelligenceGateEnabledInCfgRaw(cfgRaw: unknown): boolean {
  return boolFromCfg(cfgRaw, "intelligenceGateEnabled");
}

function manualStrategyInCfg(cfgRaw: unknown): string {
  if (!cfgRaw || typeof cfgRaw !== "object") return "";
  const r = cfgRaw as Record<string, unknown>;
  const bot = r.bot;
  const b = bot && typeof bot === "object" ? (bot as Record<string, unknown>) : r;
  return String(b.manualStrategy ?? "").toUpperCase();
}

/** Warnings for saved SUPERTREND_ELITE configs that still carry Supertrend-only settings. */
function eliteStConfigIssues(cfgRaw: unknown, runTf: string): string[] {
  if (!cfgRaw || typeof cfgRaw !== "object") return [];
  const r = cfgRaw as Record<string, unknown>;
  const bot = r.bot;
  const b = bot && typeof bot === "object" ? (bot as Record<string, unknown>) : r;
  const issues: string[] = [];
  const tf = String(b.timeframe ?? runTf ?? "").toLowerCase();
  if (tf && tf !== "1h") issues.push(`timeframe is ${tf} (use 1h)`);
  if (b.eliteStRequireHtf1hEmaAlign !== true) issues.push("1H EMA gate off");
  if (Number(b.supertrendMultiplier ?? 3) < 3) issues.push(`ST mult ${b.supertrendMultiplier} (need ≥3)`);
  if (
    b.trailingStopLossAuto === true &&
    Number(b.supertrendFuturesFixedSlPct ?? 0) === 0 &&
    b.supertrendFuturesUseFixedSl !== false
  ) {
    issues.push("fixed SL bracket ON with 0% SL — breaks ST trail (turn SL bracket off)");
  }
  if (Number(b.supertrendFuturesFixedSlPct ?? 0) > 0 && b.supertrendFuturesUseFixedSl !== false) {
    issues.push(`fixed SL ${(Number(b.supertrendFuturesFixedSlPct) * 100).toFixed(1)}%`);
  }
  if (Number(b.supertrendFuturesFixedTpPct ?? 0) > 0 && b.supertrendFuturesUseFixedTp !== false) {
    issues.push(`fixed TP ${(Number(b.supertrendFuturesFixedTpPct) * 100).toFixed(1)}%`);
  }
  if (Number(b.riskPerTrade ?? 0) > 10) issues.push(`risk ${b.riskPerTrade}% (validated 5%)`);
  if (b.supertrendFuturesAuto === true) issues.push("ST auto-trade on");
  if (b.trailingStopLossAuto !== true) {
    issues.push("trailing ST off (Elite requires trail — auto-fixed on run)");
  }
  if (String(b.trailBufferMode ?? "").toUpperCase() === "ATR") {
    issues.push("trail buffer ATR mode (Elite uses PERCENT 0.05% — auto-fixed on run)");
  }
  if (Number(b.trailBufferRate ?? 0.0005) > 0.001) {
    issues.push(`trail buffer ${(Number(b.trailBufferRate) * 100).toFixed(2)}% (Elite uses 0.05% — auto-fixed on run)`);
  }
  return issues;
}

function boolFromCfg(cfgRaw: unknown, key: string): boolean {
  if (!cfgRaw || typeof cfgRaw !== "object") return false;
  const r = cfgRaw as Record<string, unknown>;
  const bot = r.bot;
  const b = bot && typeof bot === "object" ? (bot as Record<string, unknown>) : r;
  return b[key] === true;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block pb-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {label}
      </span>
      {children}
    </label>
  );
}

function defaultFromDate() {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d.toISOString().slice(0, 10);
}

function defaultToDate() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}
