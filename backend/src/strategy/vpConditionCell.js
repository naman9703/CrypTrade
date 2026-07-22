/**
 * VP condition-cell taxonomy — measurable at bar time (never calendar years).
 *
 * Cell key: `${side}|${setup}|${macro}|${path}`
 * Used by prepared-regime matrix, novelty monitor, and live signal tagging.
 */

export function priorPctFromCandles(candles, idx, bars) {
  if (idx < bars) return null;
  const a = candles[idx - bars]?.close;
  const b = candles[idx]?.close;
  if (!(a > 0) || !(b > 0)) return null;
  return (b - a) / a;
}

/**
 * Read a precomputed macro prior. Missing lookback must be `null` — never coerce
 * via `Number(null)` / `?? 0` (those fake a flat 0% drift and break bear/flat gates).
 * @param {unknown[]|undefined|null} arr
 * @param {number} idx
 * @returns {number|null}
 */
export function macroPctAt(arr, idx) {
  const v = arr?.[idx];
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function classifyVpPath(pathPct, vacuumPct = 0.02) {
  const p = Number(pathPct);
  if (!(p > 0)) return "nopath";
  if (p >= vacuumPct) return "vacuum";
  if (p >= vacuumPct * 0.5) return "structured";
  return "tight";
}

/**
 * @param {number|null} prior60
 * @param {boolean} macroBull
 * @param {number} [bearFloor]
 */
export function classifyVpMacro(prior60, macroBull, bearFloor = -0.05) {
  if (macroBull) return prior60 != null && prior60 > 0.05 ? "bull_trend" : "bull_chop";
  if (prior60 != null && prior60 <= bearFloor) return "bear_trend";
  return "weak_bear";
}

export function buildVpConditionCellKey(side, setup, macro, path) {
  return `${String(side).toUpperCase()}|${String(setup)}|${String(macro)}|${String(path)}`;
}

/**
 * Derive macroBull the same way as prepared-regime / sell-macro-adapt filters.
 * @param {object} pre
 * @param {number} idx
 * @param {Record<string, unknown>} [opts]
 */
export function vpMacroBullAt(pre, idx, opts = {}) {
  const priorThresh = Number(opts.vpSellMacroPrior20dBullPct ?? 0.02);
  const above = pre?.macroAboveEma20d?.[idx] === true;
  const slope = Number(pre?.macroEma5dSlope?.[idx] ?? 0);
  const prior20 = macroPctAt(pre?.macroPrior20d, idx);
  return above || slope > 0 || (prior20 != null && prior20 > priorThresh);
}

/**
 * Full cell description at a bar (for signal meta + research).
 */
export function describeVpConditionCell(pre, idx, side, setup, path, opts = {}) {
  const vacuumPct = Number(opts.vpPreparedVacuumPathPct ?? opts.vpVacuumPathPct ?? 0.02);
  const bearFloor = Number(opts.vpPreparedBearPrior60dPct ?? opts.vpValSellPrior60dBearPct ?? -0.05);
  const prior60n = macroPctAt(pre?.macroPrior60d, idx);
  const macroBull = vpMacroBullAt(pre, idx, opts);
  const macro = classifyVpMacro(prior60n, macroBull, bearFloor);
  const pathL = classifyVpPath(path?.distPct ?? null, vacuumPct);
  const key = buildVpConditionCellKey(side, setup, macro, pathL);
  return {
    key,
    side: String(side).toUpperCase(),
    setup: String(setup),
    macro,
    path: pathL,
    pathPct: Number(path?.distPct ?? NaN),
    prior60: prior60n,
    macroBull,
  };
}
