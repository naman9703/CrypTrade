/**
 * Flatten nested LIQ feature vectors into dot-notation columns for CSV export / analysis.
 */

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/**
 * @param {object} obj
 * @param {string} [prefix]
 * @param {Record<string, string|number|null>} out
 */
export function flattenObject(obj, prefix = "", out = {}) {
  if (obj == null) return out;
  if (!isPlainObject(obj)) {
    if (prefix) out[prefix] = obj;
    return out;
  }
  for (const [key, val] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(val)) flattenObject(val, path, out);
    else if (Array.isArray(val)) out[path] = val.length ? JSON.stringify(val) : "";
    else out[path] = val;
  }
  return out;
}

/**
 * @param {object|null|undefined} features — liqContext.features bundle
 * @returns {Record<string, string|number|null>}
 */
export function flattenLiqFeatures(features) {
  if (!features || typeof features !== "object") return {};
  const flat = flattenObject(features, "feat");
  // Stable short aliases for common research columns
  const aliases = {
    marketState_regime: features.marketState?.regime,
    marketState_daySituation: features.marketState?.daySituation,
    marketState_confidence: features.marketState?.confidence,
    marketState_adx: features.marketState?.adx,
    marketState_atrPct: features.marketState?.atrPct,
    sessionNarrative: features.sessionNarrative,
    level_type: features.level?.type,
    level_importance: features.level?.importance,
    level_touches: features.level?.touches,
    sweep_velocity: features.sweep?.sweepVelocity,
    sweep_velocityAtr: features.sweep?.sweepVelocityAtr,
    sweep_acceleration: features.sweep?.sweepAcceleration,
    sweep_attemptCount: features.sweep?.attemptCount,
    sweep_volSpike: features.sweep?.sweepVolSpike,
    sweep_absorption: features.sweep?.absorptionProxy,
    sweep_exhaustion: features.sweep?.exhaustionScore,
    sweep_timeInside: features.sweep?.timeInsideLiquidity,
    disp_imbalanceBars: features.displacement?.consecutiveImbalanceBars,
    disp_bodyEfficiency: features.displacement?.bodyEfficiency,
    disp_overlap: features.displacement?.overlapRatio,
    disp_momentum: features.displacement?.momentumPersistence,
    disp_atrExpansion: features.displacement?.atrExpansion,
    disp_impulseAtr: features.displacement?.impulseAtr,
    cont_opposingR: features.continuation?.distanceToOpposingR,
    cont_opposingAtr: features.continuation?.distanceToOpposingAtr,
    cont_dailyRangeUsed: features.continuation?.dailyRangeUsedPct,
    cont_remainingAtr: features.continuation?.remainingDailyAtr,
    cont_expansionState: features.continuation?.expansionState,
    cont_trendMaturity: features.continuation?.trendMaturityBars,
    cont_score: features.continuation?.score,
    cont_passed: features.continuation?.passed,
    scoreV2_total: features.scoreV2?.total,
    scoreV2_sweepQuality: features.scoreV2?.components?.sweepQuality,
    scoreV2_displacement: features.scoreV2?.components?.displacement,
    scoreV2_reclaimHold: features.scoreV2?.components?.reclaimHold,
    scoreV2_htfAlign: features.scoreV2?.components?.htfLiquidityAlign,
    scoreV2_continuationRoom: features.scoreV2?.components?.continuationRoom,
    scoreV2_levelImportance: features.scoreV2?.components?.levelImportance,
    scoreV2_sessionNarrative: features.scoreV2?.components?.sessionNarrative,
    reclaimIdx: features.reclaimIdx,
    sweepStartIdx: features.sweepStartIdx,
    entryBarIdx: features.entryBarIdx,
  };
  for (const [k, v] of Object.entries(aliases)) {
    if (v !== undefined) flat[k] = v;
  }
  return flat;
}

/**
 * Compute R-multiple from trade record (mirrors metrics.rMultipleStats fallback).
 */
export function computeTradeR(trade) {
  if (Number.isFinite(Number(trade?.rMultiple))) return Number(trade.rMultiple);
  const entry = Number(trade?.entryPrice ?? trade?.entryFill);
  const stop = Number(trade?.initialSlPrice ?? trade?.slPrice ?? trade?.stopPrice);
  const risk =
    Number(trade?.initialRiskUsd) ||
    Number(trade?.riskUsd) ||
    (Number.isFinite(entry) && Number.isFinite(stop) && Number(trade?.qty)
      ? Math.abs(entry - stop) * Math.abs(Number(trade.qty))
      : 0);
  if (risk > 0) return Number(trade?.netPnl ?? 0) / risk;
  return null;
}

/**
 * @param {object} trade
 * @param {{ symbol?: string, window?: string, preset?: string }} meta
 */
export function tradeToFeatureRow(trade, meta = {}) {
  const liq = trade.liqContext ?? {};
  const equity = Number(trade.equityAtEntry ?? 1000);
  const netPnl = Number(trade.netPnl ?? 0);
  const r = computeTradeR(trade);
  return {
    tradeId: trade.tradeNumber ?? trade.entryTs,
    symbol: meta.symbol ?? "",
    window: meta.window ?? "",
    preset: meta.preset ?? "",
    entryTs: trade.entryTs,
    entryYear: trade.entryTs ? new Date(Number(trade.entryTs)).getUTCFullYear() : null,
    exitTs: trade.exitTs ?? null,
    side: trade.direction ?? "",
    exitReason: trade.exitReason ?? "",
    netPnl,
    pnlPct: equity > 0 ? (netPnl / equity) * 100 : 0,
    rMultiple: r,
    win: netPnl > 0 ? 1 : 0,
    mfePct: Number(trade.mfePct ?? 0) * 100,
    maePct: Number(trade.maePct ?? 0) * 100,
    barsHeld: trade.barsHeld ?? 0,
    rr: liq.rr ?? null,
    levelType: liq.levelType ?? "",
    entryContextScore: liq.entryContextScore ?? null,
    liqQuality: liq.liqQuality ?? null,
    weightedQuality: liq.weightedQuality ?? null,
    levelImportance: liq.levelImportance ?? null,
    ...flattenLiqFeatures(liq.features),
  };
}

export function rowsToCsv(rows) {
  if (!rows.length) return "";
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  const lines = [keys.join(",")];
  for (const row of rows) {
    lines.push(keys.map((k) => esc(row[k])).join(","));
  }
  return lines.join("\n");
}
