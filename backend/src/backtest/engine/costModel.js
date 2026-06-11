/**
 * Cost model used by the simulator. Mirrors live bot fee defaults from
 * backend/src/state/bot.js (`tradeHistory*FeeRate`) with sensible fallbacks
 * (0.02% maker, 0.05% taker), and applies a default 0.05% slippage on each fill.
 *
 * The model is intentionally pure: input bar data + a config snapshot,
 * output the per-trade gross/fee/slippage breakdown so the run shows three
 * columns (gross, funding, net) instead of one fudged "net PnL".
 */

const DEFAULT_MAKER = 0.0002;
const DEFAULT_TAKER = 0.0005;
const DEFAULT_SLIPPAGE_PCT = 0.0005;

/** @typedef {{
 *   makerOpenFeeRate: number,
 *   makerCloseFeeRate: number,
 *   takerOpenFeeRate: number,
 *   takerCloseFeeRate: number,
 *   slippagePct: number,
 *   isFutures: boolean,
 *   leverage: number,
 *   useMakerEntries: boolean,
 *   useMakerExits: boolean,
 * }} ResolvedCostModel */

/**
 * @param {Record<string, unknown>} cfg
 * @param {Record<string, unknown>} [override]
 * @returns {ResolvedCostModel}
 */
export function resolveCostModel(cfg, override = {}) {
  const o = override && typeof override === "object" ? override : {};
  const c = cfg && typeof cfg === "object" ? cfg : {};
  // Honor generic `openFeeRate`/`closeFeeRate` overrides (used by many CLI scripts)
  // as taker-rate aliases so cost modeling is not silently dropped.
  return {
    makerOpenFeeRate: pickRate(o.makerOpenFeeRate, c.tradeHistoryMakerOpenFeeRate, DEFAULT_MAKER),
    makerCloseFeeRate: pickRate(o.makerCloseFeeRate, c.tradeHistoryMakerCloseFeeRate, DEFAULT_MAKER),
    takerOpenFeeRate: pickRate(o.takerOpenFeeRate, o.openFeeRate, c.tradeHistoryTakerOpenFeeRate, DEFAULT_TAKER),
    takerCloseFeeRate: pickRate(o.takerCloseFeeRate, o.closeFeeRate, c.tradeHistoryTakerCloseFeeRate, DEFAULT_TAKER),
    slippagePct: pickRate(o.slippagePct, c.slippagePct, DEFAULT_SLIPPAGE_PCT),
    isFutures: Boolean(o.isFutures ?? (c.marketMode === "FUTURES" || c.market === "FUTURES")),
    /** Mirrors live: `futuresLeverage` (manual) or `leverage` (instance / UI). */
    leverage: pickLeverage(o, c),
    useMakerEntries: Boolean(o.useMakerEntries ?? false),
    useMakerExits: Boolean(o.useMakerExits ?? c.useTrailingMakerCloses ?? false),
  };
}

/** @param {Record<string, unknown>} o  cost_model override */
function pickLeverage(o, c) {
  for (const v of [o.leverage, o.futuresLeverage, c.futuresLeverage, c.leverage]) {
    if (v != null && Number.isFinite(Number(v)) && Number(v) > 0) {
      return Math.max(1, Math.min(125, Math.floor(Number(v))));
    }
  }
  return 1;
}

function pickRate(...vals) {
  for (const v of vals) {
    if (v != null && Number.isFinite(Number(v))) return Math.max(0, Number(v));
  }
  return 0;
}

/**
 * Apply slippage to a fill price.
 * @param {'BUY'|'SELL'} side @param {number} px @param {number} slippagePct (0.0005 = 5 bps)
 */
export function applySlippage(side, px, slippagePct) {
  const s = Math.max(0, Number(slippagePct || 0));
  return side === "BUY" ? Number(px) * (1 + s) : Number(px) * (1 - s);
}

/**
 * Linear funding accrual: rate × notional × hours/8. Funding rates are paid in 8h
 * slots so we charge each slot once when the bar containing the slot timestamp closes.
 * @param {{ side: 'BUY'|'SELL', qty: number, entryFill: number }} pos
 * @param {Array<{ts:number,rate:number}>} fundingRates
 * @param {number} fromTs @param {number} toTs
 */
export function fundingPaidBetween(pos, fundingRates, fromTs, toTs) {
  if (!Array.isArray(fundingRates) || !fundingRates.length) return 0;
  let paid = 0;
  for (const fr of fundingRates) {
    if (fr.ts < fromTs) continue;
    if (fr.ts > toTs) break;
    const notional = Math.abs(pos.qty) * Number(pos.entryFill);
    const sign = pos.side === "BUY" ? 1 : -1;
    paid += sign * Number(fr.rate) * notional;
  }
  return paid;
}

/**
 * @param {{ side: 'BUY'|'SELL', entryFill:number, exitFill:number, qty:number, leverage:number, model: ResolvedCostModel }} args
 */
export function tradeBreakdown({ side, entryFill, exitFill, qty, leverage, model }) {
  const isLong = side === "BUY";
  const grossPerUnit = isLong ? exitFill - entryFill : entryFill - exitFill;
  const gross = grossPerUnit * Math.abs(qty);
  const openRate = model.useMakerEntries ? model.makerOpenFeeRate : model.takerOpenFeeRate;
  const closeRate = model.useMakerExits ? model.makerCloseFeeRate : model.takerCloseFeeRate;
  const entryFee = Math.abs(qty) * Math.abs(entryFill) * openRate;
  const exitFee = Math.abs(qty) * Math.abs(exitFill) * closeRate;
  return {
    gross,
    fees: entryFee + exitFee,
    entryFee,
    exitFee,
    leverage: Math.max(1, Number(leverage || 1)),
  };
}

/** Conservative liquidation price approximation for an isolated futures position. */
export function liquidationPrice({ side, entryFill, leverage, maintenanceMarginRate = 0.005 }) {
  const lev = Math.max(1, Number(leverage || 1));
  const mmr = Math.max(0, Number(maintenanceMarginRate));
  if (side === "BUY") return entryFill * (1 - 1 / lev + mmr);
  return entryFill * (1 + 1 / lev - mmr);
}
