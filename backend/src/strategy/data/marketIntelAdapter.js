/**
 * Optional external market intelligence (OI, liquidations, CVD) — stub for Phase 4.
 */

/**
 * @param {object} [_opts]
 * @returns {Promise<{ ok: boolean, oiDelta?: number, liquidationBias?: string }>}
 */
export async function fetchMarketIntelSnapshot(_opts = {}) {
  return { ok: false, reason: "disabled" };
}

/**
 * @param {object} opts
 * @param {'BUY'|'SELL'} side
 */
export function passesMarketIntelFilter(opts, side) {
  if (opts.intradaySmcUseMarketIntel !== true) return true;
  void side;
  return true;
}
