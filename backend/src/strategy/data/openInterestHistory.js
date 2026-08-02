/** Rolling OI poll samples for live 1m/5m delta (REST poll cadence ~10s). */

/** @type {Map<string, { oi: number, ts: number }[]>} */
const oiHistory = new Map();
/** ~10 min at 10s poll cadence */
const OI_HIST_MAX = 64;

function normSym(symbol) {
  return String(symbol || "").trim().toUpperCase();
}

export function recordOpenInterestSample(symbol, oi, ts = Date.now()) {
  const sym = normSym(symbol);
  if (!(oi > 0)) return;
  let arr = oiHistory.get(sym) ?? [];
  arr.push({ oi, ts });
  if (arr.length > OI_HIST_MAX) arr = arr.slice(-OI_HIST_MAX);
  oiHistory.set(sym, arr);
}

export function oiDeltaPctFromHistory(symbol, windowMs, now = Date.now()) {
  const arr = oiHistory.get(normSym(symbol)) ?? [];
  if (arr.length < 2) return null;
  const cutoff = now - windowMs;
  const recent = arr.filter((x) => x.ts >= cutoff);
  if (recent.length < 2) return null;
  const spanMs = recent[recent.length - 1].ts - recent[0].ts;
  if (spanMs < windowMs * 0.5) return null;
  const first = recent[0].oi;
  const last = recent[recent.length - 1].oi;
  if (!(first > 0)) return null;
  return ((last - first) / first) * 100;
}
