import { useMemo, useState } from "react";
import { useAppStore } from "../ws/store";
import { MicroEventFeedStatusPanel } from "./MicroEventFeedStatus";
import type { MicroEventFeedStatus } from "./MicroEventFeedStatus";

export type MicroEventDetectorRow = {
  id: string;
  label: string;
  pass: boolean;
  value?: string;
  threshold?: string;
  detail?: string;
};

export type MicroEventCoinRadar = {
  symbol: string;
  phase: string;
  primarySide?: string | null;
  confluenceScore?: number;
  minConfluenceScore?: number;
  confirmCount?: number;
  minConfirmLayers?: number;
  failedGate?: string | null;
  fadeAction?: string | null;
  cooldownRemainingMs?: number;
  tradesThisHour?: number;
  maxTradesPerHour?: number;
  frequencyOk?: boolean;
  detectors?: MicroEventDetectorRow[];
};

export type MicroEventTapeRow = {
  time: number;
  symbol: string;
  kind: "signal" | "skip" | string;
  action?: string;
  reason?: string;
  score?: number;
  layers?: Record<string, boolean>;
  source?: string;
};

export type MicroEventReadinessGate = {
  id: string;
  label: string;
  ok: boolean;
  hint: string;
};

export type MicroEventOpenPosition = {
  symbol: string;
  side: string;
  entryPrice?: number;
  qty?: number;
  confluenceScore?: number | null;
  ageSec?: number | null;
  maxHoldSec?: number | null;
  holdPct?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
};

export type MicroEventRadarStatus = {
  updatedAt?: number;
  mode?: "tick" | "bar_close";
  botRunning?: boolean;
  tickEngineRunning?: boolean;
  focusSymbol?: string;
  headline?: string;
  readinessGates?: MicroEventReadinessGate[];
  effectiveConfig?: Record<string, unknown>;
  coins?: MicroEventCoinRadar[];
  tape?: MicroEventTapeRow[];
  openPositions?: MicroEventOpenPosition[];
  feedStatus?: MicroEventFeedStatus;
  validationStatus?: { label?: string; certified?: boolean; note?: string };
};

const PHASE_LABEL: Record<string, string> = {
  SCANNING: "Scanning",
  SPIKE: "Liq spike",
  BUILDING: "Building confluence",
  ARMED: "Armed",
};

const PHASE_CLS: Record<string, string> = {
  SCANNING: "bg-slate-500/90 text-white",
  SPIKE: "bg-amber-500 text-white",
  BUILDING: "bg-violet-600 text-white",
  ARMED: "bg-emerald-600 text-white animate-pulse",
};

