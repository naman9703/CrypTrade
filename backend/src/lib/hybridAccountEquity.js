/**
 * Build hybrid `getAccount()` result without fabricating zeros when Binance calls fail.
 * Returns `null` only when every configured venue leg failed (no usuable wallet snapshot).
 */
export function buildHybridAccountSnapshot({ spotAcc, futAcc, needSpot, needFut, primaryFieldsFrom }) {
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

  let equity = null;
  if (needSpot && needFut) {
    if (spotOk && futOk) {
      const se = Number(spotAcc.equity ?? 0);
      const fe = Number(futAcc.equity ?? 0);
      if (Number.isFinite(se) && Number.isFinite(fe)) equity = se + fe;
    }
  } else if (needSpot && spotOk) {
    const se = Number(spotAcc.equity ?? 0);
    equity = Number.isFinite(se) ? se : null;
  } else if (needFut && futOk) {
    const fe = Number(futAcc.equity ?? 0);
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
  return out;
}
