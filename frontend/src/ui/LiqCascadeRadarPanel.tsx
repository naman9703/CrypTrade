import { useMemo, useState } from "react";
import { useAppStore } from "../ws/store";
import { LiqCascadeFeedStatusPanel } from "./LiqCascadeFeedStatus";
import type { LiqCascadeFeedStatus } from "./LiqCascadeFeedStatus";

export type LiqCascadeGateRow = {
  key: string;
  label: string;
  pass: boolean;
  value?: number | string | null;
  threshold?: number | string | null;
  display?: string;
};

export type LiqCascadeCoinRadar = {
  symbol: string;
  phase: string;
  fadeAction?: string | null;
  zScore?: number | null;
  zThreshold?: number;
  liqUsd?: number;
  liqMin?: number;
  domSide?: string;
  oiChange4hPct?: number | null;
  dispAtr?: number | null;
  dispMin?: number;
  atrPct?: number | null;
  decayRatio?: number | null;
  decayTarget?: number;
  buildingBarUsd?: number;
  recentTickCount15m?: number;
  lastForceOrderMs?: number | null;
  nextLiqBarCloseMs?: number;
  msToBarClose?: number;
  tickCascadeActive?: boolean;
  gates?: LiqCascadeGateRow[];
  gatesPassed?: number;
  gatesTotal?: number;
};

export type LiqCascadeTapeRow = {
  symbol: string;
  time: number;
  side: string;
  notionalUsd: number;
  price?: number | null;
  forcedSide?: string;
};

export type LiqCascadeRadarStatus = {
  updatedAt?: number;
  mode?: "tick" | "bar_close";
  botRunning?: boolean;
  tickEngineRunning?: boolean;
  liqStreamOk?: boolean;
  lastForceOrderMs?: number | null;
  focusSymbol?: string;
  effectiveConfig?: {
    liqCascadeInterval?: string;
    liqCascadeZScoreMin?: number;
    liqCascadeMinLiqUsdBar?: number;
    liqCascadeMinDispAtr?: number;
    liqCascadeOiGateMode?: string;
    liqCascadeMinRr?: number;
    onState?: Record<string, unknown>;
  };
  coins?: LiqCascadeCoinRadar[];
  tape?: LiqCascadeTapeRow[];
  feedStatus?: LiqCascadeFeedStatus;
};

const PHASE_LABEL: Record<string, string> = {
  SCANNING: "Scanning",
  SPIKE: "Liq spike",
  CASCADE: "Cascade",
  EXHAUSTION: "Exhaustion",
  CONFIRM: "Confirm",
  ARMED: "Armed",
  COOLDOWN: "Cooldown",
};

const PHASE_CLS: Record<string, string> = {
  SCANNING: "bg-slate-500/90 text-white",
  SPIKE: "bg-amber-500 text-white",
  CASCADE: "bg-orange-600 text-white",
  EXHAUSTION: "bg-rose-600 text-white animate-pulse",
  CONFIRM: "bg-violet-600 text-white",
  ARMED: "bg-emerald-600 text-white animate-pulse",
  COOLDOWN: "bg-slate-600 text-white",
};

