import { useMemo } from "react";
import { api } from "../api/client";
import { useAuthActions } from "../authContext";
import { deferTask } from "../lib/deferTask";
import { playEngineStartSound } from "../lib/uiSounds";
import { useAppStore } from "../ws/store";

type Props = { onOpenSidebar?: () => void };

function mergeBotFromApi(
  bot: Record<string, unknown> | null | undefined,
  extra?: { runningByMode?: Record<string, boolean> },
) {
  if (!bot || typeof bot !== "object") return;
  useAppStore.setState((s) => {
    const cur = s.bot;
    const nextBot =
      cur != null && typeof cur === "object" && !Array.isArray(cur) ? { ...cur, ...bot } : { ...bot };
    return {
      bot: nextBot,
      ...(extra?.runningByMode != null && typeof extra.runningByMode === "object"
        ? { runningByMode: extra.runningByMode }
        : {}),
    };
  });
}

const MODE_LABELS: Record<string, string> = {
  PAPER: "Paper",
  BINANCE_DEMO_API: "Demo",
  BINANCE_TESTNET: "Testnet",
  BINANCE_LIVE: "Live",
};

export function HeaderBar({ onOpenSidebar }: Props = {}) {
  const bot = useAppStore((s) => s.bot);
  const mode = useAppStore((s) => s.mode);
  const runningByMode = useAppStore((s) => s.runningByMode ?? {});
  const pushLog = useAppStore((s) => s.pushLog);
  const perSessionTradingMode = useAppStore((s) => s.perSessionTradingMode);
  const modeSwitchPending = useAppStore((s) => s.modeSwitchPending);
  const authActions = useAuthActions();

  const modeUpper = String(mode || "PAPER").toUpperCase();
  const runningForMode =
    runningByMode != null && Object.prototype.hasOwnProperty.call(runningByMode, modeUpper)
      ? Boolean((runningByMode as Record<string, boolean>)[modeUpper])
      : undefined;
  const botRunning = typeof runningForMode === "boolean" ? runningForMode : Boolean(bot?.running);
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
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          {/* Hamburger — opens AppSidebar */}
          <button
            type="button"
            aria-label="Open navigation sidebar"
            title="Navigation sidebar"
            onClick={onOpenSidebar}
            className="flex h-9 w-9 items-center justify-center rounded-md text-slate-600 hover:bg-slate-200/70 dark:text-slate-400 dark:hover:bg-slate-800"
          >
            <svg width="18" height="14" viewBox="0 0 18 14" fill="none" aria-hidden>
              <rect x="0" y="0" width="18" height="2" rx="1" fill="currentColor" />
              <rect x="0" y="6" width="18" height="2" rx="1" fill="currentColor" />
              <rect x="0" y="12" width="18" height="2" rx="1" fill="currentColor" />
            </svg>
          </button>
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
          <div className="flex shrink-0 flex-wrap items-center gap-2 sm:gap-2.5" title={modeSelectTitle}>
            <div
              className="flex max-w-[min(100vw-8rem,22rem)] flex-wrap items-center gap-1.5 sm:max-w-none sm:gap-2"
              title="Parallel engines: each trading mode has its own bot. Green = running for that mode."
            >
              {(Object.keys(MODE_LABELS) as Array<keyof typeof MODE_LABELS>).map((m) => {
                const on = Boolean(runningByMode[m]);
                const activeUi = String(mode || "").toUpperCase() === m;
                return (
                  <span
                    key={m}
                    className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-semibold leading-none tabular-nums sm:text-xs ${
                      activeUi
                        ? "border-sky-500/60 bg-sky-500/15 text-sky-900 dark:text-sky-100"
                        : "border-slate-300/80 bg-white/60 text-slate-600 dark:border-slate-600 dark:bg-slate-900/40 dark:text-slate-400"
                    }`}
                  >
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${on ? "bg-emerald-500 shadow-sm shadow-emerald-500/40" : "bg-slate-400/70 dark:bg-slate-600"}`}
                      aria-hidden
                    />
                    {MODE_LABELS[m] ?? m}
                  </span>
                );
              })}
            </div>

            <select
              className="max-w-[9.5rem] truncate rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-200/55 dark:bg-slate-100 dark:bg-slate-900/40 px-2 py-1 text-xs font-medium text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:bg-slate-900 disabled:cursor-wait disabled:opacity-60 sm:max-w-none"
              value={mode || "PAPER"}
              disabled={Boolean(modeSwitchPending)}
              aria-busy={Boolean(modeSwitchPending)}
              onChange={(e) => {
                const next = e.target.value;
                deferTask(() => {
                  void (async () => {
                    const sessionHint = perSessionTradingMode
                      ? " This choice applies only to your login (session); other users keep their own view."
                      : "";
                    const ok =
                      next === "BINANCE_LIVE"
                        ? window.confirm(
                            `BINANCE LIVE (mainnet): real funds — losses possible. Requires BINANCE_LIVE_TRADING_ENABLED=1 on the server. Other modes’ bots keep running.${sessionHint} Continue?`,
                          )
                        : window.confirm(
                            `Switch UI to ${next}? Bots for other modes keep running in the background; Start/Stop applies to each mode separately.${sessionHint}`,
                          );
                    if (!ok) return;
                    try {
                      await api.setMode(next as any);
                      pushLog({ level: "warn", msg: "Mode switch requested", mode: next });
                    } catch (e) {
                      const detail = e instanceof Error ? e.message : String(e);
                      pushLog({ level: "error", msg: `Mode switch failed: ${detail}` });
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

            {modeSwitchPending ? (
              <span
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center"
                title={`Switching to ${MODE_LABELS[modeSwitchPending] ?? modeSwitchPending}…`}
                aria-hidden
              >
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-sky-500 border-t-transparent dark:border-sky-400" />
              </span>
            ) : null}

            {authActions?.gated && perSessionTradingMode ? (
              <span
                className="max-w-[14rem] rounded-md border border-sky-500/45 bg-sky-500/10 px-2 py-1 text-[10px] font-semibold leading-snug text-sky-950 dark:border-sky-400/40 dark:bg-sky-500/15 dark:text-sky-100 sm:max-w-xs sm:text-[11px]"
                title="Trading mode is stored in your session and in this browser per account. It does not change other users’ views."
              >
                Mode is per login: other accounts are unaffected.
              </span>
            ) : null}

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
                    const m = String(mode || "PAPER").toUpperCase() as
                      | "PAPER"
                      | "BINANCE_DEMO_API"
                      | "BINANCE_TESTNET"
                      | "BINANCE_LIVE";
                    if (botRunning) {
                      const out = await api.botStop({ reason: "ui_header_bar", mode: m });
                      mergeBotFromApi(out?.bot, { runningByMode: out?.runningByMode });
                    } else {
                      const out = await api.botStart({ reason: "ui_header_bar", mode: m });
                      mergeBotFromApi(out?.bot, { runningByMode: out?.runningByMode });
                      playEngineStartSound();
                    }
                  } catch (e: unknown) {
                    const detail = e instanceof Error ? e.message : String(e);
                    pushLog({ level: "error", msg: `Failed to toggle bot: ${detail}` });
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
