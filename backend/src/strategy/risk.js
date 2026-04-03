import { clamp, roundTo } from "../lib/math.js";

function kellyFraction({ winRate, avgWin, avgLoss }) {
  const w = clamp(Number(winRate || 0), 0, 1);
  const aW = Math.abs(Number(avgWin || 0));
  const aL = Math.abs(Number(avgLoss || 0));
  if (aW <= 0 || aL <= 0 || w <= 0) return 0;
  const k = (w * aW - (1 - w) * aL) / aW;
  return Math.max(0, k);
}

export async function riskPlan({ exchange, side, entryPrice, confidence, riskPerTrade, atr, futuresLeverage, stats, regime }) {
  const account = await exchange.getAccount();
  const tradableBalance = Number(account.freeBalance ?? account.equity ?? 0);
  const totalEquity = Number(account.equity || 0);
  if (!tradableBalance || tradableBalance <= 0) return { ok: false, reason: "no_free_balance" };
  if (!totalEquity || totalEquity <= 0) return { ok: false, reason: "no_equity" };

  const conf = clamp(Number(confidence ?? 0.5), 0, 1);
  const baseRiskPct = clamp(Number(riskPerTrade ?? 0.01), 0.001, 0.05);

  let tierMult = 1.0;
  let sizingMethod = "tier";
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
    tierMult = clamp(halfKelly / baseRiskPct, 0.3, 2.0);
    tierMult *= conf >= 0.75 ? 1.0 : conf >= 0.60 ? 0.85 : conf >= 0.50 ? 0.6 : 0;
    sizingMethod = "kelly";
  } else {
    tierMult =
      conf >= 0.75 ? 1.15 :
      conf >= 0.60 ? 1.0 :
      conf >= 0.50 ? 0.7 :
      conf >= 0.40 ? 0.4 : 0;
  }
  if (tierMult <= 0) return { ok: false, reason: "confidence_too_low" };

  const riskUsd = Math.min(tradableBalance * baseRiskPct * tierMult, tradableBalance * 0.25);

  const px = Number(entryPrice);
  if (!px || px <= 0) return { ok: false, reason: "bad_price" };

  const regimeType = String(regime || "").toUpperCase();
  const isVolatile = regimeType.includes("VOLAT");
  const isTrending = regimeType.includes("TREND");

  const rawAtr = Number(atr || 0);
  const stopDist = isVolatile
    ? Math.max(rawAtr * 2.0, px * 0.012)
    : Math.max(rawAtr * 1.5, px * 0.008);

  const MIN_RR = 2.0;
  const rr = isTrending ? Math.max(2.5, MIN_RR)
    : isVolatile ? Math.max(1.8, MIN_RR)
    : MIN_RR;

  const isLong = side === "BUY";
  const stopLoss = isLong ? px - stopDist : px + stopDist;
  const takeProfit = isLong ? px + stopDist * rr : px - stopDist * rr;

  const perUnitRisk = Math.abs(px - stopLoss);
  if (perUnitRisk <= 0) return { ok: false, reason: "bad_stop" };

  let qty = roundTo(riskUsd / perUnitRisk, 6);
  const levHint = futuresLeverage != null ? Number(futuresLeverage) : NaN;
  const lev = Number.isFinite(levHint) && levHint > 0
    ? clamp(levHint, 1, 50)
    : clamp(Number(account.leverage ?? 1), 1, 50);
  const buyingPower = tradableBalance * (Number.isFinite(lev) ? lev : 1);
  const notional = qty * px;
  if (notional > buyingPower * 0.90) {
    qty = roundTo((buyingPower * 0.90) / px, 6);
  }
  if (!qty || qty <= 0) return { ok: false, reason: "qty_too_small" };

  return { ok: true, qty, stopLoss, takeProfit, tierMult, riskUsd, tradableBalance, sizingMethod };
}
