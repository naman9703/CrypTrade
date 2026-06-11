import { deferTask } from "../lib/deferTask";
import { useAppStore } from "../ws/store";
import { api } from "../api/client";
import { buildOhlc, ohlcBarsToMsCandles } from "../lib/chartOhlc";
import {
  computeSupertrendSignalVerdicts,
  formatSupertrendSignalVerdict,
  verdictForHistorySnap,
} from "../lib/supertrendSignalVerdict";
import { buildChartSupertrend } from "../lib/supertrend";
import { useEffect, useMemo, useState } from "react";

/** Server k.x bar-close row + AI + composite signal strength for Supertrend UI. */
type SignalStrengthDecision = {
  action?: string;
  signal?: string;
  strength?: number;
  componentScores?: Record<string, number>;
  reason?: string;
} | null;

type SupertrendLastBarCloseScores = {
  ts?: number;
  buySignal?: boolean;
  sellSignal?: boolean;
  trend?: number | null;
  /** Chart blend input (0–1) for futures sizing — not the composite 0–100 score. */
  supertrendStrength01?: number | null;
  signalStrengthDecision?: SignalStrengthDecision;
  /** @deprecated prefer supertrendStrength01 / signalStrengthDecision */
  signalStrength?: number | null;
  chartStrict?: boolean;
  aiGateBuy?: number | null;
  aiGateSell?: number | null;
  decisionLong?: number | null;
  decisionShort?: number | null;
  decisionMaxLong?: number | null;
  decisionMaxShort?: number | null;
};

function fmtAiGate(x: number | null | undefined) {
  return x != null && Number.isFinite(Number(x)) ? Number(x).toFixed(3) : "—";
}

function fmtRuleTotal(t: number | null | undefined, m: number | null | undefined) {
  if (t == null || !Number.isFinite(Number(t))) return "—";
  const mx = m != null && Number.isFinite(Number(m)) ? Number(m) : 100;
  return `${Math.round(Number(t))}/${mx}`;
}

