/** Count ALL fractional digits (including trailing zeros) — integer-scaling math. */
function filterFractionalDigits(filterStr) {
  const t = String(filterStr ?? "").trim();
  const dot = t.indexOf(".");
  return dot < 0 ? 0 : t.length - dot - 1;
}

/** Significant fractional digits (strip trailing zeros) — for `.toFixed()`. */
function effectivePrecision(filterStr) {
  const t = String(filterStr ?? "").trim().replace(/0+$/, "").replace(/\.$/, "");
  const dot = t.indexOf(".");
  return dot < 0 ? 0 : t.length - dot - 1;
}

/**
 * @param {number} px
 * @param {{ tickSize?: string, pricePrecision?: number | null }} meta
 * @param {"floor" | "ceil" | "round"} mode
 */
export function formatPriceToTick(px, meta, mode = "round") {
  const tickStr = meta?.tickSize;
  const p = Number(px);
  const tickNum = Number(tickStr);
  if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(tickNum) || tickNum <= 0) return null;
  const dec = filterFractionalDigits(tickStr);
  const scaleExp = Math.min(dec, 15);
  const scale = 10 ** scaleExp;
  const tickUnits = Math.round(tickNum * scale);
  if (tickUnits <= 0) return null;
  const pScaled = p * scale;
  let n;
  if (mode === "floor") n = Math.floor(pScaled / tickUnits + 1e-9);
  else if (mode === "ceil") n = Math.ceil(pScaled / tickUnits - 1e-9);
  else n = Math.round(pScaled / tickUnits);
  const pUnits = n * tickUnits;
  if (pUnits <= 0) return null;
  const aligned = pUnits / scale;
  const tickEffective = effectivePrecision(tickStr);
  const prec = Math.min(
    tickEffective,
    meta.pricePrecision != null ? meta.pricePrecision : tickEffective,
  );
  const s = aligned.toFixed(prec);
  return Number(s) > 0 ? s : null;
}

/**
 * Nudge raw SL/TP so triggers sit on the correct side of `markPrice` for USD-M
 * `workingType: MARK_PRICE` (avoids -2021 / immediate trigger / silent bracket failure).
 * @returns {{ stopPx: number, tpPx: number, adjusted: boolean }}
 */
export function refineUsdMTriggersVsMark({ isLong, stopPx, tpPx, markPrice, meta }) {
  const tick = Number(meta?.tickSize);
  const mark = Number(markPrice);
  let s = Number(stopPx);
  let t = Number(tpPx);
  if (!Number.isFinite(tick) || tick <= 0 || !Number.isFinite(mark) || mark <= 0) {
    return { stopPx: s, tpPx: t, adjusted: false };
  }
  if (!Number.isFinite(s) || !Number.isFinite(t) || s <= 0 || t <= 0) {
    return { stopPx: s, tpPx: t, adjusted: false };
  }

  const origS = s;
  const origT = t;
  const eps = tick * 1e-9;
  const maxSteps = 50_000;
  let steps = 0;

  if (isLong) {
    while (s >= mark - eps && steps < maxSteps) {
      s -= tick;
      steps += 1;
    }
    while (t <= mark + eps && steps < maxSteps) {
      t += tick;
      steps += 1;
    }
    if (s <= 0 || t <= 0 || !(s < t)) {
      return { stopPx: origS, tpPx: origT, adjusted: false };
    }
  } else {
    while (s <= mark + eps && steps < maxSteps) {
      s += tick;
      steps += 1;
    }
    while (t >= mark - eps && steps < maxSteps) {
      t -= tick;
      steps += 1;
    }
    if (s <= 0 || t <= 0 || !(s > t)) {
      return { stopPx: origS, tpPx: origT, adjusted: false };
    }
  }

  const adjusted = s !== origS || t !== origT;
  return { stopPx: s, tpPx: t, adjusted };
}

/**
 * String prices for STOP_MARKET / TAKE_PROFIT_MARKET (+ limit fallbacks).
 * Long: floor SL, ceil TP (stay safely below/above mark after rounding).
 */
export function usdmBracketPriceStrings({ isLong, stopPx, tpPx, meta, closeSide }) {
  const slTickMode = isLong ? "floor" : "ceil";
  const tpTickMode = isLong ? "ceil" : "floor";
  const stopStr = formatPriceToTick(stopPx, meta, slTickMode);
  const tpStr = formatPriceToTick(tpPx, meta, tpTickMode);
  if (!stopStr || !tpStr) return { stopStr: null, tpStr: null, slLimitStr: null, tpLimitStr: null };

  const slippageMult = closeSide === "SELL" ? 0.995 : 1.005;
  const rawSlLim = Number(stopPx) * slippageMult;
  const rawTpLim = Number(tpPx) * slippageMult;
  const slLimMode = closeSide === "SELL" ? "floor" : "ceil";
  const tpLimMode = closeSide === "SELL" ? "ceil" : "floor";
  const slLimitStr = formatPriceToTick(rawSlLim, meta, slLimMode) || stopStr;
  const tpLimitStr = formatPriceToTick(rawTpLim, meta, tpLimMode) || tpStr;
  return { stopStr, tpStr, slLimitStr, tpLimitStr };
}
