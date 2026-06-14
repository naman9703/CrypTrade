/**
 * Live-parity backtest sizing: `allowedBudgetUsdt`, multi-coin equal split, and
 * per-trade caps — mirrors `bot.js` capital allotment + `riskPlan` notional clamp.
 */

const SPLIT_MODES_MULTI = new Set(["EQUAL", "CUSTOM_USDT", "CUSTOM_PCT_ALLOWED"]);

/**
 * @param {Record<string, unknown>} cfg
 * @returns {string}
 */
export function resolveBacktestSplitMode(cfg = {}) {
  const m = String(cfg?.multiBudgetSplitMode ?? "").toUpperCase();
  if (m === "FULL" || SPLIT_MODES_MULTI.has(m)) return m;
  return cfg?.capitalSplitAcrossCoins === true ? "EQUAL" : "FULL";
}

/**
 * Coins in the equal-split divisor (ranked/custom/pins), same intent as live.
 * @param {Record<string, unknown>} cfg
 * @param {string} [symbol]
 * @returns {string[]}
 */
export function backtestAllotmentCoinList(cfg = {}, symbol = "") {
  const pins = Array.isArray(cfg?.universePinnedSymbols)
    ? [...new Set(cfg.universePinnedSymbols.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))]
    : [];
  const custom = Array.isArray(cfg?.universeCustomSymbols)
    ? [...new Set(cfg.universeCustomSymbols.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))]
    : [];
  if (pins.length > 0) return pins.slice(0, 10);
  if (custom.length > 0) return custom.slice(0, 10);
  const sym = String(symbol || cfg?.symbol || "").trim().toUpperCase();
  return sym ? [sym] : [];
}

/**
 * Live multi-coin equal/custom split. Off by default in backtests: single-coin runs
 * use the full starting capital; portfolio runs split at the worker/replay layer.
 * Opt in with `backtestApplyLiveMultiCoinSplit: true` for live-bot allotment research.
 *
 * @param {Record<string, unknown>} cfg
 * @returns {boolean}
 */
export function backtestMultiCoinSizingActive(cfg = {}) {
  if (cfg?.backtestApplyLiveMultiCoinSplit !== true) return false;
  const isMultiple = String(cfg?.universeCoinSelectMode ?? "").toUpperCase() === "MULTIPLE";
  const splitMode = resolveBacktestSplitMode(cfg);
  return (
    isMultiple &&
    (cfg?.multiCoinCapitalSizingActive === true || SPLIT_MODES_MULTI.has(splitMode))
  );
}

/**
 * Allowed strategy pool capped by simulated wallet equity (live: min(allowed, wallet)).
 * @param {Record<string, unknown>} cfg
 * @param {number} equity
 */
export function resolveBacktestAllowedPoolUsdt(cfg = {}, equity) {
  const eq = Math.max(0, Number(equity) || 0);
  const allowedRaw = Number(cfg?.allowedBudgetUsdt);
  const allowed = Number.isFinite(allowedRaw) && allowedRaw > 0 ? allowedRaw : 0;
  if (allowed > 0) return Math.min(allowed, eq);
  return eq;
}

/**
 * PCT risk base — pool or per-coin slot when equal split (live `pctPolicyCapForRiskPlan`).
 * @param {Record<string, unknown>} cfg
 * @param {number} equity
 * @param {string} [symbol]
 */
export function resolveBacktestPolicyCapUsdt(cfg = {}, equity, symbol = "") {
  const pool = resolveBacktestAllowedPoolUsdt(cfg, equity);
  if (!(pool > 0)) return 0;
  const riskUnit = String(cfg?.riskPerTradeUnit ?? "PCT").toUpperCase();
  if (riskUnit === "USDT") return pool;

  const multiActive = backtestMultiCoinSizingActive(cfg);
  const splitMode = resolveBacktestSplitMode(cfg);
  if (multiActive && splitMode === "EQUAL") {
    const list = backtestAllotmentCoinList(cfg, symbol);
    const nDiv = Math.max(1, list.length);
    if (nDiv > 1) return pool / nDiv;
  }
  return pool;
}

/**
 * Per-trade **margin cap** (USDT collateral), live `resolveCapitalAllotmentMarginLaneForOrder`.
 * @param {object} p
 * @param {Record<string, unknown>} p.cfg
 * @param {number} p.equity
 * @param {string} [p.symbol]
 * @param {number} [p.openMarginUsdt] margin already used on this symbol
 */