export function InsightsPanel() {
  const bot = useAppStore((s) => s.bot);
  const market = useAppStore((s) => s.market);
  const candles = useAppStore((s) => s.candles);
  const external = useAppStore((s) => s.external);
  const pushLog = useAppStore((s) => s.pushLog);
  const [busy, setBusy] = useState(false);
  const [training, setTraining] = useState<null | "binance" | "bootstrap">(null);

  const prob = bot?.lastAi?.probability;
  const decision = bot?.lastDecision;
  const trainedAt = bot?.lastAi?.trained_at || bot?.lastAi?.trainedAt;
  const aiFeatures = bot?.lastAi?.features || bot?.lastAi?.last_features || {};
  const newsSent = aiFeatures?.news_sentiment;
  const newsCount = aiFeatures?.news_count_24h;
  const fearGreed = aiFeatures?.fear_greed;
  const funding = aiFeatures?.btc_funding_rate;

  const stUiCoherent = useMemo(() => {
    const b = String(bot?.symbol ?? "").trim();
    const m = String(market?.symbol ?? "").trim();
    return Boolean(b && m && b === m);
  }, [bot?.symbol, market?.symbol]);

  const insightChartOhlc = useMemo(
    () =>
      buildOhlc(candles as Parameters<typeof buildOhlc>[0], {
        symbol: bot?.symbol != null ? String(bot.symbol) : undefined,
      }),
    [candles, bot?.symbol],
  );

  const insightSt = useMemo(() => {
    const period = Math.max(2, Math.floor(Number(bot?.supertrendPeriod ?? 10)));
    const multiplier = Number(bot?.supertrendMultiplier ?? 3);
    const wilderAtr = bot?.supertrendWilderAtr !== false;
    const ms = ohlcBarsToMsCandles(insightChartOhlc);
    return buildChartSupertrend(ms, {
      period,
      multiplier,
      wilderAtr,
      timeframe: bot?.timeframe != null ? String(bot.timeframe) : "1m",
      symbol: bot?.symbol != null ? String(bot.symbol) : undefined,
    });
  }, [
    insightChartOhlc,
    bot?.symbol,
    bot?.supertrendPeriod,
    bot?.supertrendMultiplier,
    bot?.supertrendWilderAtr,
    bot?.timeframe,
  ]);

  const insightSignalVerdictRows = useMemo(() => {
    const hist = Array.isArray(bot?.supertrendSignalHistory) ? bot.supertrendSignalHistory : [];
    const byKey = new Map<string, { ts: number; side: "BUY" | "SELL" }>();
    for (const e of hist) {
      if (e?.side !== "BUY" && e?.side !== "SELL") continue;
      const ts = Number(e.ts);
      if (!Number.isFinite(ts)) continue;
      const sym = String(e.symbol ?? "").toUpperCase();
      const tf = String(e.timeframe ?? "");
      byKey.set(`${ts}|${e.side}|${sym}|${tf}`, { ts, side: e.side });
    }
    return [...byKey.values()].sort((a, b) => a.ts - b.ts);
  }, [bot?.supertrendSignalHistory]);

  const insightSignalVerdicts = useMemo(
    () => computeSupertrendSignalVerdicts(insightSignalVerdictRows, insightChartOhlc),
    [insightSignalVerdictRows, insightChartOhlc],
  );

  const [aiTrainMeta, setAiTrainMeta] = useState<{ symbolsCount?: number; source?: string }>({});
  useEffect(() => {
    let alive = true;
    let inFlight = false;
    const run = async () => {
      if (inFlight) return;
      if (typeof document !== "undefined" && document.hidden) return;
      inFlight = true;
      try {
        const r = await api.aiHealth();
        if (!alive) return;
        const meta = r?.data?.meta || {};
        const symbols = Array.isArray(meta?.symbols) ? meta.symbols : [];
        setAiTrainMeta({ symbolsCount: symbols.length, source: String(meta?.source || "") });
      } catch {
        if (!alive) return;
        setAiTrainMeta({});
      } finally {
        inFlight = false;
      }
    };
    run();
    const id = setInterval(run, 30_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const datasetsText = useMemo(() => {
    const symbolsCount = Number(aiTrainMeta?.symbolsCount ?? 0);
    // External sources currently integrated into features & training pipeline.
    const externals = 3; // Fear&Greed + BTC funding + RSS news sentiment
    const total = symbolsCount + externals;
    const src = aiTrainMeta?.source ? ` (${aiTrainMeta.source})` : "";
    return `${total} total (symbols: ${symbolsCount}, externals: ${externals})${src}`;
  }, [aiTrainMeta]);

  return (
    <div className="p-4">
      <div className="mb-2">
        <div className="text-sm font-semibold">AI Insights</div>
        <div className="text-xs text-slate-600 dark:text-slate-400">Confidence + regime + suggested action</div>
      </div>

      <div className="grid gap-3 text-xs">
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3">
          <div className="text-slate-600 dark:text-slate-400">AI confidence</div>
          <div className="mt-1 text-lg font-semibold text-slate-900 dark:text-slate-100">
            {prob != null && Number.isFinite(Number(prob)) ? Number(prob).toFixed(3) : "—"}
          </div>
          <div className="mt-1 text-slate-600 dark:text-slate-500">
            Threshold: <span className="text-slate-800 dark:text-slate-200">{Number(bot?.aiThreshold ?? 0.65).toFixed(2)}</span>
          </div>
          <div className="mt-1 text-slate-600 dark:text-slate-500">
            Trained on: <span className="text-slate-800 dark:text-slate-200">{datasetsText}</span>
          </div>
          <div className="mt-2">
            <button
              disabled={busy}
              className="rounded-md border border-slate-300 dark:border-slate-700 bg-slate-200/65 dark:bg-slate-100 dark:bg-slate-900/50 px-3 py-2 text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900 disabled:opacity-50"
              onClick={() => {
                deferTask(() => {
                  void (async () => {
                    setBusy(true);
                    try {
                      const r = await api.aiRetrain();
                      pushLog({ level: "info", msg: "AI retrain requested", ...(r?.data || {}) });
                    } catch {
                      pushLog({ level: "warn", msg: "AI retrain failed (need enough feedback rows)" });
                    } finally {
                      setBusy(false);
                    }
                  })();
                });
              }}
            >
              {busy ? "Retraining…" : "Retrain (from feedback)"}
            </button>
            <button
              disabled={training !== null}
              className="ml-2 rounded-md border border-emerald-700 bg-emerald-900/40 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-900 disabled:opacity-50"
              onClick={() => {
                deferTask(() => {
                  void (async () => {
                    setTraining("binance");
                    try {
                      pushLog({ level: "info", msg: "Training AI on real Binance data…" });
                      const r = await api.aiTrainReal();
                      const d = r?.data;
                      const parts = [
                        `acc ${d?.val_accuracy ?? "?"}`,
                        `prec ${d?.val_precision ?? "?"}`,
                        d?.val_top_decile_wr != null ? `top10%WR ${(d.val_top_decile_wr * 100).toFixed(1)}%` : null,
                        d?.val_lift != null ? `lift ${(d.val_lift * 100).toFixed(1)}%` : null,
                        d?.label_profile ? `labels:${d.label_profile}` : null,
                      ].filter(Boolean).join(", ");
                      pushLog({
                        level: "info",
                        msg: `Model trained — ${parts}`,
                      });
                    } catch (e: any) {
                      pushLog({ level: "error", msg: "Train failed: " + String(e?.message || e) });
                    } finally {
                      setTraining(null);
                    }
                  })();
                });
              }}
            >
              {training === "binance" ? "Training…" : "Train on real data"}
            </button>
            <button
              type="button"
              disabled={training !== null}
              title="No Binance required — use on Railway if real-data train fails or times out"
              className="ml-2 rounded-md border border-amber-700/80 bg-amber-950/40 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-950/70 disabled:opacity-50"
              onClick={() => {
                deferTask(() => {
                  void (async () => {
                    setTraining("bootstrap");
                    try {
                      pushLog({ level: "info", msg: "Training AI on synthetic data (quick, no Binance)…" });
                      const r = await api.aiTrainBootstrap({ rows: 4000, horizon: 10 });
                      const d = r?.data;
                      pushLog({
                        level: "info",
                        msg: `Synthetic model ready — rows ${d?.trained_rows ?? "?"}, horizon ${d?.horizon ?? "?"}, +rate ${d?.positive_rate != null ? (Number(d.positive_rate) * 100).toFixed(1) : "?"}%`,
                      });
                    } catch (e: any) {
                      pushLog({ level: "error", msg: "Synthetic train failed: " + String(e?.message || e) });
                    } finally {
                      setTraining(null);
                    }
                  })();
                });
              }}
            >
              {training === "bootstrap" ? "Training…" : "Train synthetic (quick)"}
            </button>
            <button
              type="button"
              className="ml-2 rounded-md border border-slate-600 bg-slate-200/50 dark:bg-slate-100 dark:bg-slate-900/30 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:bg-slate-900"
              onClick={() => {
                deferTask(() => {
                  void (async () => {
                    try {
                      const r = await api.tradingEvaluation();
                      const steps = Array.isArray(r?.suggestedWorkflow) ? r.suggestedWorkflow : [];
                      const titles = steps.map((s: any) => s?.title).filter(Boolean).join("; ");
                      pushLog({
                        level: "info",
                        msg: r?.disclaimer || "Evaluation checklist",
                        steps: titles || JSON.stringify(steps).slice(0, 500),
                      });
                    } catch {
                      pushLog({ level: "warn", msg: "Could not load evaluation checklist" });
                    }
                  })();
                });
              }}
            >
              Evaluation checklist
            </button>
            <button
              type="button"
              className="ml-2 rounded-md border border-slate-600 bg-slate-200/50 dark:bg-slate-100 dark:bg-slate-900/30 px-3 py-2 text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:bg-slate-900"
              onClick={() => {
                deferTask(() => {
                  void (async () => {
                    try {
                      const r = await api.aiValidationSummary();
                      const d = r?.data || {};
                      pushLog({
                        level: "info",
                        msg: `AI validation: lift ${d?.val_lift ?? "—"}, brier ${d?.val_brier ?? "—"}, stability ${d?.stabilityHint ?? "—"}`,
                        detail: d,
                      });
                    } catch {
                      pushLog({ level: "warn", msg: "Could not load AI validation summary" });
                    }
                  })();
                });
              }}
            >
              AI validation
            </button>
          </div>
        </div>

        {bot?.metrics && (
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3 text-[11px] text-slate-600 dark:text-slate-400">
            <div className="text-slate-600 dark:text-slate-500">Runtime metrics</div>
            <div className="mt-1 grid grid-cols-2 gap-2 text-slate-700 dark:text-slate-300">
              <div>ticks: {bot.metrics.tickCount ?? "—"}</div>
              <div>uptime: {bot.metrics.uptimeSec ?? "—"}s</div>
              <div>predict ms: {bot.metrics.lastPredictLatencyMs ?? "—"}</div>
              <div>spread bps: {bot.metrics.lastSpreadBps != null ? bot.metrics.lastSpreadBps.toFixed(1) : "—"}</div>
              <div>depth $: {bot.metrics.lastDepthNotionalUsd != null ? bot.metrics.lastDepthNotionalUsd.toFixed(0) : "—"}</div>
              <div>funding: {bot.metrics.lastFundingRate != null ? bot.metrics.lastFundingRate.toExponential(2) : "—"}</div>
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3">
            <div className="text-slate-600 dark:text-slate-400">Market regime</div>
            <div className="mt-1 font-semibold text-slate-900 dark:text-slate-100">{market?.regime?.type ?? "—"}</div>
            <div className="mt-1 text-slate-600 dark:text-slate-500">ADX: {market?.regime?.adx?.toFixed?.(1) ?? "—"}</div>
          </div>
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3">
            <div className="text-slate-600 dark:text-slate-400">Suggested action</div>
            <div className="mt-1 font-semibold text-slate-900 dark:text-slate-100">{decision?.signal?.action ?? "—"}</div>
            <div className="mt-1 text-slate-600 dark:text-slate-500">{decision?.strategyKey ?? "—"}</div>
            <div className="mt-1 text-slate-600">Last trained: {trainedAt ?? "—"}</div>
            {decision?.strategyKey === "SUPERTREND" ? (
              <div className="mt-2 border-t border-slate-200 dark:border-slate-800 pt-2 text-[11px] text-slate-600 dark:text-slate-500">
                Supertrend autotrade uses <span className="text-slate-600 dark:text-slate-400">closed-candle</span> flips (see chart markers),
                not this AI action panel.
              </div>
            ) : null}
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3">
          <div className="text-slate-600 dark:text-slate-400">Supertrend (chart)</div>
          {!stUiCoherent ? (
            <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-500">
              Syncing market data for <span className="text-slate-700 dark:text-slate-300">{String(bot?.symbol ?? "—")}</span>… (holding off
              until chart and WS market symbol match)
            </div>
          ) : (
            <>
              <div className="mt-1 font-semibold text-slate-900 dark:text-slate-100">
                {insightSt.lastTrend != null && Number.isFinite(insightSt.lastTrend) ? (
                  insightSt.lastTrend === 1 ? (
                    <span className="text-emerald-300">Long bias (line under price)</span>
                  ) : (
                    <span className="text-rose-300">Short bias (line over price)</span>
                  )
                ) : (
                  "—"
                )}
              </div>
              <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-500">
                Latest candle close (server):{" "}
                {(() => {
                  const s = bot?.supertrendLastBarClose as SupertrendLastBarCloseScores | null | undefined;
                  if (s == null) {
                    return <span className="text-slate-600 dark:text-slate-500">— (no k.x processed yet)</span>;
                  }
                  const t = s.ts != null ? Number(s.ts) : NaN;
                  const when =
                    Number.isFinite(t)
                      ? new Date(t).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "—";
                  if (!s.buySignal && !s.sellSignal) {
                    const tr = s.trend != null && Number.isFinite(Number(s.trend)) ? Number(s.trend) : null;
                    return (
                      <span className="text-slate-600 dark:text-slate-400">
                        No flip on bar {when}. Trend after that close:{" "}
                        {tr === 1 ? (
                          <span className="text-emerald-300/90">LONG</span>
                        ) : tr === -1 ? (
                          <span className="text-rose-300/90">SHORT</span>
                        ) : (
                          "—"
                        )}
                        .{" "}
                        <span className="text-slate-600 dark:text-slate-500">
                          Later bars can have no flip while an earlier bar already triggered Activity — see{" "}
                          <span className="text-slate-600 dark:text-slate-400">last autotrade flip</span> below.
                        </span>
                      </span>
                    );
                  }
                  const label = s.buySignal ? "BUY" : "SELL";
                  const dec = s.signalStrengthDecision;
                  const str =
                    dec?.strength != null && Number.isFinite(Number(dec.strength))
                      ? Number(dec.strength).toFixed(2)
                      : s.signalStrength != null && Number.isFinite(Number(s.signalStrength))
                        ? Number(s.signalStrength).toFixed(2)
                        : null;
                  const sigAi = s.buySignal ? fmtAiGate(s.aiGateBuy) : fmtAiGate(s.aiGateSell);
                  const sigComp = s.buySignal
                    ? fmtRuleTotal(s.decisionLong, s.decisionMaxLong)
                    : fmtRuleTotal(s.decisionShort, s.decisionMaxShort);
                  const act = dec?.action ? ` · ${dec.action}` : "";
                  const vLatest = verdictForHistorySnap(s, insightSignalVerdictRows, insightSignalVerdicts);
                  const vLatestLabel = vLatest != null ? formatSupertrendSignalVerdict(vLatest) : null;
                  const vLatestCls =
                    vLatest === true
                      ? "text-emerald-400"
                      : vLatest === false
                        ? "text-rose-400"
                        : vLatest === "open"
                          ? "text-amber-300/90"
                          : "text-slate-500";
                  return (
                    <span className={s.buySignal ? "text-emerald-300" : "text-rose-300"}>
                      {label} ({when}
                      {str != null ? ` · composite ${str}` : ""}
                      {act}
                      {` · AI gate ${sigAi} · engine ${sigComp}`}
                      {s.chartStrict === false ? " · legacy flip (strict off)" : ""})
                      {vLatestLabel != null ? (
                        <span className={`font-medium ${vLatestCls}`}> · verdict {vLatestLabel}</span>
                      ) : null}
                    </span>
                  );
                })()}
              </div>
              <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-500">
                Last autotrade flip (chart-aligned, matches Activity):{" "}
                {(() => {
                  const flip = bot?.supertrendLastFlipBarClose as SupertrendLastBarCloseScores | null | undefined;
                  if (flip == null || (!flip.buySignal && !flip.sellSignal)) {
                    return <span className="text-slate-600">— (none since symbol/timeframe loaded)</span>;
                  }
                  const t = flip.ts != null ? Number(flip.ts) : NaN;
                  const when =
                    Number.isFinite(t)
                      ? new Date(t).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "—";
                  const label = flip.buySignal ? "BUY" : "SELL";
                  const dec = flip.signalStrengthDecision;
                  const str =
                    dec?.strength != null && Number.isFinite(Number(dec.strength))
                      ? Number(dec.strength).toFixed(2)
                      : flip.signalStrength != null && Number.isFinite(Number(flip.signalStrength))
                        ? Number(flip.signalStrength).toFixed(2)
                        : null;
                  const sigAi = flip.buySignal ? fmtAiGate(flip.aiGateBuy) : fmtAiGate(flip.aiGateSell);
                  const sigComp = flip.buySignal
                    ? fmtRuleTotal(flip.decisionLong, flip.decisionMaxLong)
                    : fmtRuleTotal(flip.decisionShort, flip.decisionMaxShort);
                  const act = dec?.action ? ` · ${dec.action}` : "";
                  const vFlip = verdictForHistorySnap(flip, insightSignalVerdictRows, insightSignalVerdicts);
                  const vFlipLabel = vFlip != null ? formatSupertrendSignalVerdict(vFlip) : null;
                  const vFlipCls =
                    vFlip === true
                      ? "text-emerald-400"
                      : vFlip === false
                        ? "text-rose-400"
                        : vFlip === "open"
                          ? "text-amber-300/90"
                          : "text-slate-500";
                  return (
                    <span className={flip.buySignal ? "text-emerald-300" : "text-rose-300"}>
                      {label} ({when}
                      {str != null ? ` · composite ${str}` : ""}
                      {act}
                      {` · AI gate ${sigAi} · engine ${sigComp}`})
                      {vFlipLabel != null ? (
                        <span className={`font-medium ${vFlipCls}`}> · verdict {vFlipLabel}</span>
                      ) : null}
                    </span>
                  );
                })()}
              </div>
              <div className="mt-1 text-[11px] leading-snug text-slate-600 dark:text-slate-500">
                {(() => {
                  const latest = bot?.supertrendLastBarClose as SupertrendLastBarCloseScores | null | undefined;
                  const flip = bot?.supertrendLastFlipBarClose as SupertrendLastBarCloseScores | null | undefined;
                  const s =
                    latest && (latest.buySignal || latest.sellSignal)
                      ? latest
                      : flip && (flip.buySignal || flip.sellSignal)
                        ? flip
                        : null;
                  if (s == null) return null;
                  const atBar =
                    latest && (latest.buySignal || latest.sellSignal)
                      ? "latest close"
                      : "last autotrade flip bar";
                  return (
                    <>
                      <span className="text-slate-600 dark:text-slate-400">Both paths ({atBar})</span> —{" "}
                      <span className="text-emerald-200/90">BUY</span>: AI (long) {fmtAiGate(s.aiGateBuy)} · composite
                      slot (long) {fmtRuleTotal(s.decisionLong, s.decisionMaxLong)}
                      {" · "}
                      <span className="text-rose-200/90">SELL</span>: AI (short) {fmtAiGate(s.aiGateSell)} · composite
                      slot (short) {fmtRuleTotal(s.decisionShort, s.decisionMaxShort)}
                      {s.aiGateSell == null || !Number.isFinite(Number(s.aiGateSell)) ? (
                        <span className="mt-0.5 block text-slate-600">
                          Short-side AI shows — until <code className="text-slate-600 dark:text-slate-500">model_short.pkl</code> exists.
                          Composite strength uses one active direction (BUY vs SELL from price vs Supertrend band); the
                          inactive legacy slot is 0.
                        </span>
                      ) : null}
                    </>
                  );
                })()}
              </div>
              <div className="mt-1 text-[11px] text-slate-600 dark:text-slate-500">
                Chart markers (local OHLC — last in list, can be an{" "}
                <span className="text-slate-600 dark:text-slate-400">older</span> flip, not the latest k.x):{" "}
                {(() => {
                  const sigs = insightSt.markers;
                  if (!sigs?.length) return "—";
                  const x = sigs[sigs.length - 1];
                  const label = x?.side === "buy" ? "BUY" : x?.side === "sell" ? "SELL" : "—";
                  const t = x?.time;
                  const when =
                    t != null && Number.isFinite(t)
                      ? new Date(Number(t) * 1000).toLocaleString(undefined, {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "—";
                  return (
                    <span className="text-slate-700 dark:text-slate-300">
                      {label}
                      {x?.preview ? <span className="text-amber-300/90"> (preview)</span> : null} ({when})
                    </span>
                  );
                })()}
              </div>
            </>
          )}
          <div className="mt-1 text-[11px] text-slate-600">
            <span className="text-slate-600 dark:text-slate-400">Authoritative flip</span> for trades is{" "}
            <span className="text-slate-700 dark:text-slate-300">Last bar close (server)</span> — same row as autotrade. Chart markers can lag
            behind k.x until candles sync. Autotrade runs when a live Binance kline closes (k.x) and the bot is started.
            Market must be SPOT or FUTURES
            (or AUTO with Supertrend autotrade on — AUTO routes to futures if that toggle is on, else spot). Futures buys
            use AI when available, else a fallback score (see{" "}
            <code className="text-slate-600 dark:text-slate-400">SUPERTREND_FUTURES_AI_FALLBACK_PROB</code>). Check Activity for every skip
            reason.
          </div>
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3 text-xs">
          <div className="text-slate-600 dark:text-slate-400">External (CoinGecko)</div>
          <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-slate-700 dark:text-slate-300">
            <div>24h change: {external?.market?.change24hPct != null ? `${Number(external.market.change24hPct).toFixed(2)}%` : "—"}</div>
            <div>24h vol: {external?.market?.volume24hUsd != null ? `$${Number(external.market.volume24hUsd).toFixed(0)}` : "—"}</div>
            <div>Mkt cap: {external?.market?.marketCapUsd != null ? `$${Number(external.market.marketCapUsd).toFixed(0)}` : "—"}</div>
            <div>ATH: {external?.market?.athUsd != null ? `$${Number(external.market.athUsd).toFixed(2)}` : "—"}</div>
          </div>
          <div className="mt-1 text-[11px] text-slate-600">As of: {external?.asOf ?? "—"}</div>
        </div>

        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100/90 dark:bg-slate-950/40 p-3 text-xs">
          <div className="text-slate-600 dark:text-slate-400">External (AI features)</div>
          <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-slate-700 dark:text-slate-300">
            <div>
              News sentiment:{" "}
              {newsSent != null && Number.isFinite(Number(newsSent)) ? Number(newsSent).toFixed(3) : "—"}
            </div>
            <div>
              News (24h):{" "}
              {newsCount != null && Number.isFinite(Number(newsCount)) ? Number(newsCount).toFixed(0) : "—"}
            </div>
            <div>
              Fear &amp; Greed:{" "}
              {fearGreed != null && Number.isFinite(Number(fearGreed)) ? Number(fearGreed).toFixed(2) : "—"}
            </div>
            <div>
              BTC funding:{" "}
              {funding != null && Number.isFinite(Number(funding)) ? Number(funding).toExponential(2) : "—"}
            </div>
          </div>
          <div className="mt-1 text-[11px] text-slate-600">Source: last AI prediction features</div>
        </div>
      </div>
    </div>
  );
}

