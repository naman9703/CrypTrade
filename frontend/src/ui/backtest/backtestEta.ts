/**
 * ETA helpers for backtest runs: rough total from bar count + engine heuristics,
 * and remaining time from linear extrapolation of server progress %.
 */

const TF_MS: Record<string, number> = {
  "1m": 60_000,
  "3m": 3 * 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "6h": 6 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "12h": 12 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export function approxBarCount(startDateIso: string, endDateIso: string, timeframe: string): number {
  const fromMs = Date.parse(startDateIso);
  const toMs = Date.parse(endDateIso);
  const step = TF_MS[String(timeframe).toLowerCase()];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || !step) return 0;
  return Math.max(0, Math.floor((toMs - fromMs) / step));
}

/** Order-of-magnitude total runtime (seconds) before we have meaningful %. */
export function roughTotalSeconds(bars: number, engineType: string | null | undefined): number {
  const et = String(engineType ?? "").toUpperCase();
  const prep = et === "SURF_PULSE_ML" ? 45 : 10;
  const per1k = et === "SURF_PULSE_ML" ? 3.2 : 0.2;
  const sim = (bars / 1000) * per1k;
  return Math.max(15, prep + sim);
}

export function formatDurationSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${Math.max(1, Math.round(sec))}s`;
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export type EtaParts = {
  /** Linear extrapolation from progress; null if not enough signal yet. */
  remainingSec: number | null;
  /** Coarse guess from bars × engine (always when bars > 0). */
  roughTotalSec: number;
};

export const MIN_PCT_FOR_EXTRAP = 4;

/**
 * @param pct 0–100 progress as shown in the UI (matches worker / DB)
 * @param anchorIso startedAt preferred, else createdAt
 */
export function computeEtaParts(
  pct: number,
  anchorIso: string | null | undefined,
  nowMs: number,
  bars: number,
  engineType: string | null | undefined,
): EtaParts {
  const roughTotalSec = bars > 0 ? roughTotalSeconds(bars, engineType) : 60;
  if (!anchorIso) return { remainingSec: null, roughTotalSec };

  const t0 = Date.parse(String(anchorIso));
  if (!Number.isFinite(t0) || t0 > nowMs) return { remainingSec: null, roughTotalSec };

  const elapsedSec = (nowMs - t0) / 1000;
  const p = Math.min(100, Math.max(0, pct));
  if (p < MIN_PCT_FOR_EXTRAP || elapsedSec < 2) {
    return { remainingSec: null, roughTotalSec };
  }

  const totalPred = elapsedSec / (p / 100);
  const remainingSec = Math.max(0, totalPred - elapsedSec);
  const cap = roughTotalSec * 8;
  const capped = Math.min(remainingSec, Number.isFinite(cap) ? cap : remainingSec);
  return { remainingSec: capped, roughTotalSec };
}
