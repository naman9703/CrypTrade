import type { BacktestEquityPoint, BacktestTrade } from "../types/backtest";

export type MonthKey = `${number}-${string}`;

/** Parse trade timestamps from API (ISO string, ms number, or numeric string). */
export function parseTradeTs(v: string | number | null | undefined): number {
  if (v == null) return NaN;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const asNum = Number(v);
  if (Number.isFinite(asNum) && asNum > 1e11) return asNum;
  const parsed = Date.parse(String(v));
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function parseMonthKey(key: string): { year: number; monthIndex: number } | null {
  const [yStr, mStr] = key.split("-");
  const year = Number(yStr);
  const monthIndex = Number(mStr) - 1;
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex) || monthIndex < 0 || monthIndex > 11) {
    return null;
  }
  return { year, monthIndex };
}

function monthKeyFromTs(ts: number): string | null {
  if (!Number.isFinite(ts)) return null;
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Monthly PnL keyed by `YYYY-MM`, grouped by trade exit time (UTC). Matches backend metrics. */
export function monthlyPnlFromTrades(trades: BacktestTrade[]): Record<string, number> {
  const map: Record<string, number> = {};
  for (const t of trades) {
    const exit = parseTradeTs(t.exitTs);
    const key = monthKeyFromTs(exit);
    if (!key) continue;
    map[key] = (map[key] ?? 0) + Number(t.netPnl ?? 0);
  }
  return map;
}

function equityAfterTrade(t: BacktestTrade, prevEquity: number): number {
  const pnl = Number(t.netPnl ?? 0);
  const eqEntry = Number(t.equityAtEntry);
  if (Number.isFinite(eqEntry) && eqEntry > 0) return eqEntry + pnl;
  return prevEquity + pnl;
}

/** Compounded return % for [startTs, endTs] from sorted trade exits + equityAtEntry. */
export function periodReturnFromTrades(
  trades: BacktestTrade[],
  startTs: number,
  endTs: number,
  initialCapital: number,
): number | null {
  if (!trades.length) return null;
  const sorted = [...trades].sort((a, b) => parseTradeTs(a.exitTs) - parseTradeTs(b.exitTs));

  let equity = initialCapital;
  for (const t of sorted) {
    const exit = parseTradeTs(t.exitTs);
    if (!Number.isFinite(exit) || exit >= startTs) break;
    equity = equityAfterTrade(t, equity);
  }
  const equityAtStart = equity;

  for (const t of sorted) {
    const exit = parseTradeTs(t.exitTs);
    if (!Number.isFinite(exit) || exit < startTs) continue;
    if (exit > endTs) break;
    equity = equityAfterTrade(t, equity);
  }
  const equityAtEnd = equity;

  if (!Number.isFinite(equityAtStart) || equityAtStart <= 0) return null;
  return ((equityAtEnd - equityAtStart) / equityAtStart) * 100;
}

/** Equity at or before `ts` (walk-forward on sorted curve). */
export function equityAt(curve: BacktestEquityPoint[], ts: number, fallback: number): number {
  if (!curve.length) return fallback;
  if (ts < curve[0].ts) return fallback;
  let last = curve[0].equity;
  for (const p of curve) {
    if (p.ts <= ts) last = p.equity;
    else break;
  }
  return last;
}

function monthBoundsUtc(year: number, monthIndex: number) {
  const startTs = Date.UTC(year, monthIndex, 1);
  const endTs = Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999);
  return { startTs, endTs };
}

function dayBoundsUtc(year: number, monthIndex: number, day: number) {
  const startTs = Date.UTC(year, monthIndex, day);
  const endTs = Date.UTC(year, monthIndex, day, 23, 59, 59, 999);
  return { startTs, endTs };
}

export function periodReturnPct(
  curve: BacktestEquityPoint[] | null | undefined,
  startTs: number,
  endTs: number,
  initialCapital: number,
): number | null {
  if (!curve?.length) return null;
  const eqStart = equityAt(curve, startTs, initialCapital);
  const eqEnd = equityAt(curve, endTs, eqStart);
  if (!Number.isFinite(eqStart) || eqStart <= 0) return null;
  return ((eqEnd - eqStart) / eqStart) * 100;
}

export function monthlyReturnPct(
  monthKey: string,
  initialCapital: number,
  opts?: { trades?: BacktestTrade[] | null; curve?: BacktestEquityPoint[] | null },
): number | null {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return null;
  const { startTs, endTs } = monthBoundsUtc(parsed.year, parsed.monthIndex);
  if (opts?.trades?.length) {
    return periodReturnFromTrades(opts.trades, startTs, endTs, initialCapital);
  }
  return periodReturnPct(opts?.curve, startTs, endTs, initialCapital);
}

export function dailyPnlForMonth(trades: BacktestTrade[], monthKey: string): Map<number, number> {
  const parsed = parseMonthKey(monthKey);
  const out = new Map<number, number>();
  if (!parsed) return out;
  const { year, monthIndex } = parsed;
  for (const t of trades) {
    const exit = parseTradeTs(t.exitTs);
    if (!Number.isFinite(exit)) continue;
    const d = new Date(exit);
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== monthIndex) continue;
    const day = d.getUTCDate();
    out.set(day, (out.get(day) ?? 0) + Number(t.netPnl ?? 0));
  }
  return out;
}

export function tradesForDay(trades: BacktestTrade[], year: number, monthIndex: number, day: number): BacktestTrade[] {
  return trades.filter((t) => {
    const exit = parseTradeTs(t.exitTs);
    if (!Number.isFinite(exit)) return false;
    const d = new Date(exit);
    return d.getUTCFullYear() === year && d.getUTCMonth() === monthIndex && d.getUTCDate() === day;
  });
}

export function dailyReturnPct(
  year: number,
  monthIndex: number,
  day: number,
  initialCapital: number,
  opts?: { trades?: BacktestTrade[] | null; curve?: BacktestEquityPoint[] | null },
): number | null {
  const { startTs, endTs } = dayBoundsUtc(year, monthIndex, day);
  if (opts?.trades?.length) {
    return periodReturnFromTrades(opts.trades, startTs, endTs, initialCapital);
  }
  return periodReturnPct(opts?.curve, startTs, endTs, initialCapital);
}

export function formatReturnPct(pct: number | null): string {
  if (pct == null || !Number.isFinite(pct)) return "";
  const sign = pct >= 0 ? "+" : "";
  return `(${sign}${pct.toFixed(1)}%)`;
}

export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function monthLabel(monthKey: string): string {
  const parsed = parseMonthKey(monthKey);
  if (!parsed) return monthKey;
  return new Date(Date.UTC(parsed.year, parsed.monthIndex, 1)).toLocaleString(undefined, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Prefer trade-derived monthly PnL when trades are loaded (keeps drill-down in sync). */
export function resolveMonthlyPnl(
  metricsMonthly: Record<string, number> | null | undefined,
  trades: BacktestTrade[] | null | undefined,
): Record<string, number> {
  if (trades?.length) return monthlyPnlFromTrades(trades);
  return metricsMonthly ?? {};
}
