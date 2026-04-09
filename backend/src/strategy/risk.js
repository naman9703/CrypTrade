import { clamp, roundTo } from "../lib/math.js";

/**
 * Stop / take-profit distances (same logic as `riskPlan`, Pine-style Supertrend companion).
 * Optional `aiConfidence` (0..1): higher scores modestly tighten stops and extend reward — used for futures+AI paths.
 */
export function spotBracketFromAtr({ entryPrice, atr, regime, side, aiConfidence }) {
  const px = Number(entryPrice);
  const regimeType = String(regime || "").toUpperCase();
  const isVolatile = regimeType.includes("VOLAT");
  const isTrending = regimeType.includes("TREND");
  const rawAtr = Number(atr || 0);
  let stopDist = isVolatile
    ? Math.max(rawAtr * 2.0, px * 0.012)
    : Math.max(rawAtr * 1.5, px * 0.008);
  const MIN_RR = 2.0;
  let rr = isTrending ? Math.max(2.5, MIN_RR) : isVolatile ? Math.max(1.8, MIN_RR) : MIN_RR;

  const cRaw = aiConfidence != null ? Number(aiConfidence) : NaN;
  if (Number.isFinite(cRaw)) {
    const c = clamp(cRaw, 0, 1);
    const t = (c - 0.5) / 0.5;
    stopDist *= clamp(1.08 - 0.2 * t, 0.86, 1.22);
    rr *= clamp(1 + 0.45 * t, 1.12, 3.4);
  }

  const isLong = side === "BUY";
  const stopLoss = isLong ? px - stopDist : px + stopDist;
  const takeProfit = isLong ? px + stopDist * rr : px - stopDist * rr;
  return { stopLoss, takeProfit, stopDist, rr };
}

function kellyFraction({ winRate, avgWin, avgLoss }) {
  const w = clamp(Number(winRate || 0), 0, 1);
  const aW = Math.abs(Number(avgWin || 0));
  const aL = Math.abs(Number(avgLoss || 0));
  if (aW <= 0 || aL <= 0 || w <= 0) return 0;
  const k = (w * aW - (1 - w) * aL) / aW;
  return Math.max(0, k);
}

export async function riskPlan({
  exchange,
  side,
  entryPrice,
  confidence,
  riskPerTrade,
  /**
   * `"PCT"` = `riskPerTrade` is fraction of balance (0.001–0.05); qty sized so ~that fraction is at risk at the stop.
   * `"USDT"` = target **investing capital** per trade: quote notional (before tiers), capped by ~90% buying power;
   * SL/TP still ATR-based; returned `riskUsd` is implied USD at stop for the final qty.
   * When `fixedUsdtCapitalSizing` is true (Risk/trade + max daily loss both USDT), notional = `riskPerTrade` × 1 with no AI/Kelly tiering.
   */
  riskPerTradeUnit = "PCT",
  fixedUsdtCapitalSizing = false,
  atr,
  futuresLeverage,
  stats,
  regime,
  aiConfidence,
}) {
  const account = await exchange.getAccount();
  const tradableBalance = Number(account.freeBalance ?? account.equity ?? 0);
  const totalEquity = Number(account.equity || 0);
  if (!tradableBalance || tradableBalance <= 0) return { ok: false, reason: "no_free_balance" };
  if (!totalEquity || totalEquity <= 0) return { ok: false, reason: "no_equity" };

  const conf = clamp(Number(confidence ?? 0.5), 0, 1);
  const isUsdtRisk = String(riskPerTradeUnit || "PCT").toUpperCase() === "USDT";
  const riskInput = Number(riskPerTrade ?? (isUsdtRisk ? 100 : 0.01));
  /** Implied balance fraction for Kelly scaling (USDT path: target notional ÷ balance). */
  const basePctForKelly = isUsdtRisk
    ? clamp(riskInput / Math.max(tradableBalance, 1e-9), 0.00001, 0.5)
    : clamp(riskInput, 0.001, 0.05);

  let tierMult = 1.0;
  let sizingMethod = "tier";
  const fixedCapital =
    Boolean(fixedUsdtCapitalSizing) && isUsdtRisk;

  if (fixedCapital) {
    tierMult = 1.0;
    sizingMethod = "fixed_usdt";
  } else {
    const st = stats || {};
    const totalTrades = Number(st.trades || 0);
    const totalWins = Number(st.wins || 0);
    const totalPnl = Number(st.pnl || 0);

    if (totalTrades >= 20 && totalWins > 0 && totalWins < totalTrades) {
      const wr = totalWins / totalTrades;
      const avgWin = totalPnl > 0 ? totalPnl / totalWins : Math.abs(totalPnl / totalTrades);
      const avgLoss = totalPnl < 0
        ? Math.abs(totalPnl) / (totalTrades - totalWins)
        : Math.abs(totalPnl / totalTrades) || 1;
      const kelly = kellyFraction({ winRate: wr, avgWin, avgLoss });
      const halfKelly = kelly * 0.5;
      tierMult = clamp(halfKelly / basePctForKelly, 0.3, 2.0);
      tierMult *= conf >= 0.75 ? 1.0 : conf >= 0.60 ? 0.85 : conf >= 0.50 ? 0.6 : 0;
      sizingMethod = "kelly";
    } else {
      tierMult =
        conf >= 0.75 ? 1.15 :
        conf >= 0.60 ? 1.0 :
        conf >= 0.50 ? 0.7 :
        conf >= 0.40 ? 0.4 : 0;
    }
    /** AI (or blended) probability below 0.40 ⇒ tier multiplier 0 — not “Supertrend signal strength”. */
    if (tierMult <= 0) return { ok: false, reason: "ai_prob_below_risk_tier" };
  }

  const px = Number(entryPrice);
  if (!px || px <= 0) return { ok: false, reason: "bad_price" };

  const bracketAi =
    fixedCapital ? undefined : aiConfidence;
  const { stopLoss, takeProfit } = spotBracketFromAtr({
    entryPrice: px,
    atr,
    regime,
    side,
    aiConfidence: bracketAi,
  });

  const perUnitRisk = Math.abs(px - stopLoss);
  if (perUnitRisk <= 0) return { ok: false, reason: "bad_stop" };

  const levHint = futuresLeverage != null ? Number(futuresLeverage) : NaN;
  const lev = Number.isFinite(levHint) && levHint > 0
    ? clamp(levHint, 1, 100)
    : clamp(Number(account.leverage ?? 1), 1, 100);
  const buyingPower = tradableBalance * (Number.isFinite(lev) ? lev : 1);

  let qty;
  let riskUsd;
  if (isUsdtRisk) {
    let targetNotional = riskInput * tierMult;
    targetNotional = Math.min(targetNotional, buyingPower * 0.90);
    qty = roundTo(targetNotional / px, 6);
    riskUsd = qty * perUnitRisk;
  } else {
    const riskBudget = Math.min(tradableBalance * basePctForKelly * tierMult, tradableBalance * 0.25);
    qty = roundTo(riskBudget / perUnitRisk, 6);
    const notional = qty * px;
    if (notional > buyingPower * 0.90) {
      qty = roundTo((buyingPower * 0.90) / px, 6);
    }
    riskUsd = qty * perUnitRisk;
  }

  if (!qty || qty <= 0) return { ok: false, reason: "qty_too_small" };

  return { ok: true, qty, stopLoss, takeProfit, tierMult, riskUsd, tradableBalance, sizingMethod };
}
