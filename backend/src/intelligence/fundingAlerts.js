/**
 * Dedicated funding extreme alerts: transition detection + hysteresis + cooldown.
 * Thresholds align with compositeScorer funding z-score bands.
 */

const ENTER_LONG_EXTREME_Z = 2;
const ENTER_SHORT_EXTREME_Z = -1.5;
const EXIT_LONG_EXTREME_Z = 1.8;
const EXIT_SHORT_EXTREME_Z = -1.3;

const COOLDOWN_MS = Math.max(
  60_000,
  Math.min(120 * 60_000, Number(process.env.INTELLIGENCE_FUNDING_ALERT_COOLDOWN_MS || 15 * 60_000)),
);

/** @typedef {'none'|'long_extreme'|'short_extreme'} FundingStableBand */

/**
 * @param {FundingStableBand} prev
 * @param {number} z
 * @returns {FundingStableBand}
 */
function nextStableBand(prev, z) {
  if (prev === 'long_extreme') {
    if (z <= EXIT_LONG_EXTREME_Z) {
      if (z > ENTER_LONG_EXTREME_Z) return 'long_extreme';
      if (z < ENTER_SHORT_EXTREME_Z) return 'short_extreme';
      return 'none';
    }
    if (z < ENTER_SHORT_EXTREME_Z) return 'short_extreme';
    return 'long_extreme';
  }
  if (prev === 'short_extreme') {
    if (z >= EXIT_SHORT_EXTREME_Z) {
      if (z > ENTER_LONG_EXTREME_Z) return 'long_extreme';
      if (z < ENTER_SHORT_EXTREME_Z) return 'short_extreme';
      return 'none';
    }
    if (z > ENTER_LONG_EXTREME_Z) return 'long_extreme';
    return 'short_extreme';
  }
  if (z > ENTER_LONG_EXTREME_Z) return 'long_extreme';
  if (z < ENTER_SHORT_EXTREME_Z) return 'short_extreme';
  return 'none';
}

/**
 * @param {Record<string, unknown>} cache - intelligenceCache-like object with _fundingAlertState
 * @param {string} symbol
 * @param {number | null | undefined} zscore
 * @param {{ broadcast?: (type: string, payload: unknown) => void } | null | undefined} wsHub
 */
export function maybeEmitFundingExtremeAlerts(cache, symbol, zscore, wsHub) {
  const sym = String(symbol || '').trim().toUpperCase();
  if (!sym || wsHub == null || typeof wsHub.broadcast !== 'function') return;

  const z = zscore != null && Number.isFinite(Number(zscore)) ? Number(zscore) : null;
  if (z == null) return;

  if (!cache._fundingAlertState || typeof cache._fundingAlertState !== 'object')
    cache._fundingAlertState = Object.create(null);
  const stateMap = cache._fundingAlertState;
  if (!stateMap[sym]) {
    stateMap[sym] = { stableBand: /** @type {FundingStableBand} */ ('none'), lastAlertAt: {} };
  }
  const st = stateMap[sym];
  const prev = /** @type {FundingStableBand} */ (st.stableBand || 'none');
  const next = nextStableBand(prev, z);

  const firedBand =
    prev !== 'long_extreme' && next === 'long_extreme'
      ? 'long_extreme'
      : prev !== 'short_extreme' && next === 'short_extreme'
        ? 'short_extreme'
        : null;

  st.stableBand = next;

  if (!firedBand) return;

  const now = Date.now();
  const lastTs = st.lastAlertAt[firedBand] ?? 0;
  if (now - lastTs < COOLDOWN_MS) return;

  st.lastAlertAt[firedBand] = now;

  const msg =
    firedBand === 'long_extreme'
      ? `[Intelligence] Funding extreme LONG skew: z-score ${z.toFixed(2)} (> ${ENTER_LONG_EXTREME_Z}). Crowded longs — elevated squeeze risk.`
      : `[Intelligence] Funding extreme SHORT skew: z-score ${z.toFixed(2)} (< ${ENTER_SHORT_EXTREME_Z}). Crowded shorts — watch for sharp rallies.`;

  try {
    wsHub.broadcast('funding_alert', {
      symbol: sym,
      band: firedBand,
      zscore: z,
      message: msg,
      ts: new Date().toISOString(),
    });
  } catch {
    /* ignore */
  }
}
