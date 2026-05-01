/**
 * Build hybrid `getAccount()` result without fabricating zeros when Binance calls fail.
 * Returns `null` only when every configured venue leg failed (no usable wallet snapshot).
 *
 * @param {object} opts
 * @param {object|null} opts.spotAcc
 * @param {object|null} opts.futAcc
 * @param {boolean} opts.needSpot
 * @param {boolean} opts.needFut
 * @param {object|null} opts.primaryFieldsFrom
 * @param {string|null} [opts.futuresError]  - auth-class error string from the futures leg, if any
 */
export function buildHybridAccountSnapshot({ spotAcc, futAcc, needSpot, needFut, primaryFieldsFrom, futuresError = null }) {
  if (!needSpot && !needFut) {
    return {
      equity: 0,
      freeBalance: 0,
      dailyStartEquity: null,
      dailyPnlPct: 0,
      venues: { spot: null, futures: null },
    };
  }

  const spotOk = spotAcc != null;
  const futOk = futAcc != null;

  if ((needSpot && !spotOk && needFut && !futOk) || (needSpot && !spotOk && !needFut) || (!needSpot && needFut && !futOk)) {
    return null;
  }

  const se = spotAcc != null ? Number(spotAcc.equity ?? 0) : null;
  const fe = futAcc != null ? Number(futAcc.equity ?? 0) : null;

  let equity = null;
  if (needSpot && needFut) {
    if (spotOk && futOk) {
      // Both legs working: sum them.
      if (Number.isFinite(se) && Number.isFinite(fe)) equity = se + fe;
    } else if (spotOk) {
      // Futures leg down (auth failure / transient): show spot-only equity so portfolio isn't blank.
      equity = Number.isFinite(se) ? se : null;
    } else if (futOk) {
      // Spot leg down: show futures-only equity.
      equity = Number.isFinite(fe) ? fe : null;
    }
  } else if (needSpot && spotOk) {
    equity = Number.isFinite(se) ? se : null;
  } else if (needFut && futOk) {
    equity = Number.isFinite(fe) ? fe : null;
  }

  const primary = primaryFieldsFrom || (spotOk ? spotAcc : futOk ? futAcc : {}) || {};
  const out = {
    ...primary,
    equity,
    venues: { spot: spotAcc, futures: futAcc },
  };
  if (needSpot && needFut && (!spotOk || !futOk)) {
    out.accountFetchPartial = true;
  }
  // Always emit futuresAuthError (null clears any stale value on the frontend; string surfaces it).
  out.futuresAuthError = futuresError ? String(futuresError) : null;
  return out;
}
