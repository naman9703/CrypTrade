let lastConfirmedRegime = "SIDEWAYS";

export function resetRegimeState() {
  lastConfirmedRegime = "SIDEWAYS";
}

export function detectRegime({ candles, indicators }) {
  const last = candles[candles.length - 1];
  const atr = indicators.latest.atr_14 || 0;
  const adx = indicators.latest.adx_14 || 0;

  const closePx = Number(last?.close);
  const atrPctRaw = Number.isFinite(closePx) && closePx > 0 && Number.isFinite(atr) ? atr / closePx : 0;
  const atrPct = Math.min(Math.max(atrPctRaw, 0), 0.25);

  // Hysteresis: different thresholds for entering vs exiting a regime
  const VOLATILE_ENTRY = 0.012;
  const VOLATILE_EXIT  = 0.008;
  const TRENDING_ENTRY  = 28;
  const TRENDING_EXIT   = 22;

  const wasVolatile  = lastConfirmedRegime === "VOLATILE";
  const wasTrending  = lastConfirmedRegime === "TRENDING";

  let type;
  if (wasVolatile && atrPct >= VOLATILE_EXIT) {
    type = "VOLATILE";
  } else if (!wasVolatile && atrPct > VOLATILE_ENTRY) {
    type = "VOLATILE";
  } else if (wasTrending && adx >= TRENDING_EXIT) {
    type = "TRENDING";
  } else if (!wasTrending && adx > TRENDING_ENTRY) {
    type = "TRENDING";
  } else {
    type = "SIDEWAYS";
  }

  lastConfirmedRegime = type;
  return { type, atrPct, adx };
}
