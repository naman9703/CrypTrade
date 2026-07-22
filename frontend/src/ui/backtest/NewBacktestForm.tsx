/**
 * Form to launch a new backtest. Each strategy has one current saved row (`latestVersion`);
 * manual Save in Trading updates that row in place — we backtest that snapshot only (no version picker).
 */
import { useEffect, useMemo, useRef, useState } from "react";
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

const EXTRA_SYMBOLS_KEY = "backtest_extra_symbols_v1";
const SYMBOL_SEARCH_DEBOUNCE_MS = 280;

function readExtraSymbols(): string[] {
  try {
    const raw = localStorage.getItem(EXTRA_SYMBOLS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((s) => String(s || "").toUpperCase()).filter(Boolean))];
  } catch {
    return [];
  }
}

function writeExtraSymbols(symbols: string[]) {
  try {
    localStorage.setItem(EXTRA_SYMBOLS_KEY, JSON.stringify(symbols.slice(0, 50)));
  } catch {
    // ignore quota errors
  }
}

/** Normalize typed base or pair to a USDT symbol (e.g. SOL → SOLUSDT). */
function normalizeBacktestSymbol(q: string): string | null {
  const raw = String(q || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!raw) return null;
  const sym = raw.endsWith("USDT") ? raw : `${raw}USDT`;
  return /^[A-Z0-9]{2,16}USDT$/.test(sym) ? sym : null;
}

type BacktestPositionSizingMode = "RISK_AT_SL" | "RISK_AT_SL_FULL_MARGIN" | "FULL_EQUITY_MARGIN";
type PortfolioPositionSizingMode =
  | "EQUAL_SLICE_FULL_MARGIN"
  | "EQUAL_SLICE_RISK_AT_SL"
  | "TOTAL_CAPITAL_RISK_AT_SL";
type BacktestTrailMicroTf = "off" | "1m" | "3m" | "5m" | "15m" | "30m";

const TRAIL_MICRO_TIMEFRAMES: BacktestTrailMicroTf[] = ["1m", "3m", "5m", "15m", "30m"];

const TF_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

function trailMicroTfLabel(tf: BacktestTrailMicroTf): string {
  if (tf === "off") return "Parent bar only (no micro replay)";
  if (tf === "1m") return "1m mark (wick — live tick parity)";
  return `${tf} mark candle close`;
}

function allowedTrailMicroTfs(strategyTf: string): BacktestTrailMicroTf[] {
  const stratMs = TF_MS[strategyTf] ?? Number.POSITIVE_INFINITY;
  const micro = TRAIL_MICRO_TIMEFRAMES.filter((tf) => (TF_MS[tf] ?? 0) < stratMs);
  return ["off", ...micro];
}

