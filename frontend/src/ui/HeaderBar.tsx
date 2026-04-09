import { useMemo } from "react";
import { api } from "../api/client";
import { deferTask } from "../lib/deferTask";
import { playEngineStartSound } from "../lib/uiSounds";
import { useAppStore } from "../ws/store";

function mergeBotFromApi(bot: Record<string, unknown> | null | undefined) {
  if (!bot || typeof bot !== "object") return;
  useAppStore.setState((s) => {
    const cur = s.bot;
    if (cur != null && typeof cur === "object" && !Array.isArray(cur)) {
      return { bot: { ...cur, ...bot } };
    }
    return { bot: { ...bot } };
  });
}

export function HeaderBar() {
  const bot = useAppStore((s) => s.bot);
  const mode = useAppStore((s) => s.mode);
  const pushLog = useAppStore((s) => s.pushLog);

  const botRunning = Boolean(bot?.running);
  const exchangeName = bot?.exchange?.name || mode || "—";

  const pendingSt = bot?.pendingSupertrendAction as { side?: string; venue?: string } | undefined;
  const botStaleHint = botRunning
    ? undefined
    : pendingSt?.side
      ? `Pending Supertrend ${String(pendingSt.side)} (${String(pendingSt.venue ?? "—")}) — Start bot to execute (skipped if position already flat)`
      : "Start bot — status row above updates while running.";

  const modeSelectTitle = useMemo(
    () => `Trading mode: ${mode ?? "—"} · venue: ${exchangeName}`,
    [mode, exchangeName],
  );

  return (
    <div className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 backdrop-blur">
      <div className="mx-auto flex max-w-[1600px] items-center justify-between gap-3 px-4 py-3.5 sm:px-5 sm:py-4">
        <div className="ml-6 flex shrink-0 items-center gap-3 sm:ml-10">
          <img
            src="/logo-light.webp"
            alt="AI Trading"
            width={240}
            height={48}
            className="h-11 w-auto max-h-11 object-contain object-left dark:hidden sm:h-12 sm:max-h-12"
            decoding="async"
          />
          <img
            src="/logo-dark.webp"
            alt="AI Trading"
            width={240}
            height={48}
            className="hidden h-11 w-auto max-h-11 object-contain object-left dark:block sm:h-12 sm:max-h-12"
            decoding="async"
          />
        </div>

        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 sm:gap-3">
          <div className="flex shrink-0 items-center gap-1.5" title={modeSelectTitle}>
            <select
              className="max-w-[9.5rem] truncate rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200/55 dark:bg-slate-100 dark:bg-slate-900/40 px-2 py-1 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900 sm:max-w-none"
              value={mode || "PAPER"}
              onChange={(e) => {
                const next = e.target.value;
                deferTask(() => {
                  void (async () => {
                    const ok =
                      next === "BINANCE_LIVE"
                        ? window.confirm(
                            "BINANCE LIVE (mainnet): real funds — losses possible. Requires BINANCE_LIVE_TRADING_ENABLED=1 on the server. Bot will stop. Continue?",
                          )
                        : window.confirm(`Switch trading mode to ${next}? Bot will stop.`);
                    if (!ok) return;
                    try {
                      await api.setMode(next as any);
                      pushLog({ level: "warn", msg: "Mode switch requested", mode: next });
                    } catch {
                      pushLog({ level: "error", msg: "Mode switch failed" });
                    }
                  })();
                });
              }}
            >
              <option value="PAPER">PAPER (simulated)</option>
              <option value="BINANCE_DEMO_API">BINANCE DEMO API (spot + futures demo)</option>
              <option value="BINANCE_TESTNET">BINANCE TESTNET (spot + futures testnet)</option>
              <option value="BINANCE_LIVE">BINANCE LIVE (mainnet · real money)</option>
            </select>

            {(mode === "BINANCE_DEMO_API" || exchangeName === "binance_demo_spot") && (
              <button
                type="button"
                className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200/55 dark:bg-slate-100 dark:bg-slate-900/40 px-2 py-1 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900"
                onClick={() => window.open("https://www.binance.com/en/demo-trading", "_blank")}
                title="Open Binance Demo Trading UI"
              >
                Open demo
              </button>
            )}

            {(mode === "BINANCE_TESTNET" || exchangeName === "binance_testnet_spot") && (
              <button
                type="button"
                className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200/55 dark:bg-slate-100 dark:bg-slate-900/40 px-2 py-1 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900"
                onClick={() => window.open("https://testnet.binance.vision/", "_blank")}
                title="Open Binance Spot Testnet dashboard"
              >
                Spot testnet
              </button>
            )}

            {(mode === "BINANCE_TESTNET" || exchangeName === "binance_futures_testnet_usdm") && (
              <button
                type="button"
                className="rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200/55 dark:bg-slate-100 dark:bg-slate-900/40 px-2 py-1 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900"
                onClick={() => window.open("https://testnet.binancefuture.com/", "_blank")}
                title="Open Binance USD-M Futures Testnet"
              >
                Fut testnet
              </button>
            )}

            {(mode === "BINANCE_LIVE" || exchangeName === "binance_live_spot") && (
              <button
                type="button"
                className="rounded-lg border border-amber-800/50 bg-amber-950/35 px-2 py-1 text-xs font-medium text-amber-100 hover:bg-amber-950/55"
                onClick={() => window.open("https://www.binance.com/en/my/wallet/account/main", "_blank")}
                title="Binance spot wallet (mainnet)"
              >
                Live spot
              </button>
            )}

            {mode === "BINANCE_LIVE" && (
              <button
                type="button"
                className="rounded-lg border border-amber-800/50 bg-amber-950/35 px-2 py-1 text-xs font-medium text-amber-100 hover:bg-amber-950/55"
                onClick={() => window.open("https://www.binance.com/en/futures/BTCUSDT", "_blank")}
                title="Binance USD-M futures (mainnet)"
              >
                Live futures
              </button>
            )}
          </div>

          <button
            type="button"
            title={botStaleHint}
            className="bmw-bot-trigger inline-flex shrink-0 -translate-x-2 cursor-pointer items-center gap-2 border-0 bg-transparent p-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/80 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 sm:-translate-x-2.5"
            onClick={() => {
              deferTask(() => {
                void (async () => {
                  try {
                    if (botRunning) {
                      const out = await api.botStop({ reason: "ui_header_bar" });
                      mergeBotFromApi(out?.bot);
                    } else {
                      const out = await api.botStart({ reason: "ui_header_bar" });
                      mergeBotFromApi(out?.bot);
                      playEngineStartSound();
                    }
                  } catch {
                    pushLog({ level: "error", msg: "Failed to toggle bot" });
                  }
                })();
              });
            }}
          >
            {!botRunning ? (
              <>
                <span className="text-xs font-medium text-slate-900 dark:text-slate-100" aria-hidden>
                  Start
                </span>
                <span
                  className="h-2 w-2 shrink-0 rounded-full border border-slate-200 dark:border-slate-900/50 bg-rose-500 shadow-sm shadow-rose-500/40"
                  aria-hidden
                />
              </>
            ) : (
              <>
                <span className="text-xs font-medium text-slate-900 dark:text-slate-100" aria-hidden>
                  Stop
                </span>
                <span
                  className="h-2 w-2 shrink-0 rounded-full border border-slate-200 dark:border-slate-900/50 bg-emerald-400 shadow-sm shadow-emerald-400/45"
                  aria-hidden
                />
              </>
            )}
            <div className="bmw-bot-btn bmw-header-roundel" aria-hidden>
              <div className="bmw-emblem">
                <div className="bmw-circle bmw-c1">
                  <div className="bmw-circle bmw-c2">
                    <div className="bmw-circle bmw-c3">
                      <div className="bmw-shape bmw-s1" />
                      <div className="bmw-shape bmw-s2" />
                      <div className="bmw-shape bmw-s3" />
                      <div className="bmw-shape bmw-s4" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <span className="sr-only">{botRunning ? "Stop bot" : "Start bot"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