export function resolveBacktestMarginCapUsdt({ cfg = {}, equity, symbol = "", openMarginUsdt = 0 }) {
  const pool = resolveBacktestAllowedPoolUsdt(cfg, equity);
  const invested = Math.max(0, Number(openMarginUsdt) || 0);
  const headroom = Math.max(0, pool - invested);
  const multiActive = backtestMultiCoinSizingActive(cfg);
  const splitMode = resolveBacktestSplitMode(cfg);

  let lane = headroom;
  if (multiActive) {
    if (splitMode === "EQUAL") {
      const list = backtestAllotmentCoinList(cfg, symbol);
      const nDiv = Math.max(1, list.length);
      const slot = pool / nDiv;
      lane = Math.max(0, Math.min(slot, headroom));
    } else if (splitMode === "CUSTOM_USDT" && cfg?.multiBudgetCoinUsdt && typeof cfg.multiBudgetCoinUsdt === "object") {
      const sym = String(symbol || cfg?.symbol || "").toUpperCase();
      const custom = Number(cfg.multiBudgetCoinUsdt[sym]);
      if (Number.isFinite(custom) && custom > 0) lane = Math.max(0, Math.min(custom, headroom));
    } else if (splitMode === "CUSTOM_PCT_ALLOWED" && cfg?.multiBudgetCoinPct && typeof cfg.multiBudgetCoinPct === "object") {
      const sym = String(symbol || cfg?.symbol || "").toUpperCase();
      const pct = Number(cfg.multiBudgetCoinPct[sym]);
      if (Number.isFinite(pct) && pct > 0) lane = Math.max(0, Math.min((pool * pct) / 100, headroom));
    }
  }

  const capEnabled = cfg?.perTradeBudgetCapEnabled !== false && !multiActive;
  if (capEnabled) {
    const rawCap = Number(cfg?.riskPerTrade) || 0;
    const usePctCap = String(cfg?.perTradeBudgetInputMode ?? "USDT").toUpperCase() === "PCT_OF_USABLE";
    const riskUnit = String(cfg?.riskPerTradeUnit ?? "PCT").toUpperCase();
    if (riskUnit === "USDT" && rawCap > 0) {
      lane = Math.min(lane, rawCap);
    } else if (usePctCap && rawCap > 0) {
      lane = Math.min(lane, (headroom * Math.max(0, Math.min(100, rawCap))) / 100);
    }
  }

  return Math.max(0, lane);
}

/**
 * @param {object} p
 * @param {number} p.equity
 * @param {number} p.entryFill
 * @param {number} p.sl sizing stop (not exit trail)
 * @param {Record<string, unknown>} p.cfg
 * @param {import("./costModel.js").ResolvedCostModel} p.cm
 * @param {boolean} p.isFutures
 * @param {number} [p.sizeMult]
 * @param {string} [p.symbol]
 * @param {number} [p.openMarginUsdt]
 * @returns {{ qty: number, marginUsdt: number, leverageCapped: boolean, allotmentCapped: boolean, uncappedQty: number, marginCapUsdt: number, allowedPoolUsdt: number, policyCapUsdt: number, maxNotionalUsdt: number }}
 */
export function computeEntryQtyDetailed({
  equity,
  entryFill,
  sl,
  cfg,
  cm,
  isFutures,
  sizeMult = 1,
  symbol = "",
  openMarginUsdt = 0,
}) {
  const entry = Number(entryFill);
  const empty = {
    qty: 0,
    marginUsdt: 0,
    leverageCapped: false,
    allotmentCapped: false,
    uncappedQty: 0,
    marginCapUsdt: 0,
    allowedPoolUsdt: 0,
    policyCapUsdt: 0,
    maxNotionalUsdt: 0,
  };
  if (!Number.isFinite(entry) || entry <= 0) return empty;

  const mult = Math.max(0.01, Number(sizeMult) || 1);
  const lev = Math.max(1, Number(cm?.leverage) || 1);
  const allowedPoolUsdt = resolveBacktestAllowedPoolUsdt(cfg, equity);
  const policyCapUsdt = resolveBacktestPolicyCapUsdt(cfg, equity, symbol);
  const marginCapUsdt = resolveBacktestMarginCapUsdt({ cfg, equity, symbol, openMarginUsdt });

  const walletMaxNotional = isFutures ? equity * lev : equity;
  const allotmentMaxNotional = isFutures ? marginCapUsdt * lev : marginCapUsdt;
  const maxNotionalUsdt = Math.min(walletMaxNotional, allotmentMaxNotional);

  const sizing = String(cfg?.backtestPositionSizing ?? "RISK_AT_SL").toUpperCase();
  let uncappedQty;

  if (sizing === "FULL_EQUITY_MARGIN" || sizing === "FULL_EQUITY") {
    uncappedQty =
      isFutures && lev > 0 ? (marginCapUsdt * lev * mult) / entry : (marginCapUsdt * mult) / entry;
  } else {
    const riskUnit = String(cfg?.riskPerTradeUnit ?? "PCT_EQUITY").toUpperCase();
    const dollarRisk =
      riskUnit === "USDT"
        ? Math.max(1, Number(cfg?.riskPerTrade ?? 10)) * mult
        : policyCapUsdt * (Math.max(0.01, Number(cfg?.riskPerTrade ?? 1)) / 100) * mult;
    const perUnitRisk = Math.abs(entry - Number(sl));
    uncappedQty = perUnitRisk > 0 ? dollarRisk / perUnitRisk : 0;
    if (!Number.isFinite(uncappedQty) || uncappedQty <= 0) {
      uncappedQty = (mult * policyCapUsdt * 0.01) / entry;
    }
  }

  let qty = uncappedQty;
  const uncappedNotional = Math.abs(uncappedQty) * entry;
  let leverageCapped = false;
  let allotmentCapped = false;

  if (maxNotionalUsdt > 0 && uncappedNotional > maxNotionalUsdt * 1.000001) {
    leverageCapped = true;
    if (allotmentMaxNotional < walletMaxNotional * 0.999) allotmentCapped = true;
    qty = maxNotionalUsdt / entry;
  }

  const bracketCap = Number(cfg?.backtestBracketNotionalCap ?? 0);
  if (isFutures && bracketCap > 0) {
    const notional = Math.abs(qty) * entry;
    if (notional > bracketCap) {
      leverageCapped = true;
      qty = bracketCap / entry;
    }
  }

  const marginUsdt = isFutures && lev > 0 ? (Math.abs(qty) * entry) / lev : Math.abs(qty) * entry;

  return {
    qty,
    marginUsdt,
    leverageCapped,
    allotmentCapped,
    uncappedQty,
    marginCapUsdt,
    allowedPoolUsdt,
    policyCapUsdt,
    maxNotionalUsdt,
  };
}
