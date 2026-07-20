/**
 * Live/paper VP novelty monitor helpers — attach to bot state, feed outcomes.
 * Shadow-capable: default unknownPolicy=trade until allowlist is populated.
 */

import {
  createVpNoveltyMonitor,
  recordVpCellOutcome,
  decideVpNovelty,
  serializeVpNoveltyMonitor,
} from "./vpNoveltyMonitor.js";

const DEFAULT_BTC_PREPARED = [
  "BUY|va_rejection|bull_trend|structured",
  "BUY|va_rejection|bull_chop|structured",
  "BUY|va_rejection|weak_bear|structured",
  "BUY|va_rejection|bear_trend|structured",
  "BUY|vah_breakout|bull_trend|structured",
  "BUY|vah_breakout|bull_chop|structured",
  "SELL|val_breakdown|bear_trend|structured",
  "SELL|val_breakdown|weak_bear|structured",
];

const DEFAULT_BTC_BLEED = [
  "BUY|vah_breakout|bull_trend|vacuum",
  "BUY|vah_breakout|bull_chop|vacuum",
  "BUY|vah_breakout|weak_bear|vacuum",
  "BUY|vah_breakout|bear_trend|vacuum",
  "SELL|val_breakdown|bear_trend|vacuum",
];

/**
 * Ensure `state.vpNoveltyMonitor` exists (mutates state).
 * @param {object} state
 * @param {object} [over]
 */
export function ensureVpNoveltyMonitorOnState(state, over = {}) {
  if (state.vpNoveltyMonitor?.cells instanceof Map) return state.vpNoveltyMonitor;
  const allowlist = state.vpPreparedAllowlistOnly === true;
  state.vpNoveltyMonitor = createVpNoveltyMonitor({
    preparedCells: Array.isArray(state.vpPreparedCellKeys) && state.vpPreparedCellKeys.length
      ? state.vpPreparedCellKeys
      : DEFAULT_BTC_PREPARED,
    bleedCells: DEFAULT_BTC_BLEED,
    allowlistOnly: allowlist,
    unknownPolicy: allowlist ? "abstain" : String(state.vpNoveltyUnknownPolicy ?? "trade"),
    unknownSizeMult: Number(state.vpNoveltyUnknownSizeMult ?? 0.5),
    minOutcomes: Number(state.vpNoveltyMinOutcomes ?? 8),
    ...over,
  });
  return state.vpNoveltyMonitor;
}

/**
 * Attach monitor onto cfg used by VP adapter (live bar-close path).
 */
export function attachVpNoveltyMonitorToCfg(cfg) {
  if (!cfg || typeof cfg !== "object") return cfg;
  const mon = ensureVpNoveltyMonitorOnState(cfg);
  return { ...cfg, vpNoveltyMonitor: mon };
}

export function recordLiveVpCellTrade(state, cellKey, rMultiple, ts = Date.now()) {
  const mon = ensureVpNoveltyMonitorOnState(state);
  recordVpCellOutcome(mon, cellKey, rMultiple, ts);
  return decideVpNovelty(mon, cellKey);
}

export function vpNoveltySnapshot(state) {
  if (!state?.vpNoveltyMonitor) return null;
  return serializeVpNoveltyMonitor(state.vpNoveltyMonitor);
}

export { DEFAULT_BTC_PREPARED, DEFAULT_BTC_BLEED, decideVpNovelty };
