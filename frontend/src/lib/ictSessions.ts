/**
 * ICT session kill-zones (UTC) — mirrors backend sessionKillzones.js presets.
 */

export type IctSessionDef = {
  id: string;
  label: string;
  subtitle: string;
  startUtc: number;
  endUtc: number;
};

/** Sessions shown in backtest session breakdown pies. */
export const ICT_BACKTEST_SESSIONS: IctSessionDef[] = [
  { id: "ASIA", label: "Asia", subtitle: "00:00–04:00 UTC", startUtc: 0, endUtc: 4 },
  { id: "LONDON", label: "London", subtitle: "07:00–10:00 UTC", startUtc: 7, endUtc: 10 },
  { id: "NY", label: "New York", subtitle: "12:00–16:00 UTC", startUtc: 12, endUtc: 16 },
  { id: "OVERLAP", label: "London / NY overlap", subtitle: "14:00–16:00 UTC", startUtc: 14, endUtc: 16 },
];

export function inUtcHourWindow(hour: number, start: number, end: number): boolean {
  if (start <= end) return hour >= start && hour < end;
  return hour >= start || hour < end;
}

export function utcHourFromMs(tsMs: number): number {
  return new Date(tsMs).getUTCHours();
}

export function tradeEntryMs(entryTs: string | number | Date | null | undefined): number | null {
  if (entryTs == null || entryTs === "") return null;
  if (typeof entryTs === "number" && Number.isFinite(entryTs)) return entryTs;
  const ms = new Date(entryTs).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function tradeInSession(entryTs: string | number | Date | null | undefined, session: IctSessionDef): boolean {
  const ms = tradeEntryMs(entryTs);
  if (ms == null) return false;
  const h = utcHourFromMs(ms);
  return inUtcHourWindow(h, session.startUtc, session.endUtc);
}
