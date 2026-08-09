/** Time helpers shared by CSV feature builder (mirrors frontend backtestChartTime). */

const TF_MS = {
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

export function chartTfToMs(tf) {
  const ms = TF_MS[String(tf || "1h").toLowerCase()];
  return ms ?? 60 * 60_000;
}

export function isoToMs(iso) {
  if (iso == null || iso === "") return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function formatTsIST(isoOrMs) {
  const ms = typeof isoOrMs === "number" ? isoOrMs : new Date(isoOrMs).getTime();
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function inferEntrySameBar(trade, engineType) {
  if (trade.entrySameBar === true) return true;
  if (trade.entrySameBar === false) return false;
  const et = String(engineType ?? "").toUpperCase();
  return et === "SUPERTREND_ELITE" || et === "UNIFIED_ELITE";
}

export function resolveTradeEntryFillMs(trade, runTimeframe, engineType) {
  const fill = isoToMs(trade.entryFillTs);
  if (fill != null) return fill;
  const barMs = isoToMs(trade.entryBarTs ?? trade.entryTs);
  if (barMs == null) return NaN;
  const runTfMs = chartTfToMs(runTimeframe);
  if (inferEntrySameBar(trade, engineType)) return barMs + runTfMs - 1;
  return barMs + runTfMs;
}

export function resolveTradeExitFillMs(trade, runTimeframe) {
  const fill = isoToMs(trade.exitFillTs);
  if (fill != null) return fill;
  const barMs = isoToMs(trade.exitTs);
  if (barMs == null) return NaN;
  const tfMs = chartTfToMs(runTimeframe);
  const reason = String(trade.exitReason ?? "").toLowerCase();
  if (reason === "flip" || reason === "signal_exit" || reason === "of_exit") {
    return barMs + tfMs;
  }
  return barMs;
}

/** Index of candle whose period contains `ms`. */
export function barIndexContainingMs(candles, ms, chartTfMs) {
  if (!candles.length || !Number.isFinite(ms)) return 0;
  let lo = 0;
  let hi = candles.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const barTs = Number(candles[mid]?.ts);
    if (!Number.isFinite(barTs)) break;
    if (barTs <= ms) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const bar = candles[best];
  if (bar && ms >= Number(bar.ts) + chartTfMs) {
    return Math.min(best + 1, candles.length - 1);
  }
  return best;
}
