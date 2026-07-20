/**
 * Funding-rate cash-and-carry types and helpers.
 * Positive funding → LONG_SPOT_SHORT_PERP (shorts receive).
 * Negative funding → SHORT_SPOT_LONG_PERP (longs receive).
 */

export const CARRY_SIDE = Object.freeze({
  LONG_SPOT_SHORT_PERP: "LONG_SPOT_SHORT_PERP",
  SHORT_SPOT_LONG_PERP: "SHORT_SPOT_LONG_PERP",
});

/** Default liquid majors for Phase 1–2 research. */
export const DEFAULT_FUNDING_ARB_SYMBOLS = Object.freeze([
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
]);

/** Binance USD-M funding interval (hours). */
export const DEFAULT_FUNDING_INTERVAL_HOURS = 8;

/**
 * Annualize a per-interval funding rate as percent (e.g. 0.0001 → ~10.95).
 * @param {number} rate — fraction per interval (e.g. 0.0001 = 0.01%)
 * @param {number} [intervalHours=8]
 * @returns {number} annualized percent
 */
export function annualizeFundingRate(rate, intervalHours = DEFAULT_FUNDING_INTERVAL_HOURS) {
  const r = Number(rate);
  const h = Number(intervalHours);
  if (!Number.isFinite(r) || !Number.isFinite(h) || !(h > 0)) return 0;
  const intervalsPerYear = (365 * 24) / h;
  return r * intervalsPerYear * 100;
}

/**
 * Infer carry side from rate sign (positive → short perp collects).
 * @param {number} rate
 * @returns {string|null} CARRY_SIDE value or null if rate ≈ 0
 */
export function carrySideFromRate(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || Math.abs(r) < 1e-12) return null;
  return r > 0 ? CARRY_SIDE.LONG_SPOT_SHORT_PERP : CARRY_SIDE.SHORT_SPOT_LONG_PERP;
}

/**
 * Basis = (perp − spot) / spot.
 * @param {number} spotPx
 * @param {number} perpPx
 * @returns {number|null}
 */
export function computeBasis(spotPx, perpPx) {
  const s = Number(spotPx);
  const p = Number(perpPx);
  if (!(s > 0) || !Number.isFinite(p)) return null;
  return (p - s) / s;
}

/**
 * Perp leg side for a carry position ("BUY" = long perp, "SELL" = short perp).
 * @param {string} carrySide
 * @returns {'BUY'|'SELL'|null}
 */
export function perpSideForCarry(carrySide) {
  if (carrySide === CARRY_SIDE.LONG_SPOT_SHORT_PERP) return "SELL";
  if (carrySide === CARRY_SIDE.SHORT_SPOT_LONG_PERP) return "BUY";
  return null;
}

/**
 * Spot leg side for a carry position.
 * @param {string} carrySide
 * @returns {'BUY'|'SELL'|null}
 */
export function spotSideForCarry(carrySide) {
  if (carrySide === CARRY_SIDE.LONG_SPOT_SHORT_PERP) return "BUY";
  if (carrySide === CARRY_SIDE.SHORT_SPOT_LONG_PERP) return "SELL";
  return null;
}

/**
 * Funding cashflow for the perp leg between timestamps.
 * Positive return = income to the carry (we receive funding).
 * Reuses the same event timestamps as costModel.fundingPaidBetween, but
 * signs so that SHORT perp + positive rate = income.
 *
 * @param {'BUY'|'SELL'} perpSide
 * @param {number} qty
 * @param {number} notionalPx — price used for notional (entry fill)
 * @param {Array<{ts:number,rate:number}>} fundingRates
 * @param {number} fromTs exclusive lower bound (entry)
 * @param {number} toTs inclusive upper bound (exit / now)
 * @returns {number} funding income (positive = received)
 */
export function fundingIncomeBetween(perpSide, qty, notionalPx, fundingRates, fromTs, toTs) {
  if (!Array.isArray(fundingRates) || !fundingRates.length) return 0;
  const notional = Math.abs(Number(qty)) * Number(notionalPx);
  if (!(notional > 0)) return 0;
  // Long pays when rate > 0; short receives when rate > 0 → income = -sign * rate * notional
  // for the exchange "paid" convention where long pays +rate*notional.
  const exchangePaidSign = perpSide === "BUY" ? 1 : -1;
  let income = 0;
  for (const fr of fundingRates) {
    if (fr.ts <= fromTs) continue;
    if (fr.ts > toTs) break;
    // Exchange paid (positive = we paid). Income = -paid.
    income -= exchangePaidSign * Number(fr.rate) * notional;
  }
  return income;
}

export function resolveFundingArbCfg(cfg = {}) {
  const c = cfg && typeof cfg === "object" ? cfg : {};
  const feeMode = String(c.feeMode ?? "maker").toLowerCase() === "taker" ? "taker" : "maker";
  // Binance-typical (VIP0 approx): spot maker/taker ~0.10%; futures maker ~0.02%, taker ~0.05%.
  const spotMaker = Number(c.spotMakerFeeRate ?? 0.001);
  const spotTaker = Number(c.spotTakerFeeRate ?? 0.001);
  const perpMaker = Number(c.perpMakerFeeRate ?? 0.0002);
  const perpTaker = Number(c.perpTakerFeeRate ?? 0.0005);
  const useMaker = feeMode === "maker";
  return {
    symbols: Array.isArray(c.symbols) && c.symbols.length
      ? c.symbols.map((s) => String(s).toUpperCase())
      : [...DEFAULT_FUNDING_ARB_SYMBOLS],
    intervalHours: Number(c.intervalHours ?? DEFAULT_FUNDING_INTERVAL_HOURS) || 8,
    /** Phase-2b default 25% — 8% was too low vs dual-leg round-trip costs. */
    minAnnualizedYieldPct: Number(c.minAnnualizedYieldPct ?? 25),
    exitAnnualizedYieldPct: Number(c.exitAnnualizedYieldPct ?? 5),
    exitOnFlip: c.exitOnFlip !== false,
    /** Consecutive settlements same-side AND above min ann before enter (6 ≈ 2 days). */
    stabilityIntervals: Math.max(1, Math.floor(Number(c.stabilityIntervals ?? 6))),
    avgLookback: Math.max(1, Math.floor(Number(c.avgLookback ?? 6))),
    /** Soft exits (yield decay) blocked until this many settlements held (9 ≈ 3 days). Flips still exit. */
    minHoldIntervals: Math.max(0, Math.floor(Number(c.minHoldIntervals ?? 9))),
    feeMode,
    spotMakerFeeRate: spotMaker,
    spotTakerFeeRate: spotTaker,
    perpMakerFeeRate: perpMaker,
    perpTakerFeeRate: perpTaker,
    spotFeeRate: Number(c.spotFeeRate ?? (useMaker ? spotMaker : spotTaker)),
    perpFeeRate: Number(c.perpFeeRate ?? (useMaker ? perpMaker : perpTaker)),
    /** Maker path assumes limit fills → lower slip; taker uses wider band. */
    slippagePct: Number(
      c.slippagePct ?? (useMaker ? 0.0001 : 0.0005),
    ),
    perpLeverage: Math.max(1, Math.min(25, Number(c.perpLeverage ?? 5))),
    notionalUsdt: Number(c.notionalUsdt ?? 10_000),
    maxHoldIntervals: Math.max(0, Math.floor(Number(c.maxHoldIntervals ?? 0))),
    feeStressMult: Number(c.feeStressMult ?? 1),
  };
}
