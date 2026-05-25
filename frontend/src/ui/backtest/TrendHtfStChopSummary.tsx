/**
 * Summarizes structural chop risk on TREND_HTF_ST backtest trades
 * (Jun–Dec 2025 style losses vs trend-friendly entries).
 */
import type { BacktestTrade } from "../../types/backtest";

type Props = { trades: BacktestTrade[] };

const FLAG_LABELS: Record<string, string> = {
  HTF_EMA_CROSS_RECENT: "1h EMA21/50 crossed recently",
  HTF_SEP_SHRINKING: "HTF trend separation shrinking",
  REGIME_SIDEWAYS: "15m sideways regime (low ADX)",
  ADX_LOW: "ADX below threshold",
  ST_WHIPSAW: "Multiple ST flips in 4h",
  COUNTER_SIGNAL_BAR: "Signal bar against direction",
  SPIKE_BAR: "Spike bar (>2× ATR)",
  HTF_SEP_MIN: "HTF sep at minimum gate",
  REGIME_VOLATILE: "High volatility regime",
};

export function TrendHtfStChopSummary({ trades }: Props) {
  const tagged = trades.filter((t) => t.entryQuality != null);
  if (!tagged.length) return null;

  const losses = tagged.filter((t) => t.netPnl < 0);
  const chopLosses = losses.filter((t) => t.entryQuality?.structuralRisk === "CHOP_ZONE");
  const wouldBlock = tagged.filter((t) => t.entryQuality?.wouldBlock);
  const blockLosses = wouldBlock.filter((t) => t.netPnl < 0);
  const blockWins = wouldBlock.filter((t) => t.netPnl >= 0);

  const patternCounts: Record<string, number> = {};
  for (const t of losses) {
    const p = t.lossPattern ?? "UNKNOWN";
    patternCounts[p] = (patternCounts[p] || 0) + 1;
  }

  const flagOnLosses: Record<string, number> = {};
  for (const t of losses) {
    for (const f of t.entryQuality?.flags ?? []) {
      flagOnLosses[f] = (flagOnLosses[f] || 0) + 1;
    }
  }

  return (
    <div className="rounded-lg border border-amber-300/80 bg-amber-50/80 px-3 py-2 text-[11px] text-amber-950 dark:border-amber-700 dark:bg-amber-950/30 dark:text-amber-100">
      <div className="font-semibold text-[12px]">Structural chop analysis (TREND_HTF_ST)</div>
      <p className="mt-1 text-amber-900/90 dark:text-amber-200/90">
        H2 2025 losses were mostly entries during weak 1h trends: recent EMA cross, sideways 15m, shrinking HTF
        separation, and ST whipsaw. Production uses <span className="font-mono">trendHtfStRegimeGate</span> (default ON)
        with macro season switching.
      </p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Losses in CHOP_ZONE" value={`${chopLosses.length} / ${losses.length}`} />
        <Stat label="Chop filter would block" value={`${wouldBlock.length} trades`} />
        <Stat
          label="If filtered (est.)"
          value={`−${blockLosses.length} losses, −${blockWins.length} wins`}
        />
        <Stat
          label="Avg score (W/L)"
          value={`${avg(tagged.filter((t) => t.netPnl >= 0), "score")} / ${avg(losses, "score")}`}
        />
      </div>
      {Object.keys(patternCounts).length > 0 && (
        <div className="mt-2">
          <div className="font-medium text-[10px] uppercase tracking-wide opacity-80">Loss patterns</div>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {Object.entries(patternCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([k, n]) => (
                <li
                  key={k}
                  className="rounded bg-amber-200/60 px-1.5 py-0.5 font-mono text-[10px] dark:bg-amber-900/50"
                >
                  {k} ×{n}
                </li>
              ))}
          </ul>
        </div>
      )}
      {Object.keys(flagOnLosses).length > 0 && (
        <div className="mt-2">
          <div className="font-medium text-[10px] uppercase tracking-wide opacity-80">Flags on losing trades</div>
          <ul className="mt-1 space-y-0.5 text-[10px]">
            {Object.entries(flagOnLosses)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 6)
              .map(([f, n]) => (
                <li key={f}>
                  <span className="font-mono">{f}</span>
                  <span className="opacity-70"> — {FLAG_LABELS[f] ?? f}</span>
                  <span className="ml-1 font-semibold">({n})</span>
                </li>
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-amber-200/60 bg-white/50 px-2 py-1 dark:border-amber-800 dark:bg-slate-900/40">
      <div className="text-[9px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="font-mono text-[12px] font-semibold">{value}</div>
    </div>
  );
}

function avg(trades: BacktestTrade[], field: "score"): string {
  if (!trades.length) return "—";
  const s = trades.reduce((a, t) => a + Number(t.entryQuality?.[field] ?? 0), 0) / trades.length;
  return s.toFixed(0);
}
