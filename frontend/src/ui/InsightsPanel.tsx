import { useAppStore } from "../ws/store";
import { api } from "../api/client";
import { useEffect, useMemo, useState } from "react";

export function InsightsPanel() {
  const bot = useAppStore((s) => s.bot);
  const market = useAppStore((s) => s.market);
  const external = useAppStore((s) => s.external);
  const pushLog = useAppStore((s) => s.pushLog);
  const [busy, setBusy] = useState(false);
  const [training, setTraining] = useState(false);

  const prob = bot?.lastAi?.probability;
  const decision = bot?.lastDecision;
  const trainedAt = bot?.lastAi?.trained_at || bot?.lastAi?.trainedAt;
  const aiFeatures = bot?.lastAi?.features || bot?.lastAi?.last_features || {};
  const newsSent = aiFeatures?.news_sentiment;
  const newsCount = aiFeatures?.news_count_24h;
  const fearGreed = aiFeatures?.fear_greed;
  const funding = aiFeatures?.btc_funding_rate;

  const [aiTrainMeta, setAiTrainMeta] = useState<{ symbolsCount?: number; source?: string }>({});
  useEffect(() => {
    let alive = true;
    const run = async () => {
      try {
        const r = await api.aiHealth();
        if (!alive) return;
        const meta = r?.data?.meta || {};
        const symbols = Array.isArray(meta?.symbols) ? meta.symbols : [];
        setAiTrainMeta({ symbolsCount: symbols.length, source: String(meta?.source || "") });
      } catch {
        if (!alive) return;
        setAiTrainMeta({});
      }
    };
    run();
    const id = setInterval(run, 12_000);
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
        <div className="text-xs text-slate-400">Confidence + regime + suggested action</div>
      </div>

      <div className="grid gap-3 text-xs">
        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
          <div className="text-slate-400">AI confidence</div>
          <div className="mt-1 text-lg font-semibold text-slate-100">
            {prob != null && Number.isFinite(Number(prob)) ? Number(prob).toFixed(3) : "—"}
          </div>
          <div className="mt-1 text-slate-500">
            Threshold: <span className="text-slate-200">{Number(bot?.aiThreshold ?? 0.65).toFixed(2)}</span>
          </div>
          <div className="mt-1 text-slate-500">
            Trained on: <span className="text-slate-200">{datasetsText}</span>
          </div>
          <div className="mt-2">
            <button
              disabled={busy}
              className="rounded-md border border-slate-700 bg-slate-900/50 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-900 disabled:opacity-50"
              onClick={async () => {
                setBusy(true);
                try {
                  const r = await api.aiRetrain();
                  pushLog({ level: "info", msg: "AI retrain requested", ...(r?.data || {}) });
                } catch {
                  pushLog({ level: "warn", msg: "AI retrain failed (need enough feedback rows)" });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Retraining…" : "Retrain (from feedback)"}
            </button>
            <button
              disabled={training}
              className="ml-2 rounded-md border border-emerald-700 bg-emerald-900/40 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-900 disabled:opacity-50"
              onClick={async () => {
                setTraining(true);
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
                  setTraining(false);
                }
              }}
            >
              {training ? "Training…" : "Train on real data"}
            </button>
            <button
              type="button"
              className="ml-2 rounded-md border border-slate-600 bg-slate-900/30 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-900"
              onClick={async () => {
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
              }}
            >
              Evaluation checklist
            </button>
            <button
              type="button"
              className="ml-2 rounded-md border border-slate-600 bg-slate-900/30 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-900"
              onClick={async () => {
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
              }}
            >
              AI validation
            </button>
          </div>
        </div>

        {bot?.metrics && (
          <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-[11px] text-slate-400">
            <div className="text-slate-500">Runtime metrics</div>
            <div className="mt-1 grid grid-cols-2 gap-2 text-slate-300">
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
          <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
            <div className="text-slate-400">Market regime</div>
            <div className="mt-1 font-semibold text-slate-100">{market?.regime?.type ?? "—"}</div>
            <div className="mt-1 text-slate-500">ADX: {market?.regime?.adx?.toFixed?.(1) ?? "—"}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
            <div className="text-slate-400">Suggested action</div>
            <div className="mt-1 font-semibold text-slate-100">{decision?.signal?.action ?? "—"}</div>
            <div className="mt-1 text-slate-500">{decision?.strategyKey ?? "—"}</div>
            <div className="mt-1 text-slate-600">Last trained: {trainedAt ?? "—"}</div>
          </div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs">
          <div className="text-slate-400">External (CoinGecko)</div>
          <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-slate-300">
            <div>24h change: {external?.market?.change24hPct != null ? `${Number(external.market.change24hPct).toFixed(2)}%` : "—"}</div>
            <div>24h vol: {external?.market?.volume24hUsd != null ? `$${Number(external.market.volume24hUsd).toFixed(0)}` : "—"}</div>
            <div>Mkt cap: {external?.market?.marketCapUsd != null ? `$${Number(external.market.marketCapUsd).toFixed(0)}` : "—"}</div>
            <div>ATH: {external?.market?.athUsd != null ? `$${Number(external.market.athUsd).toFixed(2)}` : "—"}</div>
          </div>
          <div className="mt-1 text-[11px] text-slate-600">As of: {external?.asOf ?? "—"}</div>
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs">
          <div className="text-slate-400">External (AI features)</div>
          <div className="mt-1 grid grid-cols-2 gap-2 text-[11px] text-slate-300">
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

