import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { deferTask } from "../lib/deferTask";
import { useAppStore } from "../ws/store";

function StripDot({ ok }: { ok: boolean }) {
  return (
    <span
      className={`mr-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${ok ? "bg-emerald-400" : "bg-rose-400"}`}
      aria-hidden
    />
  );
}

function Sep() {
  return <span className="shrink-0 select-none text-slate-400 dark:text-slate-500">·</span>;
}

/** Status ticker: venue, WS, feed, AI health, exec sync, regime, AI prob, decision engine, model, signal, pending Supertrend. */
export function HeaderSignalsStrip() {
  const bot = useAppStore((s) => s.bot);
  const mode = useAppStore((s) => s.mode);
  const pushLog = useAppStore((s) => s.pushLog);
  const connected = useAppStore((s) => s.ws.connected);

  const [aiOk, setAiOk] = useState(false);
  const [aiMeta, setAiMeta] = useState<{ modelLoaded?: boolean; xgboostAvailable?: boolean }>({});

  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const r = await api.aiHealth();
        if (!alive) return;
        setAiOk(Boolean(r?.ok));
        setAiMeta({
          modelLoaded: Boolean(r?.data?.model_loaded),
          xgboostAvailable: Boolean(r?.data?.xgboost_available),
        });
      } catch {
        if (!alive) return;
        setAiOk(false);
        setAiMeta({});
      }
    };
    void run();
    const id = setInterval(run, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const botRunning = Boolean(bot?.running);
  const lastStopReason = bot?.lastStopReason != null ? String(bot.lastStopReason) : "";
  const showDailyLossReset = !botRunning && lastStopReason === "max_daily_loss";
  const aiProb = bot?.lastAi?.probability;
  const aiGate = bot?.lastAi?.gateProbability;
  const modelKind = bot?.lastAi?.model_kind || bot?.lastAi?.modelKind;
  const feedOk = Boolean(bot?.feed?.ok);
  const feedSource = bot?.feed?.source || "—";
  const exchangeName = bot?.exchange?.name || mode || "—";

  const udf = bot?.exchangeStatus?.udf as
    | { ok?: boolean; syncMode?: string; error?: string | null }
    | undefined;
  const showExecSync =
    exchangeName === "binance_testnet_spot" ||
    mode === "BINANCE_TESTNET" ||
    mode === "BINANCE_DEMO_API" ||
    exchangeName === "binance_demo_spot_api" ||
    mode === "BINANCE_LIVE" ||
    exchangeName === "binance_live_spot";
  const execWsOk = Boolean(udf?.ok && udf?.syncMode === "websocket");
  const execRestOnlyOk = Boolean(udf?.syncMode === "polling" && (udf as { restOnly?: boolean })?.restOnly);
  const execDemoPollingOk =
    (mode === "BINANCE_DEMO_API" ||
      exchangeName === "binance_demo_spot_api" ||
      mode === "BINANCE_LIVE" ||
      exchangeName === "binance_live_spot") &&
    udf?.syncMode === "polling" &&
    !execWsOk;
  const execSyncOk = execWsOk || execRestOnlyOk || execDemoPollingOk;

  const sandboxTradingMode =
    !mode || mode === "PAPER" || /DEMO|TESTNET/i.test(String(mode));

  const feedTitle =
    feedOk && !bot?.feed?.error
      ? `Market data: ${feedSource}`
      : [feedSource, bot?.feed?.error].filter(Boolean).join(" — ") || "Market feed";

  const pendingSt = bot?.pendingSupertrendAction as { side?: string; venue?: string } | undefined;
  const botStaleHint = botRunning
    ? undefined
    : pendingSt?.side
      ? `Pending Supertrend ${String(pendingSt.side)} (${String(pendingSt.venue ?? "—")}) — Start bot to execute (skipped if position already flat)`
      : "Start bot — Regime / AI / Model / Signal update on each tick while running.";

  const pnlHint = useMemo(() => {
    const d = bot?.lastDecision?.signal?.action;
    return d ? String(d) : "—";
  }, [bot]);

  const de = bot?.decisionEngine as
    | {
        long?: { total?: number; max?: number; breakdown?: Record<string, number> };
        short?: { total?: number; max?: number; breakdown?: Record<string, number> };
        expectedMoveLong?: number | null;
        expectedMoveShort?: number | null;
        features?: { price?: number | null };
        signalStrength?: {
          strength?: number;
          action?: string;
          signal?: string;
          componentScores?: Record<string, number>;
          reason?: string;
        } | null;
      }
    | undefined;

  const decisionTitle = useMemo(() => {
    const ss = de?.signalStrength;
    if (ss && ss.strength != null && Number.isFinite(Number(ss.strength))) {
      const fmt = (b?: Record<string, number>) =>
        b
          ? Object.entries(b)
              .map(([k, v]) => `${k}: ${v}`)
              .join(", ")
          : "";
      return `Signal strength: ${Number(ss.strength).toFixed(1)} · ${String(ss.action ?? "—")} · ${String(ss.signal ?? "—")}\n${fmt(ss.componentScores)}\n${ss.reason ?? ""}\nExpected move (price units): long ${de?.expectedMoveLong ?? "—"}, short ${de?.expectedMoveShort ?? "—"}`;
    }
    if (!de?.long || !de?.short) return "Composite signal strength (band, volume, RSI, recency, trend) + market features — same tick as AI";
    const fmt = (b?: Record<string, number>) =>
      b
        ? Object.entries(b)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ")
        : "";
    return `Long ${de.long.total}/${de.long.max ?? 100} — ${fmt(de.long.breakdown)}\nShort ${de.short.total}/${de.short.max ?? 100} — ${fmt(de.short.breakdown)}\nExpected move (price units): long ${de.expectedMoveLong ?? "—"}, short ${de.expectedMoveShort ?? "—"}`;
  }, [de]);

  const aiProbStr =
    aiGate != null && Number.isFinite(Number(aiGate))
      ? Number(aiGate).toFixed(3)
      : aiProb != null && Number.isFinite(Number(aiProb))
        ? Number(aiProb).toFixed(3)
        : "—";

  const aiLoaded = Boolean(aiOk && aiMeta.modelLoaded);

  return (
    <div className="border-b border-slate-200/80 bg-slate-200/50 dark:border-slate-800 dark:bg-slate-900/90">
      {showDailyLossReset ? (
        <div className="mx-auto flex max-w-[1600px] flex-col gap-2 border-b border-amber-900/40 bg-amber-950/45 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="min-w-0 text-[11px] leading-snug text-amber-100/95 sm:text-xs">
            <span className="font-semibold">Daily loss limit tripped.</span> Trading is paused until you reset
            today&apos;s baselines or wait for UTC midnight. Reset re-anchors spot/futures wallet counters to{" "}
            <span className="font-medium">now</span> and starts the bot again (real risk — you can hit the limit again
            today).
          </div>
          <button
            type="button"
            className="shrink-0 rounded-lg border border-amber-600/60 bg-amber-600/25 px-3 py-1.5 text-[11px] font-semibold text-amber-50 shadow-sm hover:bg-amber-600/40 sm:text-xs"
            onClick={() => {
              deferTask(() => {
                void (async () => {
                  const ok = window.confirm(
                    "Reset daily loss baselines to current wallet equity and start the bot?\n\n" +
                      "This does not move funds on Binance — it only restarts risk tracking from this moment.",
                  );
                  if (!ok) return;
                  try {
                    await api.botResetDailyLoss();
                    pushLog({ level: "warn", msg: "Daily loss baseline reset · bot started" });
                  } catch {
                    pushLog({ level: "error", msg: "Reset daily loss failed" });
                  }
                })();
              });
            }}
          >
            Reset daily limit &amp; start bot
          </button>
        </div>
      ) : null}
      <div className="mx-auto flex max-w-[1600px] items-center gap-x-2.5 overflow-x-auto whitespace-nowrap px-4 py-1.5 text-[11px] leading-tight sm:px-5 sm:text-xs">
        <span
          className="inline-flex max-w-[10rem] shrink-0 items-center text-slate-700 dark:text-slate-300 sm:max-w-[12rem]"
          title={`Trading mode: ${mode ?? "—"} · venue: ${exchangeName}`}
        >
          <StripDot ok={sandboxTradingMode} />
          <span className="truncate">{exchangeName}</span>
        </span>
        <Sep />
        <span className="inline-flex shrink-0 items-center text-slate-700 dark:text-slate-300" title="WebSocket to your backend">
          <StripDot ok={connected} />
          WS
        </span>
        <Sep />
        <span
          className="inline-flex max-w-[6rem] shrink-0 items-center text-slate-700 dark:text-slate-300 sm:max-w-[8rem]"
          title={feedTitle}
        >
          <StripDot ok={feedOk} />
          <span className="truncate">{feedSource}</span>
        </span>
        <Sep />
        <span
          className="inline-flex shrink-0 items-center text-slate-700 dark:text-slate-300"
          title={
            aiOk && aiMeta.modelLoaded === false
              ? "AI service is up but no model.pkl — run Train synthetic or Train on real data"
              : aiOk && aiMeta.modelLoaded
                ? "Model loaded and predict available"
                : "AI service unreachable or status pending"
          }
        >
          <StripDot ok={aiLoaded} />
          AI
          {aiMeta.modelLoaded === false ? " (no model)" : ""}
          {aiMeta.modelLoaded && !aiMeta.xgboostAvailable ? " (fallback)" : ""}
        </span>
        {showExecSync ? (
          <>
            <Sep />
            <span
              className="inline-flex shrink-0 items-center text-slate-700 dark:text-slate-300"
              title={udf?.error || "Order lifecycle sync"}
            >
              <StripDot ok={execSyncOk} />
              {execWsOk ? "Exec WS" : "Exec REST"}
            </span>
          </>
        ) : null}
        <Sep />
        <span className="shrink-0 text-slate-600 dark:text-slate-400" title={botStaleHint || undefined}>
          Regime: <span className="text-slate-900 dark:text-slate-100">{bot?.lastRegime?.type ?? "—"}</span>
        </span>
        <Sep />
        <span
          className="shrink-0 text-slate-600 dark:text-slate-400"
          title={
            [
              aiProb != null && Number.isFinite(Number(aiProb)) ? `Service p ${Number(aiProb).toFixed(3)}` : null,
              aiGate != null && Number.isFinite(Number(aiGate)) ? `Gate ${Number(aiGate).toFixed(3)}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || botStaleHint
          }
        >
          AI: <span className="font-mono text-slate-900 dark:text-slate-100">{aiProbStr}</span>
        </span>
        <Sep />
        <span className="shrink-0 text-slate-600 dark:text-slate-400" title={decisionTitle}>
          Dec:{" "}
          {de?.signalStrength != null &&
          de.signalStrength.strength != null &&
          Number.isFinite(Number(de.signalStrength.strength)) ? (
            <>
              <span className="text-slate-900 dark:text-slate-100">{Number(de.signalStrength.strength).toFixed(0)}</span>
              <span className="text-slate-500 dark:text-slate-500"> · </span>
              <span
                className={
                  de.signalStrength.action === "TRADE"
                    ? "text-emerald-600 dark:text-emerald-300"
                    : de.signalStrength.action === "WAIT"
                      ? "text-amber-600 dark:text-amber-300"
                      : "text-slate-800 dark:text-slate-200"
                }
              >
                {String(de.signalStrength.action ?? "—")}
              </span>
              <span className="text-slate-500 dark:text-slate-500"> · </span>
              <span className="text-slate-800 dark:text-slate-200">{String(de.signalStrength.signal ?? "—")}</span>
            </>
          ) : (
            <>
              <span className="text-emerald-600 dark:text-emerald-300">{de?.long?.total != null ? de.long.total : "—"}</span>
              <span className="text-slate-500 dark:text-slate-500"> / </span>
              <span className="text-rose-600 dark:text-rose-300">{de?.short?.total != null ? de.short.total : "—"}</span>
            </>
          )}
          <span className="text-slate-500 dark:text-slate-500"> · </span>
          <span className="text-slate-800 dark:text-slate-200" title="Expected move (long, % of price)">
            Δ
            {de?.expectedMoveLong != null && Number(de.features?.price) > 0
              ? `${((Number(de.expectedMoveLong) / Number(de.features.price)) * 100).toFixed(2)}%`
              : "—"}
          </span>
        </span>
        <Sep />
        <span
          className="max-w-[min(22rem,45vw)] shrink-0 truncate text-slate-600 dark:text-slate-400"
          title={modelKind != null ? String(modelKind) : botStaleHint || undefined}
        >
          Model: <span className="text-slate-900 dark:text-slate-100">{modelKind ?? "—"}</span>
        </span>
        <Sep />
        <span className="shrink-0 text-slate-600 dark:text-slate-400" title={botStaleHint || undefined}>
          Signal: <span className="text-slate-900 dark:text-slate-100">{pnlHint}</span>
        </span>
        {!botRunning && pendingSt?.side ? (
          <>
            <Sep />
            <span
              className="max-w-[12rem] shrink-0 truncate text-amber-700 dark:text-amber-300"
              title={botStaleHint}
            >
              Pending ST · {String(pendingSt.side)} {String(pendingSt.venue ?? "")}
            </span>
          </>
        ) : null}
      </div>
    </div>
  );
}
