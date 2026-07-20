/**
 * Regime-aware MFE giveback trail — protect choppy follow-through without
 * scratching clean-trend runners (flat BE failed that test).
 *
 * Chop proxy at entry: |prior return over lookbackMs| < absMax.
 * Once MFE ≥ activatePct, ratchet SL to lock (1 − givebackFrac) of peak MFE.
 */

/**
 * @param {Array<{ ts: number, close: number }>} candles
 * @param {number} idx
 * @param {number} lookbackMs
 * @returns {number|null}
 */
export function priorReturnByMs(candles, idx, lookbackMs) {
  if (!candles?.length || idx < 1 || !(lookbackMs > 0)) return null;
  const ts = Number(candles[idx]?.ts);
  const px = Number(candles[idx]?.close);
  if (!Number.isFinite(ts) || !(px > 0)) return null;
  const target = ts - lookbackMs;
  let lo = 0;
  let hi = idx;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(candles[mid].ts);
    if (t <= target) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (best < 0) return null;
  const a = Number(candles[best].close);
  if (!(a > 0)) return null;
  return (px - a) / a;
}

/**
 * @param {number|null|undefined} priorReturn
 * @param {number} absMax
 * @returns {boolean}
 */
export function isChopPriorReturn(priorReturn, absMax = 0.05) {
  if (!Number.isFinite(priorReturn)) return false;
  const cap = Number(absMax);
  if (!(cap > 0)) return false;
  return Math.abs(priorReturn) < cap;
}

/**
 * Ratchet stop from peak MFE with giveback.
 * @returns {number|null} candidate SL price
 */
export function computeMfeGivebackSl({
  isLong,
  entryPx,
  peakMfePct,
  givebackFrac = 0.35,
  activatePct = 0.01,
  feeBePx = null,
  prevSl = null,
}) {
  const mfe = Number(peakMfePct);
  const act = Number(activatePct);
  const E = Number(entryPx);
  if (!(E > 0) || !Number.isFinite(mfe) || mfe < act) return null;

  const gb = Math.min(0.9, Math.max(0, Number(givebackFrac) || 0));
  const lockPct = mfe * (1 - gb);
  if (!(lockPct > 0)) return null;

  let candidate = isLong ? E * (1 + lockPct) : E * (1 - lockPct);
  const feeBe = Number(feeBePx);
  if (Number.isFinite(feeBe) && feeBe > 0) {
    candidate = isLong ? Math.max(candidate, feeBe) : Math.min(candidate, feeBe);
  }
  const prev = Number(prevSl);
  if (Number.isFinite(prev) && prev > 0) {
    candidate = isLong ? Math.max(candidate, prev) : Math.min(candidate, prev);
  }
  return candidate;
}

/**
 * Read cfg knobs (defaults off).
 * @param {Record<string, unknown>} cfg
 */
export function readChopMfeTrailCfg(cfg = {}) {
  const on = cfg.backtestChopMfeTrail === true;
  return {
    enabled: on,
    priorMs: Math.max(86_400_000, Number(cfg.backtestChopPriorMs ?? 60 * 86_400_000)),
    priorAbsMax: Number(cfg.backtestChopPriorAbsMax ?? 0.05),
    activatePct: Number(cfg.backtestChopMfeTrailActivatePct ?? 0.01),
    givebackFrac: Number(cfg.backtestChopMfeTrailGivebackFrac ?? 0.35),
    sides: String(cfg.backtestChopMfeTrailSides ?? "BOTH").toUpperCase(),
  };
}