function fmtAge(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "never";
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ago`;
}

function fmtCountdown(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "closing…";
  const sec = Math.ceil(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function fmtUsd(v: number | null | undefined): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `$${Math.round(n).toLocaleString()}`;
  if (n >= 100) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

function ZGauge({ z, threshold }: { z: number | null | undefined; threshold: number }) {
  const val = Number(z);
  const max = Math.max(threshold * 1.5, 3);
  const pct = Number.isFinite(val) ? Math.min(100, Math.max(0, (val / max) * 100)) : 0;
  const hit = Number.isFinite(val) && val >= threshold;
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[9px] text-slate-500 dark:text-slate-400">
        <span>Z-score</span>
        <span className={`font-mono tabular-nums ${hit ? "text-emerald-600 dark:text-emerald-400" : ""}`}>
          {Number.isFinite(val) ? val.toFixed(2) : "—"} / {threshold.toFixed(1)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
        <div
          className={`h-full transition-all duration-500 ${hit ? "bg-emerald-500" : "bg-cyan-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function fmtLiqBarLabel(interval?: string | null): string {
  const s = String(interval ?? "5min").toLowerCase();
  if (s === "1min") return "1m";
  if (s === "5min") return "5m";
  if (s === "15min") return "15m";
  return s.replace(/min$/i, "m");
}

function CoinCard({
  coin,
  liqBarLabel,
  expanded,
  onToggle,
  onFocus,
  isFocus,
}: {
  coin: LiqCascadeCoinRadar;
  liqBarLabel: string;
  expanded: boolean;
  onToggle: () => void;
  onFocus: () => void;
  isFocus: boolean;
}) {
  const phase = coin.phase ?? "SCANNING";
  const phaseCls = PHASE_CLS[phase] ?? PHASE_CLS.SCANNING;
  const zThreshold = coin.zThreshold ?? 2;

  return (
    <div
      className={`rounded-lg border p-2.5 transition-shadow ${
        isFocus
          ? "border-cyan-400/80 bg-cyan-50/50 shadow-sm dark:border-cyan-700 dark:bg-cyan-950/20"
          : "border-slate-200 bg-white/60 dark:border-slate-700 dark:bg-slate-900/40"
      } ${phase === "EXHAUSTION" || phase === "ARMED" ? "ring-1 ring-amber-400/50" : ""}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onFocus}
          className="text-[11px] font-bold tracking-wide text-slate-900 hover:text-cyan-700 dark:text-slate-100 dark:hover:text-cyan-300"
          title="Focus chart on this symbol"
        >
          {coin.symbol}
        </button>
        <span className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${phaseCls}`}>
          {PHASE_LABEL[phase] ?? phase}
        </span>
        {coin.fadeAction ? (
          <span className="font-mono text-[9px] text-slate-500 dark:text-slate-400">fade → {coin.fadeAction}</span>
        ) : null}
        {coin.tickCascadeActive ? (
          <span className="rounded bg-orange-500/15 px-1 py-0.5 text-[8px] font-semibold text-orange-700 dark:text-orange-300">
            tick cascade
          </span>
        ) : null}
        <button
          type="button"
          onClick={onToggle}
          className="ml-auto text-[9px] text-cyan-700 hover:underline dark:text-cyan-400"
        >
          {expanded ? "Hide gates" : "Gates"}
        </button>
      </div>

      <ZGauge z={coin.zScore} threshold={zThreshold} />

      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-[9px]">
        <div className="text-slate-500 dark:text-slate-400">Liq (building)</div>
        <div className="text-right font-mono tabular-nums text-slate-800 dark:text-slate-200">
          {fmtUsd(coin.buildingBarUsd ?? coin.liqUsd)} / {fmtUsd(coin.liqMin)}
        </div>
        <div className="text-slate-500 dark:text-slate-400">Ticks (15m)</div>
        <div className="text-right font-mono tabular-nums">{coin.recentTickCount15m ?? 0}</div>
        <div className="text-slate-500 dark:text-slate-400">Last forceOrder</div>
        <div className="text-right font-mono tabular-nums">{fmtAge(coin.lastForceOrderMs)}</div>
        <div className="text-slate-500 dark:text-slate-400">{liqBarLabel} liq bar closes</div>
        <div className="text-right font-mono tabular-nums">{fmtCountdown(coin.msToBarClose)}</div>
      </div>

      {expanded && coin.gates?.length ? (
        <dl className="mt-2 space-y-0.5 border-t border-slate-200/80 pt-2 dark:border-slate-700/80">
          {coin.gates.map((g) => (
            <div key={g.key} className="flex items-baseline justify-between gap-2 text-[9px]">
              <dt className="text-slate-500 dark:text-slate-400">{g.label}</dt>
              <dd
                className={`font-mono tabular-nums ${
                  g.pass ? "text-emerald-700 dark:text-emerald-400" : "text-rose-700 dark:text-rose-400"
                }`}
              >
                {g.display ?? "—"} {g.pass ? "✓" : "✗"}
              </dd>
            </div>
          ))}
          <div className="pt-1 text-[8px] text-slate-500 dark:text-slate-400">
            {coin.gatesPassed ?? 0}/{coin.gatesTotal ?? coin.gates.length} gates passed
          </div>
        </dl>
      ) : null}
    </div>
  );
}

function LiquidationTape({ tape }: { tape: LiqCascadeTapeRow[] }) {
  if (!tape?.length) {
    return (
      <p className="text-[10px] text-slate-500 dark:text-slate-400">
        No forceOrder ticks in the last 15m — stream connected but quiet.
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
            <span className="text-slate-500 dark:text-slate-400">{new Date(row.time).toLocaleTimeString()}</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200">{row.symbol}</span>
            <span className={row.forcedSide === "longs" ? "text-rose-600 dark:text-rose-400" : "text-emerald-600 dark:text-emerald-400"}>
              {row.forcedSide === "longs" ? "LONG liq" : "SHORT liq"}
            </span>
            <span className="text-slate-700 dark:text-slate-300">{fmtUsd(row.notionalUsd)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LiqCascadeRadarPanel({ status }: { status: LiqCascadeRadarStatus | null | undefined }) {
  const [expandedSym, setExpandedSym] = useState<string | null>(null);
  const setChartDisplaySymbol = useAppStore((s) => s.setChartDisplaySymbol);
  const botSymbol = useAppStore((s) => String(s.bot?.symbol ?? "").toUpperCase());

  const coins = status?.coins ?? [];
  const focusSymbol = String(status?.focusSymbol ?? botSymbol).toUpperCase();

  const headline = useMemo(() => {
    if (!coins.length) return "Waiting for data…";
    const hot = coins.find((c) => c.phase !== "SCANNING" && c.phase !== "COOLDOWN");
    if (hot) return `${hot.symbol} · ${PHASE_LABEL[hot.phase] ?? hot.phase}`;
    return `Scanning ${coins.length} coin${coins.length > 1 ? "s" : ""}`;
  }, [coins]);

  if (!status?.coins?.length) {
    return (
      <div className="rounded-xl border border-cyan-300/70 bg-cyan-50/80 px-3 py-2 text-[11px] text-cyan-900 dark:border-cyan-800 dark:bg-cyan-950/30 dark:text-cyan-200">
        LIQ_CASCADE radar pending… start bot with LIQ_CASCADE selected.
      </div>
    );
  }

  const liqBarLabel = fmtLiqBarLabel(status.effectiveConfig?.liqCascadeInterval);

  return (
    <div className="rounded-xl border border-cyan-400/70 bg-gradient-to-br from-cyan-50/90 to-slate-50/80 px-3 py-2.5 dark:border-cyan-800 dark:from-cyan-950/30 dark:to-slate-950/40">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-cyan-900 dark:text-cyan-100">
          Cascade radar
        </span>
        <span className="rounded bg-cyan-700 px-1.5 py-0.5 text-[10px] font-semibold text-white">
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
        {status.effectiveConfig ? (
          <span className="rounded bg-slate-200/80 px-1.5 py-0.5 font-mono text-[9px] tabular-nums text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {status.effectiveConfig.liqCascadeInterval ?? "5min"} liq · z≥
            {status.effectiveConfig.liqCascadeZScoreMin ?? "?"} · $
            {Math.round(Number(status.effectiveConfig.liqCascadeMinLiqUsdBar ?? 0)).toLocaleString()}
          </span>
        ) : null}
        <span className="ml-auto text-[9px] text-slate-500 dark:text-slate-400">
          last tick {fmtAge(status.lastForceOrderMs)}
        </span>
      </div>

      {status.feedStatus ? (
        <div className="mb-2">
          <LiqCascadeFeedStatusPanel status={status.feedStatus} compact />
        </div>
      ) : null}

      <div className={`mb-3 grid gap-2 ${coins.length >= 3 ? "sm:grid-cols-3" : coins.length === 2 ? "sm:grid-cols-2" : "grid-cols-1"}`}>
        {coins.map((coin) => (
          <CoinCard
            key={coin.symbol}
            coin={coin}
            liqBarLabel={liqBarLabel}
            expanded={expandedSym === coin.symbol}
            isFocus={coin.symbol === focusSymbol}
            onToggle={() => setExpandedSym((s) => (s === coin.symbol ? null : coin.symbol))}
            onFocus={() => {
              const primary = botSymbol;
              setChartDisplaySymbol(coin.symbol === primary ? null : coin.symbol);
            }}
          />
        ))}
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:text-slate-400">
            Live liquidation tape
          </span>
          <span className="text-[9px] text-slate-500">{status.tape?.length ?? 0} recent</span>
        </div>
        <LiquidationTape tape={status.tape ?? []} />
      </div>

      <p className="mt-2 text-[9px] text-slate-500 dark:text-slate-400">
        Read-only hunt view — does not change signal timing. Phases update on forceOrder ticks (~750ms) and bar closes.
      </p>
    </div>
  );
}
