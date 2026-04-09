/**
 * Align server Supertrend trades with the chart panel: same candle sanitize + marker visibility
 * rules as `frontend/src/lib/supertrend.ts` `buildChartSupertrend`.
 */

function median(values) {
  if (!values?.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function roughlyLTE(a, b, tolAbs) {
  return a <= b + tolAbs;
}

/** Oldest-first, deduped bar open times (matches frontend `sanitizeCandlesForSt`). */
export function sanitizeCandlesForSt(candles) {
  const rows = [];
  for (const c of candles || []) {
    const ts = Number(c.ts);
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    if (
      !Number.isFinite(ts) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      continue;
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    const maxOc = Math.max(open, close);
    const minOc = Math.min(open, close);
    const tolAbs = Math.max(1e-12, maxOc * 1e-9);
    if (!roughlyLTE(maxOc, high, tolAbs)) continue;
    if (!roughlyLTE(low, minOc, tolAbs)) continue;
    if (high < low) continue;
    rows.push({ ts, open, high, low, close });
  }
  rows.sort((a, b) => a.ts - b.ts);
  const dedup = [];
  for (const bar of rows) {
    if (dedup.length && dedup[dedup.length - 1].ts === bar.ts) dedup[dedup.length - 1] = bar;
    else dedup.push(bar);
  }
  const out = [];
  const lookback = 50;
  const mult = 18;
  for (const bar of dedup) {
    const r = Number(bar.high) - Number(bar.low);
    if (!Number.isFinite(r) || r <= 0) continue;
    const recent = out.slice(Math.max(0, out.length - lookback));
    const recentRanges = recent
      .map((x) => Number(x.high) - Number(x.low))
      .filter((x) => Number.isFinite(x) && x > 0);
    const med = median(recentRanges);
    if (med != null && med > 0 && r > med * mult) continue;
    out.push(bar);
  }
  return out;
}

export function binanceIntervalMs(interval) {
  const s = String(interval ?? "1m").trim().toLowerCase();
  const m = /^(\d+)(m|h|d|w)$/i.exec(s);
  if (!m) return 60_000;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 60_000;
  const u = m[2].toLowerCase();
  if (u === "m") return n * 60_000;
  if (u === "h") return n * 3_600_000;
  if (u === "d") return n * 86_400_000;
  if (u === "w") return n * 7 * 86_400_000;
  return 60_000;
}

/**
 * True iff the chart would add a buy/sell marker for this bar index (see `buildChartSupertrend` loop).
 */
export function chartMarkerVisibleForBar({ clean, series, barIndex, timeframe, nowMs }) {
  const r = series[barIndex];
  if (!r?.ready) return false;
  const lastIdx = series.length - 1;
  const barMs = binanceIntervalMs(timeframe);
  if (barIndex === lastIdx) {
    const openTs = Number(clean[barIndex]?.ts);
    if (Number.isFinite(openTs) && barMs > 0 && nowMs < openTs + barMs - 250) {
      return false;
    }
  }
  return Boolean(r.buySignal || r.sellSignal);
}

/**
 * Heuristic 0–1: distance from close to band line in (ATR×multiplier) units, capped.
 * Higher ≈ stronger separation from the band at the flip bar (not a guarantee of profit).
 */
export function computeSupertrendSignalStrength01({ row, candle, multiplier }) {
  const close = Number(candle?.close);
  const line = Number(row?.line);
  const atr = Number(row?.atr);
  const m = Math.max(0.5, Number(multiplier) || 3);
  if (!Number.isFinite(close) || !Number.isFinite(line) || !Number.isFinite(atr) || atr <= 0) return null;
  const bandScale = atr * m;
  const dist = Math.abs(close - line) / (bandScale + 1e-12);
  return Math.max(0, Math.min(1, dist / 1.5));
}
