/**
 * ICT-aligned SMC candidate ranking (reclaim strength + structure, not sweep extension).
 */

/**
 * Directional body ratio on reclaim bar (0–1). BUY needs bullish close; SELL bearish.
 * @param {object[]} candles
 * @param {number} reclaimIdx
 * @param {'BUY'|'SELL'} side
 */
export function reclaimBodyStrength(candles, reclaimIdx, side) {
  const bar = candles?.[reclaimIdx];
  if (!bar) return 0;
  const range = Math.max(1e-9, bar.high - bar.low);
  const bodyRatio = Math.abs(bar.close - bar.open) / range;
  if (side === "BUY") return bar.close > bar.open ? bodyRatio : 0;
  return bar.close < bar.open ? bodyRatio : 0;
}

/**
 * Rank a daily_sniper candidate (higher = better).
 * @param {{ score?: number, sig?: object }} c
 * @param {object[]} [candles]
 */
export function rankSmcCandidate(c, candles = null) {
  const sig = c.sig ?? {};
  const meta = sig.smcMeta ?? {};
  const br = sig.liqBrackets ?? {};
  const side = sig.action ?? meta.side ?? "BUY";
  const reclaimIdx = meta.sweepReclaimIdx ?? meta.reclaimIdx ?? br.reclaimIdx ?? null;
  const reclaimStr =
    meta.reclaimBodyRatio != null
      ? Number(meta.reclaimBodyRatio)
      : reclaimIdx != null && candles
        ? reclaimBodyStrength(candles, reclaimIdx, side)
        : 0;
  const ext = Number(meta.sweepExtensionPct ?? 0);
  const rr = Number(br.rr ?? 0);
  const hasChoch = meta.chochIdx != null;
  const hasFvg = meta.fvgTop != null && meta.fvgBottom != null;
  const hasOb = meta.obTop != null && meta.obBottom != null;

  return (
    (c.score ?? 0) * 10
    + reclaimStr * 50
    + (hasChoch ? 40 : 0)
    + (hasFvg ? 30 : 0)
    + (hasOb ? 15 : 0)
    + rr * 8
    - ext * 20
  );
}

/**
 * Per-cycle rank inside evaluateSmcIctSetup (multi-cycle selection at one bar).
 */
export function rankSmcCycle(candles, side, cyc, ctx) {
  const {
    inZone = false,
    chochIdx = null,
    fvg = null,
    ob = null,
    brackets = {},
    reclaimIdx = null,
  } = ctx;
  const reclaimStr =
    reclaimIdx != null ? reclaimBodyStrength(candles, reclaimIdx, side) : 0;
  const ext = Math.max(0, Number(cyc.extension) || 0);
  const rr = Number(brackets.rr ?? 0);
  const sessionBonus = cyc.levelType === "pdh" || cyc.levelType === "pdl" ? 10 : 0;

  return (
    (inZone ? 1000 : 0)
    + reclaimStr * 50
    + (chochIdx != null ? 40 : 0)
    + (fvg ? 30 : 0)
    + (ob ? 15 : 0)
    + rr * 5
    + sessionBonus
    - ext * 20
  );
}
