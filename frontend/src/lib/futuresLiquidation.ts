/**
 * Simplified USD-M isolated-style liquidation estimate (education / UI guardrail).
 * Binance uses tiered maintenance margin; we use a single conservative rate.
 */
export const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.006; // ~0.6%

/** Mirrors backend `riskPlan` tier ladder (non-Kelly path) for sizing preview. */
export function riskTierMultPreview(confidence: number, fixedUsdtCapital: boolean): number {
  if (fixedUsdtCapital) return 1;
  const c = Math.min(1, Math.max(0, Number(confidence)));
  if (c >= 0.75) return 1.15;
  if (c >= 0.6) return 1.0;
  if (c >= 0.5) return 0.7;
  if (c >= 0.4) return 0.4;
  return 0;
}

export function estimateIsolatedLinearLiqPrice(
  entryPx: number,
  leverage: number,
  isLong: boolean,
  maintenanceMarginRate = DEFAULT_MAINTENANCE_MARGIN_RATE,
): number | null {
  const E = Number(entryPx);
  const L = Math.max(1, Number(leverage) || 1);
  const mm = Math.max(0, Math.min(0.05, Number(maintenanceMarginRate) || DEFAULT_MAINTENANCE_MARGIN_RATE));
  if (!Number.isFinite(E) || E <= 0) return null;
  if (isLong) {
    const f = 1 - 1 / L + mm;
    const px = E * f;
    return Number.isFinite(px) && px > 0 && px < E ? px : null;
  }
  const f = 1 + 1 / L - mm;
  const px = E * f;
  return Number.isFinite(px) && px > E ? px : null;
}

/** LONG: liquidation must be below stop (hit SL before liq). SHORT: liquidation must be above stop. */
export function isLiquidationSafeVsStop(isLong: boolean, stopPx: number, liqPx: number | null): boolean {
  if (liqPx == null || !Number.isFinite(liqPx)) return false;
  const s = Number(stopPx);
  if (!Number.isFinite(s)) return false;
  if (isLong) return liqPx < s;
  return liqPx > s;
}

export function initialMarginUsd(entryPx: number, qty: number, leverage: number): number | null {
  const e = Number(entryPx);
  const q = Number(qty);
  const L = Math.max(1, Number(leverage) || 1);
  if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(q) || q <= 0) return null;
  return (e * q) / L;
}

/** Mirrors backend `spotBracketFromAtr` for USD-M preview (BUY = long, SELL = short). */
export function spotBracketFromAtrPreview(opts: {
  entryPrice: number;
  atr: number;
  regimeType: string;
  side: "BUY" | "SELL";
  aiConfidence?: number | null;
}): { stopLoss: number; takeProfit: number } | null {
  const px = Number(opts.entryPrice);
  const regimeType = String(opts.regimeType || "").toUpperCase();
  const isVolatile = regimeType.includes("VOLAT");
  const isTrending = regimeType.includes("TREND");
  const rawAtr = Number(opts.atr || 0);
  let stopDist = isVolatile ? Math.max(rawAtr * 2.0, px * 0.012) : Math.max(rawAtr * 1.5, px * 0.008);
  const MIN_RR = 2.0;
  let rr = isTrending ? Math.max(2.5, MIN_RR) : isVolatile ? Math.max(1.8, MIN_RR) : MIN_RR;

  const cRaw = opts.aiConfidence != null ? Number(opts.aiConfidence) : NaN;
  if (Number.isFinite(cRaw)) {
    const c = Math.min(1, Math.max(0, cRaw));
    const t = (c - 0.5) / 0.5;
    stopDist *= Math.min(1.22, Math.max(0.86, 1.08 - 0.2 * t));
    rr *= Math.min(3.4, Math.max(1.12, 1 + 0.45 * t));
  }

  const isLong = opts.side === "BUY";
  const stopLoss = isLong ? px - stopDist : px + stopDist;
  const takeProfit = isLong ? px + stopDist * rr : px - stopDist * rr;
  if (!Number.isFinite(stopLoss) || !Number.isFinite(takeProfit)) return null;
  return { stopLoss, takeProfit };
}

export type LiquidationPreviewResult = {
  ok: boolean;
  entryPx: number;
  leverage: number;
  notionalUsd: number;
  marginUsd: number | null;
  stopLoss: number;
  liqPx: number | null;
  isLong: boolean;
  hints: string[];
};

/** MARKET-style manual order: SL% from entry (same as backend `manualTrade`). */
export function manualMarketLiquidationPreview(opts: {
  entryPx: number;
  notionalUsd: number;
  leverage: number;
  side: "BUY" | "SELL";
  /** Stop distance as fraction of price, e.g. 0.002 = 0.2%. */
  stopLossPctFraction: number;
  maintenanceMarginRate?: number;
}): { marginUsd: number | null; stopPx: number; liqPx: number | null; safe: boolean; isLong: boolean } | null {
  const E = Number(opts.entryPx);
  const nom = Number(opts.notionalUsd);
  const L = Math.max(1, Math.floor(Number(opts.leverage) || 1));
  const slf = Math.abs(Number(opts.stopLossPctFraction));
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(nom) || nom <= 0 || !Number.isFinite(slf) || slf <= 0) return null;
  const isLong = opts.side === "BUY";
  const stopPx = isLong ? E * (1 - slf) : E * (1 + slf);
  const qty = nom / E;
  const marginUsd = initialMarginUsd(E, qty, L);
  const liqPx = estimateIsolatedLinearLiqPrice(E, L, isLong, opts.maintenanceMarginRate);
  const safe = isLiquidationSafeVsStop(isLong, stopPx, liqPx);
  return { marginUsd, stopPx, liqPx, safe, isLong };
}

export function buildAutotradeLongLiquidationPreview(opts: {
  entryPx: number;
  leverage: number;
  targetNotionalUsd: number;
  atr: number;
  regimeType: string;
  aiConfidence?: number | null;
  maintenanceMarginRate?: number;
}): LiquidationPreviewResult | null {
  const entryPx = Number(opts.entryPx);
  const lev = Math.max(1, Math.floor(Number(opts.leverage) || 1));
  const nom = Number(opts.targetNotionalUsd);
  if (!Number.isFinite(entryPx) || entryPx <= 0 || !Number.isFinite(nom) || nom <= 0) return null;

  const bracket = spotBracketFromAtrPreview({
    entryPrice: entryPx,
    atr: opts.atr,
    regimeType: opts.regimeType,
    side: "BUY",
    aiConfidence: opts.aiConfidence,
  });
  if (!bracket) return null;

  const qty = nom / entryPx;
  const marginUsd = initialMarginUsd(entryPx, qty, lev);
  const liqPx = estimateIsolatedLinearLiqPrice(entryPx, lev, true, opts.maintenanceMarginRate);
  const safe = isLiquidationSafeVsStop(true, bracket.stopLoss, liqPx);
  const hints: string[] = [];
  if (!safe) {
    hints.push("Lower futures leverage (widens distance to liquidation).");
    hints.push("Reduce Risk/trade USDT if sizing at buying-power cap (frees wallet buffer).");
    hints.push("Volatile regimes widen ATR stops — calmer trend/volatility improves SL vs liq spacing.");
  }
  return {
    ok: safe,
    entryPx,
    leverage: lev,
    notionalUsd: nom,
    marginUsd,
    stopLoss: bracket.stopLoss,
    liqPx,
    isLong: true,
    hints,
  };
}
