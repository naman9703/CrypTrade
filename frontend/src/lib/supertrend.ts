/**
 * Pine v4 Supertrend (TradingView built-in) — same semantics as `backend/src/strategy/supertrend.js`.
 * Used in the chart so the line matches the candle series actually rendered.
 */
import { isPlausibleCandleClose } from "./symbolPriceSanity";

export type StCandle = { ts: number; open: number; high: number; low: number; close: number };

export type StRow = {
  ts: number;
  ready: boolean;
  up?: number;
  dn?: number;
  trend?: number;
  line?: number;
  buySignal?: boolean;
  sellSignal?: boolean;
};

function median(values: number[]) {
  if (!values.length) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function roughlyLTE(a: number, b: number, tolAbs: number) {
  return a <= b + tolAbs;
}

export function computeSupertrendSeries(candles: StCandle[], opts: { period?: number; multiplier?: number; wilderAtr?: boolean } = {}): StRow[] {
  const period = Math.max(1, Number(opts.period ?? 10));
  const multiplier = Number(opts.multiplier ?? 3);
  const wilderAtr = opts.wilderAtr !== false;

  const out: StRow[] = [];
  const trArr: number[] = [];
  let atr: number | null = null;
  let prevClose: number | null = null;
  let finalUp: number | null = null;
  let finalDn: number | null = null;
  let trend = 1;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    const hl2 = (high + low) / 2;

    const tr =
      prevClose == null ? high - low : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trArr.push(tr);

    if (i < period - 1) {
      out.push({ ts: c.ts, ready: false });
      prevClose = close;
      continue;
    }

    if (wilderAtr) {
      if (i === period - 1) {
        atr = trArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
      } else if (atr != null) {
        atr = (atr * (period - 1) + tr) / period;
      }
    } else {
      atr = trArr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    }

    if (atr == null || !Number.isFinite(atr) || atr <= 0) {
      out.push({ ts: c.ts, ready: false });
      prevClose = close;
      continue;
    }

    const basicUp = hl2 - multiplier * atr;
    const basicDn = hl2 + multiplier * atr;
    const up1 = finalUp ?? basicUp;
    const dn1 = finalDn ?? basicDn;
    const pc = prevClose;

    const newFinalUp = pc > up1 ? Math.max(basicUp, up1) : basicUp;
    const newFinalDn = pc < dn1 ? Math.min(basicDn, dn1) : basicDn;

    const prevTrend = trend;
    if (trend === -1 && close > dn1) trend = 1;
    else if (trend === 1 && close < up1) trend = -1;

    const buySignal = trend === 1 && prevTrend === -1;
    const sellSignal = trend === -1 && prevTrend === 1;

    finalUp = newFinalUp;
    finalDn = newFinalDn;
    prevClose = close;

    out.push({
      ts: c.ts,
      ready: true,
      up: newFinalUp,
      dn: newFinalDn,
      trend,
      line: trend === 1 ? newFinalUp : newFinalDn,
      buySignal,
      sellSignal,
    });
  }

  return out;
}

