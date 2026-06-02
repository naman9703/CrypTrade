import { clamp } from "../lib/math.js";

const MIN_REL_DIST = 1e-6;

/**
 * Stop price used for RISK_AT_SL position sizing only.
 * When exit SL is off or zero distance, uses `backtestSizingStopPct` (default 1%)
 * so bracket-off runs size like normal risk-based trades instead of 1% notional fallback.
 *
 * @param {object} p
 * @param {number} p.entryFill
 * @param {number} [p.exitSl] — actual exit stop (0 / null when bracket off)
 * @param {"BUY"|"SELL"|string} p.side
 * @param {Record<string, unknown>} [p.cfg]
 */
export function resolveSizingStopPrice({ entryFill, exitSl, side, cfg = {} }) {
  const entry = Number(entryFill);
  if (!Number.isFinite(entry) || entry <= 0) return entry;
  const sl = Number(exitSl);
  if (Number.isFinite(sl) && sl > 0 && Math.abs(entry - sl) / entry > MIN_REL_DIST) {
    return sl;
  }
  const pct = clamp(
    Number(cfg.backtestSizingStopPct ?? cfg.intradaySmcSizingStopPct ?? 0.01),
    0.001,
    0.2,
  );
  const isLong = String(side || "BUY").toUpperCase() === "BUY";
  return isLong ? entry * (1 - pct) : entry * (1 + pct);
}
