import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { playEngineStartSound } from "../lib/uiSounds";
import { useAppStore } from "../ws/store";

function Dot({ ok }: { ok: boolean }) {
  return <span className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-emerald-400" : "bg-rose-400"}`} />;
}

export function HeaderBar() {
  const bot = useAppStore((s) => s.bot);
  const mode = useAppStore((s) => s.mode);
  const connected = useAppStore((s) => s.ws.connected);
  const pushLog = useAppStore((s) => s.pushLog);

  const [aiOk, setAiOk] = useState<boolean>(false);
  const [aiMeta, setAiMeta] = useState<{ modelLoaded?: boolean; modelKind?: string; xgboostAvailable?: boolean }>({});

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
    run();
    const id = setInterval(run, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const botRunning = Boolean(bot?.running);
  const aiProb = bot?.lastAi?.probability;
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
    exchangeName === "binance_demo_spot_api";
  const execWsOk = Boolean(udf?.ok && udf?.syncMode === "websocket");
  const execRestOnlyOk = Boolean(udf?.syncMode === "polling" && (udf as { restOnly?: boolean })?.restOnly);
  const execDemoPollingOk =
    (mode === "BINANCE_DEMO_API" || exchangeName === "binance_demo_spot_api") &&
    udf?.syncMode === "polling" &&
    !execWsOk;
  const execSyncOk = execWsOk || execRestOnlyOk || execDemoPollingOk;
  const pnlHint = useMemo(() => {
    const d = bot?.lastDecision?.signal?.action;
    return d ? String(d) : "—";
  }, [bot]);

  return (
    <div className="border-b border-slate-800 bg-slate-950/70 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="text-sm font-semibold tracking-wide">AI Trading</div>
          <div className="text-xs text-slate-400">Personal platform</div>
        </div>

        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <Dot ok={mode === "PAPER"} />
            <span className="text-slate-300">{exchangeName}</span>
          </div>

          <div className="flex items-center gap-2">
            <Dot ok={connected} />
            <span className="text-slate-300">WS</span>
          </div>

          <div className="flex items-center gap-2">
            <Dot ok={feedOk} />
            <span className="text-slate-300">{feedSource}</span>
          </div>

          <div className="flex items-center gap-2">
            <Dot ok={aiOk} />
            <span className="text-slate-300">
              AI{aiMeta.modelLoaded === false ? " (no model)" : ""}{aiMeta.xgboostAvailable ? "" : " (fallback)"}
            </span>
          </div>

          {showExecSync && (
            <div className="flex items-center gap-2" title={udf?.error || "Order lifecycle sync"}>
              <Dot ok={execSyncOk} />
              <span className="text-slate-300">{execWsOk ? "Exec WS" : "Exec REST"}</span>
            </div>
          )}

          <div className="hidden md:block text-slate-400">
            Regime: <span className="text-slate-200">{bot?.lastRegime?.type ?? "—"}</span>
          </div>

          <div className="hidden md:block text-slate-400">
            AI:{" "}
            <span className="text-slate-200">
              {aiProb != null && Number.isFinite(Number(aiProb)) ? Number(aiProb).toFixed(3) : "—"}
            </span>
          </div>

          <div className="hidden md:block text-slate-400">
            Model: <span className="text-slate-200">{modelKind ?? "—"}</span>
          </div>

          <div className="hidden md:block text-slate-400">
            Signal: <span className="text-slate-200">{pnlHint}</span>
          </div>

          <button
            className={`rounded-lg px-3 py-1.5 font-medium ${
              botRunning ? "bg-rose-600/80 hover:bg-rose-600" : "bg-emerald-600/80 hover:bg-emerald-600"
            }`}
            onClick={async () => {
              try {
                if (botRunning) await api.botStop();
                else {
                  await api.botStart();
                  playEngineStartSound();
                }
              } catch {
                pushLog({ level: "error", msg: "Failed to toggle bot" });
              }
            }}
          >
            {botRunning ? "Stop Bot" : "Start Bot"}
          </button>

          <div className="flex items-center gap-2">
            <select
              className="rounded-lg border border-slate-700 bg-slate-900/40 px-2 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-900"
              value={mode || "PAPER"}
              onChange={async (e) => {
                const next = e.target.value;
                const ok = window.confirm(`Switch trading mode to ${next}? Bot will stop.`);
                if (!ok) return;
                try {
                  await api.setMode(next as any);
                  pushLog({ level: "warn", msg: "Mode switch requested", mode: next });
                } catch {
                  pushLog({ level: "error", msg: "Mode switch failed" });
                }
              }}
            >
              <option value="PAPER">PAPER (simulated)</option>
              <option value="BINANCE_DEMO">BINANCE DEMO SPOT (sim + live feed)</option>
              <option value="BINANCE_DEMO_FUTURES">
                BINANCE DEMO FUTURES (local sim, or demo-fapi if API keys set)
              </option>
              <option value="BINANCE_DEMO_API">BINANCE DEMO SPOT API (real demo orders)</option>
              <option value="BINANCE_TESTNET">BINANCE TESTNET (real testnet orders)</option>
              <option value="BINANCE_FUTURES_TESTNET">BINANCE FUTURES TESTNET (real futures testnet)</option>
            </select>

            {(mode === "BINANCE_DEMO_API" || exchangeName === "binance_demo_spot") && (
              <button
                className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-900"
                onClick={() => window.open("https://www.binance.com/en/demo-trading", "_blank")}
                title="Open Binance Demo Trading UI"
              >
                Open demo
              </button>
            )}

            {(mode === "BINANCE_TESTNET" || exchangeName === "binance_testnet_spot") && (
              <button
                className="rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-900"
                onClick={() => window.open("https://testnet.binance.vision/", "_blank")}
                title="Open Binance Spot Testnet dashboard"
              >
                Open testnet
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