/** Oldest-first, deduped bar open times, Pine-ready OHLC. */
export function sanitizeCandlesForSt(candles: StCandle[], symbol?: string): StCandle[] {
  const sym = symbol != null && String(symbol).trim() ? String(symbol).trim().toUpperCase() : "";
  const rows: StCandle[] = [];
  for (const c of candles || []) {
    const ts = Number(c.ts);
    const open = Number(c.open);
    const high = Number(c.high);
    const low = Number(c.low);
    const close = Number(c.close);
    if (!Number.isFinite(ts) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      continue;
    }
    if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;
    // If upstream OHLC is inconsistent (e.g. low > min(open,close) or high < max(open,close)),
    // dropping the bar is safer than clamping — clamping can shrink TR/ATR and cause whipsaw flips.
    const maxOc = Math.max(open, close);
    const minOc = Math.min(open, close);
    const tolAbs = Math.max(1e-12, maxOc * 1e-9); // tiny tolerance for float noise
    if (!roughlyLTE(maxOc, high, tolAbs)) continue;
    if (!roughlyLTE(low, minOc, tolAbs)) continue;
    if (high < low) continue;
    rows.push({ ts, open, high, low, close });
  }
  rows.sort((a, b) => a.ts - b.ts);
  const dedup: StCandle[] = [];
  for (const bar of rows) {
    if (dedup.length && dedup[dedup.length - 1].ts === bar.ts) dedup[dedup.length - 1] = bar;
    else dedup.push(bar);
  }
  // Drop extreme range outliers relative to recent median (bad ticks / partial aggregation).
  const out: StCandle[] = [];
  const lookback = 50;
  const mult = 18; // conservative; only removes truly absurd spikes
  for (const bar of dedup) {
    const r = Number(bar.high) - Number(bar.low);
    if (!Number.isFinite(r) || r <= 0) continue;
    const recent = out.slice(Math.max(0, out.length - lookback));
    const recentRanges = recent.map((x) => Number(x.high) - Number(x.low)).filter((x) => Number.isFinite(x) && x > 0);
    const med = median(recentRanges);
    if (med != null && med > 0 && r > med * mult) {
      continue;
    }
    if (sym) {
      const prevClose = out.length ? Number(out[out.length - 1].close) : null;
      if (prevClose != null && prevClose > 0) {
        const cl = Number(bar.close);
        const lo = Number(bar.low);
        if (!isPlausibleCandleClose(sym, cl, lo, prevClose)) continue;
      }
    }
    out.push(bar);
  }
  return out;
}

/** Drop ST points far outside the candle range (bad ticks / buffer mix) that blow up the left price scale. */
function clipLineToCandleRange(
  points: Array<{ time: number; value: number }>,
  candles: StCandle[],
): Array<{ time: number; value: number }> {
  if (!points.length || !candles.length) return points;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    const h = Number(c.high);
    const l = Number(c.low);
    if (Number.isFinite(h) && h > 0) hi = Math.max(hi, h);
    if (Number.isFinite(l) && l > 0) lo = Math.min(lo, l);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi < lo) return points;
  const span = hi - lo;
  const pad = Math.max(span * 4, lo * 0.2);
  const minY = Math.max(1e-12, lo - pad);
  const maxY = hi + pad;
  return points.filter((p) => Number.isFinite(p.value) && p.value >= minY && p.value <= maxY);
}