function fmtCountdown(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "ready";
  const sec = Math.ceil(ms / 1000);
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${sec}s`;
}

function ScoreGauge({ score, threshold }: { score: number | null | undefined; threshold: number }) {
  const val = Number(score);
  const max = Math.max(threshold * 1.2, 100);
  const pct = Number.isFinite(val) ? Math.min(100, Math.max(0, (val / max) * 100)) : 0;
  const hit = Number.isFinite(val) && val >= threshold;
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[9px] text-slate-500 dark:text-slate-400">
        <span>Confluence</span>
        <span className={`font-mono tabular-nums ${hit ? "text-emerald-600 dark:text-emerald-400" : ""}`}>
          {Number.isFinite(val) ? val : "—"} / {threshold}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div
          className={`h-full transition-all duration-500 ${hit ? "bg-emerald-500" : "bg-violet-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function CoinCard({
  coin,
  isFocus,
  onFocus,
}: {
  coin: MicroEventCoinRadar;
  isFocus: boolean;
  onFocus: () => void;
}) {
  const phase = coin.phase ?? "SCANNING";
  const phaseCls = PHASE_CLS[phase] ?? PHASE_CLS.SCANNING;
  const minScore = coin.minConfluenceScore ?? 55;

  return (
    <div
      className={`rounded-lg border p-2.5 transition-shadow ${
        isFocus
          ? "border-violet-400/80 bg-violet-50/50 shadow-sm dark:border-violet-700 dark:bg-violet-950/20"
          : "border-slate-200 bg-white/60 dark:border-slate-700 dark:bg-slate-900/40"
      } ${phase === "ARMED" ? "ring-1 ring-emerald-400/50" : ""}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onFocus}
          className="text-[11px] font-bold tracking-wide text-slate-900 hover:text-violet-700 dark:text-slate-100 dark:hover:text-violet-300"
        >
          {coin.symbol}
        </button>
        <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${phaseCls}`}>
          {PHASE_LABEL[phase] ?? phase}
        </span>
        {coin.fadeAction ? (
          <span className="font-mono text-[9px] text-slate-500">→ {coin.fadeAction}</span>
        ) : null}
        {coin.failedGate && phase !== "ARMED" ? (
          <span className="text-[8px] text-amber-700 dark:text-amber-400">gate: {coin.failedGate}</span>
        ) : null}
      </div>

      <ScoreGauge score={coin.confluenceScore} threshold={minScore} />

      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[9px]">
        <div className="text-slate-500">Confirm layers</div>
        <div className="text-right font-mono tabular-nums">
          {coin.confirmCount ?? 0}/{coin.minConfirmLayers ?? 2}
        </div>
        <div className="text-slate-500">Cooldown</div>
        <div className="text-right font-mono tabular-nums">{fmtCountdown(coin.cooldownRemainingMs)}</div>
        <div className="text-slate-500">Trades/hr</div>
        <div className="text-right font-mono tabular-nums">
          {coin.tradesThisHour ?? 0}/{coin.maxTradesPerHour ?? 12}
        </div>
      </div>

      <dl className="mt-2 space-y-0.5 border-t border-slate-200/80 pt-2 dark:border-slate-700/80">
        {(coin.detectors ?? []).map((d) => (
          <div key={d.id} className="flex items-baseline justify-between gap-2 text-[9px]">
            <dt className="text-slate-500 dark:text-slate-400">{d.label}</dt>
            <dd
              className={`text-right font-mono tabular-nums ${
                d.pass ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"
              }`}
            >
              {d.value ?? "—"} {d.pass ? "✓" : "✗"}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function EventTape({ tape }: { tape: MicroEventTapeRow[] }) {
  if (!tape?.length) {
    return (
      <p className="text-[10px] text-slate-500 dark:text-slate-400">
        No recent signals or near-misses — engine quiet or bot off.
      </p>
    );
  }
  return (
    <div className="max-h-36 overflow-y-auto rounded border border-slate-200/80 bg-slate-50/80 dark:border-slate-700 dark:bg-slate-950/40">
      <ul className="divide-y divide-slate-200/60 dark:divide-slate-800">
        {tape.map((row, i) => (
          <li
            key={`${row.symbol}-${row.time}-${i}`}
            className="flex flex-wrap items-center gap-x-2 px-2 py-1 text-[10px] font-mono tabular-nums"
          >
            <span className="text-slate-500">{new Date(row.time).toLocaleTimeString()}</span>
            <span className="font-semibold">{row.symbol}</span>
            <span
              className={
                row.kind === "signal"
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-amber-600 dark:text-amber-400"
              }
            >
              {row.kind === "signal" ? row.action ?? "SIGNAL" : "SKIP"}
            </span>
            {row.score != null ? <span>score={row.score}</span> : null}
            {row.reason ? <span className="text-slate-600 dark:text-slate-400">{row.reason}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OpenPositionsTable({ rows }: { rows: MicroEventOpenPosition[] }) {
  if (!rows?.length) {
    return <p className="text-[10px] text-slate-500">No open MICRO_EVENT positions.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[10px]">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="pb-1 pr-2">Symbol</th>
            <th className="pb-1 pr-2">Side</th>
            <th className="pb-1 pr-2">Age</th>
            <th className="pb-1 pr-2">Max hold</th>
            <th className="pb-1">Score</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={`${p.symbol}-${p.side}`} className="border-t border-slate-200/60 dark:border-slate-800">
              <td className="py-1 pr-2 font-semibold">{p.symbol}</td>
              <td className="py-1 pr-2">{p.side}</td>
              <td className="py-1 pr-2 font-mono">{p.ageSec != null ? `${p.ageSec}s` : "—"}</td>
              <td className="py-1 pr-2">
                {p.maxHoldSec != null && p.holdPct != null ? (
                  <div className="flex items-center gap-1">
                    <div className="h-1 w-12 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                      <div
                        className={`h-full ${p.holdPct >= 90 ? "bg-rose-500" : "bg-violet-500"}`}
                        style={{ width: `${Math.min(100, p.holdPct)}%` }}
                      />
                    </div>
                    <span className="font-mono">{p.maxHoldSec}s</span>
                  </div>
                ) : (
                  "—"
                )}
              </td>
              <td className="py-1 font-mono">{p.confluenceScore ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MicroEventRadarPanel({ status }: { status: MicroEventRadarStatus | null | undefined }) {
  const setChartDisplaySymbol = useAppStore((s) => s.setChartDisplaySymbol);
  const botSymbol = useAppStore((s) => String(s.bot?.symbol ?? "").toUpperCase());
  const coins = status?.coins ?? [];
  const focusSymbol = String(status?.focusSymbol ?? botSymbol).toUpperCase();

  const headline = useMemo(() => status?.headline ?? "Waiting for data…", [status?.headline]);

  if (!status?.coins?.length) {
    return (
      <div className="rounded-xl border border-violet-300/70 bg-violet-50/80 px-3 py-2 text-[11px] text-violet-900 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-200">
        MICRO_EVENT radar pending… select MICRO_EVENT and start the bot.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-violet-400/70 bg-gradient-to-br from-violet-50/90 to-slate-50/80 px-3 py-2.5 dark:border-violet-800 dark:from-violet-950/30 dark:to-slate-950/40">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-900 dark:text-violet-100">
          Micro event radar
        </span>
        <span className="rounded bg-violet-700 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {status.mode === "tick" ? "LIVE TICK" : "BAR CLOSE"}
        </span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${
            status.botRunning ? "bg-emerald-600 text-white" : "bg-slate-500 text-white"
          }`}
        >
          {status.botRunning ? "BOT ON" : "BOT OFF"}
        </span>
        <span className="text-[10px] text-slate-600 dark:text-slate-400">{headline}</span>
      </div>

      {status.readinessGates?.length ? (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {status.readinessGates.map((g) => (
            <span
              key={g.id}
              title={g.hint}
              className={`rounded px-1.5 py-0.5 text-[9px] font-medium ${
                g.ok
                  ? "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300"
                  : "bg-rose-500/15 text-rose-800 dark:text-rose-300"
              }`}
            >
              {g.label}: {g.ok ? "OK" : "FIX"}
            </span>
          ))}
        </div>
      ) : null}

      {status.feedStatus ? (
        <div className="mb-2">
          <MicroEventFeedStatusPanel status={status.feedStatus} />
        </div>
      ) : null}

      <div
        className={`mb-3 grid gap-2 ${coins.length >= 3 ? "sm:grid-cols-3" : coins.length === 2 ? "sm:grid-cols-2" : "grid-cols-1"}`}
      >
        {coins.map((coin) => (
          <CoinCard
            key={coin.symbol}
            coin={coin}
            isFocus={coin.symbol === focusSymbol}
            onFocus={() => {
              const primary = botSymbol;
              setChartDisplaySymbol(coin.symbol === primary ? null : coin.symbol);
            }}
          />
        ))}
      </div>

      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
              Signal & near-miss tape
            </span>
            <span className="text-[9px] text-slate-500">{status.tape?.length ?? 0} recent</span>
          </div>
          <EventTape tape={status.tape ?? []} />
        </div>
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
            Open MICRO_EVENT positions
          </div>
          <OpenPositionsTable rows={status.openPositions ?? []} />
        </div>
      </div>

      <p className="text-[9px] text-slate-500 dark:text-slate-400">
        Read-only process view — same detectors as live engine. {status.validationStatus?.note ?? ""}
      </p>
    </div>
  );
}