function trailingEnabledInCfg(cfgRaw: unknown): boolean {
  if (!cfgRaw || typeof cfgRaw !== "object") return false;
  const r = cfgRaw as Record<string, unknown>;
  const bot = r.bot;
  const b = bot && typeof bot === "object" ? (bot as Record<string, unknown>) : r;
  if (b.trailingStopLossAuto !== true) return false;
  const mode = String(b.futuresTrailingStopMode ?? b.trailingStopMode ?? "SUPERTREND").toUpperCase();
  if (mode === "OFF") return false;
  const market = String(b.marketMode ?? "FUTURES").toUpperCase();
  return market !== "SPOT";
}

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
  const [extraSymbols, setExtraSymbols] = useState<string[]>(() => readExtraSymbols());
  const [customSymbolMode, setCustomSymbolMode] = useState<boolean>(false);
  const [customQuery, setCustomQuery] = useState<string>("");
  const [symbolSuggestions, setSymbolSuggestions] = useState<string[]>([]);
  const [suggestionsBusy, setSuggestionsBusy] = useState(false);
  const customInputRef = useRef<HTMLInputElement | null>(null);
  const searchSeqRef = useRef(0);
  const [timeframe, setTimeframe] = useState<string>("15m");
  const [from, setFrom] = useState<string>(() => defaultFromDate());
  const [to, setTo] = useState<string>(() => defaultToDate());
  const [startingUsdt, setStartingUsdt] = useState<number>(10_000);
  const [positionSizing, setPositionSizing] = useState<BacktestPositionSizingMode>("RISK_AT_SL");
  const [portfolioPositionSizing, setPortfolioPositionSizing] =
    useState<PortfolioPositionSizingMode>("EQUAL_SLICE_FULL_MARGIN");
  const [trailMicroTf, setTrailMicroTf] = useState<BacktestTrailMicroTf>("1m");
  const [walkForwardOn, setWalkForwardOn] = useState<boolean>(false);
  const [trainPct, setTrainPct] = useState<number>(0.7);
  const [slippagePct, setSlippagePct] = useState<number>(0.05);
  const [useLivePanelOverrides, setUseLivePanelOverrides] = useState<boolean>(false);
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
  const trailingBacktestEnabled = useMemo(() => trailingEnabledInCfg(effectiveCfgRaw), [effectiveCfgRaw]);
  const trailMicroTfOptions = useMemo(
    () => allowedTrailMicroTfs(timeframe),
    [timeframe],
  );

  useEffect(() => {
    if (!trailMicroTfOptions.includes(trailMicroTf)) {
      setTrailMicroTf(trailMicroTfOptions.includes("1m") ? "1m" : "off");
    }
  }, [trailMicroTf, trailMicroTfOptions]);

  /** Merged, de-duped symbol list: strategy config, user-added, then popular defaults. */
  const availableSymbols = useMemo(() => {
    const fromCfg = symbolsFromCfg(effectiveCfgRaw);
    const merged = [...fromCfg];
    for (const s of extraSymbols) {
      if (!merged.includes(s)) merged.push(s);
    }
    for (const s of POPULAR_SYMBOLS) {
      if (!merged.includes(s)) merged.push(s);
    }
    return merged;
  }, [effectiveCfgRaw, extraSymbols]);

  const commitCustomSymbol = (raw: string) => {
    const next = normalizeBacktestSymbol(raw);
    if (!next) return;
    setExtraSymbols((prev) => {
      if (prev.includes(next)) return prev;
      const updated = [next, ...prev].slice(0, 50);
      writeExtraSymbols(updated);
      return updated;
    });
    setSymbol(next);
    setCustomQuery("");
    setSymbolSuggestions([]);
    setCustomSymbolMode(false);
  };

  const cancelCustomSymbol = () => {
    setCustomQuery("");
    setSymbolSuggestions([]);
    setCustomSymbolMode(false);
  };

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

  useEffect(() => {
    if (!customSymbolMode) return;
    customInputRef.current?.focus();
  }, [customSymbolMode]);

  useEffect(() => {
    if (!customSymbolMode) {
      setSymbolSuggestions([]);
      setSuggestionsBusy(false);
      return;
    }
    const q = customQuery.trim().toUpperCase();
    if (!q) {
      setSymbolSuggestions([]);
      setSuggestionsBusy(false);
      return;
    }

    const localHits = availableSymbols.filter((s) => {
      const su = s.toUpperCase();
      const base = su.endsWith("USDT") ? su.slice(0, -4) : su;
      return su.includes(q) || base.includes(q);
    });

    const seq = ++searchSeqRef.current;
    setSuggestionsBusy(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const r = await api.universeSymbols({ q });
          if (searchSeqRef.current !== seq) return;
          const remote = r?.ok && Array.isArray(r.symbols) ? r.symbols : [];
          const merged: string[] = [];
          for (const s of [...localHits, ...remote]) {
            const u = String(s || "").toUpperCase();
            if (u && !merged.includes(u)) merged.push(u);
          }
          setSymbolSuggestions(merged.slice(0, 40));
        } catch {
          if (searchSeqRef.current !== seq) return;
          setSymbolSuggestions(localHits.slice(0, 40));
        } finally {
          if (searchSeqRef.current === seq) setSuggestionsBusy(false);
        }
      })();
    }, SYMBOL_SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [availableSymbols, customQuery, customSymbolMode]);

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
    setErr(null);
    setSubmitting(true);
    try {
      // Do not refetch strategies here — list API can briefly return stale cfg_raw and mark the
      // panel dirty; in-memory store already has the authoritative post-Save version + cfg.
      await fetchInstances(slug);
      const freshInstances = useAppStore.getState().instancesByMode[slug] ?? [];
      const freshStrategies = useAppStore.getState().strategiesByMode[slug] ?? strategies;
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
        positionSizing: coinMode === "multiple" ? undefined : positionSizing,
        portfolioPositionSizing: coinMode === "multiple" ? portfolioPositionSizing : undefined,
        trailMicroTf,
        useLivePanelOverrides,
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
            Uses the <b>last saved</b> strategy snapshot, merged with your <b>current Trading panel</b> (gates, liquidity exits, trailing). Click <b>Save</b> on the strategy to persist panel changes for future runs without live merge.
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
          {manualStrategyInCfg(effectiveCfgRaw) &&
          manualStrategyInCfg(effectiveCfgRaw) !== "SUPERTREND" &&
          backtestEngineBadge === "SUPERTREND" ? (
            <p className="text-[10px] text-amber-800 dark:text-amber-300">
              <b>Note:</b> <span className="font-mono">manualStrategy</span> is{" "}
              <span className="font-mono">{manualStrategyInCfg(effectiveCfgRaw)}</span> but{" "}
              <span className="font-mono">supertrendFuturesAuto</span> /{" "}
              <span className="font-mono">supertrendSpotAuto</span> is on — backtest runs <b>SUPERTREND</b>, not the selected manual strategy.
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
              const issues = eliteStConfigIssues(effectiveCfgRaw);
              const label = backtestEngineBadge === "UNIFIED_ELITE" ? "Unified Elite" : "Supertrend Elite";
              const presetHint =
                backtestEngineBadge === "UNIFIED_ELITE"
                  ? "cyan ★ BNB 1H Unified"
                  : "violet BTC 1H Elite";
              if (!issues.length) {
                return (
                  <p className="text-[10px] text-emerald-800 dark:text-emerald-300">
                    <b>{label}:</b> config looks valid. Simulator auto-corrects legacy fixed SL/TP and ST mult &lt; 3 on each run.
                  </p>
                );
              }
              return (
                <p className="text-[10px] text-amber-800 dark:text-amber-300">
                  <b>{label} — config issues in saved strategy:</b> {issues.join(" · ")}.{" "}
                  Trading tab → <b>{presetHint}</b> preset → <b>Save strategy</b>. Backtests will auto-fix mult/SL/TP;{" "}
                  <b>1H EMA gate</b> should be saved in your strategy when using Elite presets.
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
            <div className="relative">
              <div className="flex gap-1">
                <input
                  ref={customInputRef}
                  autoFocus
                  value={customQuery}
                  onChange={(e) => setCustomQuery(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      cancelCustomSymbol();
                      return;
                    }
                    if (e.key === "Enter") {
                      e.preventDefault();
                      const pick = symbolSuggestions[0] ?? customQuery;
                      commitCustomSymbol(pick);
                    }
                  }}
                  className="input-base min-w-0 flex-1"
                  placeholder="Type coin (e.g. SOL or SOLUSDT)"
                  spellCheck={false}
                  autoComplete="off"
                  aria-autocomplete="list"
                  aria-expanded={Boolean(customQuery)}
                />
                <button
                  type="button"
                  onClick={() => commitCustomSymbol(customQuery)}
                  disabled={!normalizeBacktestSymbol(customQuery)}
                  className="shrink-0 rounded border border-sky-300 bg-sky-50 px-2 text-[11px] font-semibold text-sky-800 disabled:cursor-not-allowed disabled:opacity-40 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200"
                  title="Add symbol"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={cancelCustomSymbol}
                  className="shrink-0 rounded border border-slate-300 px-1.5 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                  title="Cancel"
                >
                  ✕
                </button>
              </div>
              {customQuery ? (
                <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-auto rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-950">
                  {suggestionsBusy && symbolSuggestions.length === 0 ? (
                    <div className="px-2 py-1.5 text-[11px] text-slate-500">Searching…</div>
                  ) : symbolSuggestions.length === 0 ? (
                    normalizeBacktestSymbol(customQuery) ? (
                      <button
                        type="button"
                        className="flex w-full items-center justify-between px-2 py-1.5 text-left font-mono text-[11px] text-emerald-800 hover:bg-emerald-50 dark:text-emerald-200 dark:hover:bg-emerald-950/40"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => commitCustomSymbol(customQuery)}
                      >
                        <span>Add {normalizeBacktestSymbol(customQuery)}</span>
                        <span className="text-[10px] font-semibold">Enter</span>
                      </button>
                    ) : (
                      <div className="px-2 py-1.5 text-[11px] text-slate-500">Type a valid coin (e.g. SOL)</div>
                    )
                  ) : (
                    <ul>
                      {symbolSuggestions.map((s) => (
                        <li key={s}>
                          <button
                            type="button"
                            className="flex w-full items-center justify-between px-2 py-1.5 text-left font-mono text-[11px] text-slate-800 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-900"
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => commitCustomSymbol(s)}
                          >
                            <span>{s}</span>
                            {!availableSymbols.includes(s) ? (
                              <span className="text-[10px] text-slate-500">add</span>
                            ) : null}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ) : (
                <p className="mt-1 text-[10px] text-slate-500">Type a coin to search, then select or press Enter.</p>
              )}
            </div>
          ) : (
            <div className="flex gap-1">
              <select
                value={symbol}
                onChange={(e) => {
                  if (e.target.value === "__custom__") {
                    setCustomQuery("");
                    setSymbolSuggestions([]);
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
        {coinMode === "multiple" ? (
          <>
            <select
              value={portfolioPositionSizing}
              onChange={(e) =>
                setPortfolioPositionSizing(e.target.value as PortfolioPositionSizingMode)
              }
              className="select-base"
            >
              <option value="EQUAL_SLICE_FULL_MARGIN">
                100% of equal slice (default)
              </option>
              <option value="EQUAL_SLICE_RISK_AT_SL">
                Risk % at SL of equal slice
              </option>
              <option value="TOTAL_CAPITAL_RISK_AT_SL">
                Risk % at SL of total capital (skip overlaps)
              </option>
            </select>
            <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
              {portfolioPositionSizing === "EQUAL_SLICE_FULL_MARGIN" ? (
                <>
                  Capital split equally (e.g. $100 → $33 each for 3 coins). Each trade uses{" "}
                  <b>100% of that coin&apos;s slice</b> as margin.
                </>
              ) : portfolioPositionSizing === "EQUAL_SLICE_RISK_AT_SL" ? (
                <>
                  Same equal split, but size like single-coin <b>risk % at stop</b> against the slice
                  (e.g. risk on $33). Margin varies with stop distance — usually much less than the
                  full slice.
                </>
              ) : (
                <>
                  Each coin sizes <b>risk % at stop vs total capital</b> (e.g. $100). Shared account:
                  if two signals overlap, the <b>first entry keeps the capital</b>; later overlapping
                  entries are ignored.
                </>
              )}
            </p>
          </>
        ) : (
          <>
            <select
              value={positionSizing}
              onChange={(e) => setPositionSizing(e.target.value as BacktestPositionSizingMode)}
              className="select-base"
            >
              <option value="RISK_AT_SL">Risk % at stop (fixed leverage from strategy)</option>
              <option value="RISK_AT_SL_FULL_MARGIN">Full margin + dynamic leverage (same risk at SL)</option>
              <option value="FULL_EQUITY_MARGIN">100% margin each trade (compound notional)</option>
            </select>
            <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
              Single-coin runs use the starting capital above. <b>Fixed leverage</b> sizes from risk % and stop
              distance (margin varies). <b>Full margin + dynamic lev</b> deploys the full balance as collateral and
              picks leverage per trade so dollar risk at SL matches your risk % (max = strategy leverage).{" "}
              <b>100% margin</b> ignores stop distance for sizing.
            </p>
          </>
        )}
      </Field>

      {trailingBacktestEnabled ? (
        <Field label="Trailing resolution">
          <select
            value={trailMicroTf}
            onChange={(e) => setTrailMicroTf(e.target.value as BacktestTrailMicroTf)}
            className="select-base"
          >
            {trailMicroTfOptions.map((tf) => (
              <option key={tf} value={tf}>
                {trailMicroTfLabel(tf)}
              </option>
            ))}
          </select>
          <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
            <b>1m</b> uses mark wicks (live tick parity). <b>5m/15m</b> use Binance mark klines — trailing tiers
            activate only when the lower-TF candle <b>closes</b> past the activation point; stop breaches still use
            intra-bar wicks.
          </p>
        </Field>
      ) : null}

      <Field label="Live panel overlay">
        <label className="flex items-center gap-1.5 text-[11px]">
          <input
            type="checkbox"
            checked={useLivePanelOverrides}
            onChange={(e) => setUseLivePanelOverrides(e.target.checked)}
          />
          Merge running bot intraday panel into saved strategy
        </label>
        <p className="mt-0.5 text-[10px] text-slate-500 dark:text-slate-400">
          Off (default): backtest uses the saved strategy snapshot only. On: overlays live Trading panel keys
          (can override preset values like trail gates and partials).
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
function eliteStConfigIssues(cfgRaw: unknown): string[] {
  if (!cfgRaw || typeof cfgRaw !== "object") return [];
  const r = cfgRaw as Record<string, unknown>;
  const bot = r.bot;
  const b = bot && typeof bot === "object" ? (bot as Record<string, unknown>) : r;
  const issues: string[] = [];
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