function trimAdjacentSpikesLine(line: Array<{ time: number; value: number }>, maxRatio = 120): Array<{ time: number; value: number }> {
  const out = line.slice();
  let changed = true;
  while (changed && out.length >= 2) {
    changed = false;
    for (let i = 1; i < out.length; i++) {
      const a = out[i - 1].value;
      const b = out[i].value;
      if (a > 0 && b > 0 && (b / a > maxRatio || a / b > maxRatio)) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

const CHART_MARKER_CAP = 24;

/** Binance kline open `t` is bar start; duration → used to know when the last candle is still forming. */
export function binanceIntervalMs(interval: string): number {
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

export type ChartSupertrend = {
  linePoints: Array<{ time: number; value: number }>;
  markers: Array<{ time: number; side: "buy" | "sell"; preview?: boolean }>;
  lastTrend: number | null;
  /** Lower / upper ST rails on the last bar — trailing uses `up` for longs, `dn` for shorts (not regime `line`). */
  lastUp: number | null;
  lastDn: number | null;
};

/** Line + confirmed-bar markers from the same candles the chart will paint. */
export function buildChartSupertrend(
  candles: StCandle[],
  opts: { period: number; multiplier: number; wilderAtr: boolean; timeframe?: string; symbol?: string },
): ChartSupertrend {
  const clean = sanitizeCandlesForSt(candles, opts.symbol);
  const period = Math.max(1, opts.period);
  if (clean.length < Math.max(2, period)) {
    return { linePoints: [], markers: [], lastTrend: null, lastUp: null, lastDn: null };
  }

  const stSer = computeSupertrendSeries(clean, {
    period,
    multiplier: opts.multiplier,
    wilderAtr: opts.wilderAtr,
  });

  const lineRaw: Array<{ time: number; value: number }> = [];
  for (const r of stSer) {
    if (!r.ready || r.line == null) continue;
    const v = Number(r.line);
    if (!Number.isFinite(v) || v <= 0) continue;
    lineRaw.push({ time: Math.floor(Number(r.ts) / 1000), value: v });
  }
  lineRaw.sort((a, b) => a.time - b.time);
  const lineDedup: Array<{ time: number; value: number }> = [];
  for (const p of lineRaw) {
    if (lineDedup.length && lineDedup[lineDedup.length - 1].time === p.time) lineDedup[lineDedup.length - 1] = p;
    else lineDedup.push(p);
  }
  let linePoints = clipLineToCandleRange(lineDedup, clean);
  linePoints = trimAdjacentSpikesLine(linePoints, 120);
  /** Drop trailing ST points that jump vs previous (avoids one bad row dragging the line + price scale to ~0). */
  while (linePoints.length >= 2) {
    const a = linePoints[linePoints.length - 2]!.value;
    const b = linePoints[linePoints.length - 1]!.value;
    if (a > 0 && b > 0 && (b / a > 60 || a / b > 60)) linePoints = linePoints.slice(0, -1);
    else break;
  }

  const markers: Array<{ time: number; side: "buy" | "sell"; preview?: boolean }> = [];
  const barMs = binanceIntervalMs(opts.timeframe ?? "1m");
  const now = Date.now();
  const lastIdx = stSer.length - 1;
  for (let i = 0; i < stSer.length; i++) {
    const r = stSer[i];
    if (!r.ready) continue;
    // Old behaviour skipped only index length-1, assuming it was always the forming bar. Right after k.x
    // the finalized bar is still the last row until the next interval ticks in — server sees a flip there,
    // but the chart hid it. Skip the last row only while wall-clock is still inside this bar's window.
    if (i === lastIdx) {
      const openTs = Number(clean[i]?.ts);
      if (Number.isFinite(openTs) && barMs > 0 && now < openTs + barMs - 250) continue;
    }
    const t = Math.floor(Number(r.ts) / 1000);
    if (r.buySignal) markers.push({ time: t, side: "buy" });
    if (r.sellSignal) markers.push({ time: t, side: "sell" });
  }

  // Optional “preview” marker on the forming bar (visual only; autotrade is still bar-close k.x).
  // This helps match the “TradingView feel” without using unconfirmed signals for trades.
  if (stSer.length > 0) {
    const r = stSer[lastIdx];
    const openTs = Number(clean[lastIdx]?.ts);
    if (r?.ready && Number.isFinite(openTs) && barMs > 0 && now < openTs + barMs - 250) {
      const t = Math.floor(Number(r.ts) / 1000);
      if (r.buySignal) markers.push({ time: t, side: "buy", preview: true });
      if (r.sellSignal) markers.push({ time: t, side: "sell", preview: true });
    }
  }
  const markersCapped =
    markers.length > CHART_MARKER_CAP ? markers.slice(markers.length - CHART_MARKER_CAP) : markers;

  const last = stSer[stSer.length - 1];
  const lastTrend =
    last?.ready && last.trend != null && Number.isFinite(Number(last.trend)) ? Number(last.trend) : null;
  const lastUp =
    last?.ready && last.up != null && Number.isFinite(Number(last.up)) && Number(last.up) > 0 ? Number(last.up) : null;
  const lastDn =
    last?.ready && last.dn != null && Number.isFinite(Number(last.dn)) && Number(last.dn) > 0 ? Number(last.dn) : null;

  return { linePoints, markers: markersCapped, lastTrend, lastUp, lastDn };
}
