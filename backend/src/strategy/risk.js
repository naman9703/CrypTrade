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
   * `"PCT"` = `riskPerTrade` is fraction of capital at stop (0.001–0.05), by default vs exchange free balance; when
   * `pctPolicyCapUsdt` is set, vs `min(free balance, that cap)` so sizing matches configured allowed pool.
   * `"USDT"` = target quote **notional** per trade on **spot** (before tiers), capped by ~90% wallet buying power.
   * **Futures USD-M** (when `futuresLeverage` is passed): `riskPerTrade` is **initial margin USDT** (collateral
   * before leverage); quote notional ≈ margin × `futuresLeverage`, then capped by ~90% wallet buying power.
   * SL/TP still ATR-based; returned `riskUsd` is implied USD at stop for the final qty.
   * When `fixedUsdtCapitalSizing` is true (Risk/trade + max daily loss both USDT), tier multiplier is 1 (no Kelly on size).
   */
  riskPerTradeUnit = "PCT",
  fixedUsdtCapitalSizing = false,
  /** When fixed USDT sizing: divide `riskPerTrade` by this (e.g. pinned coin count) before notional cap. */
  fixedUsdtSplitDivisor = 1,
  /**
   * When `riskPerTradeUnit` is PCT: optional cap (USDT) on the balance used for %‑of‑capital at stop — typically
   * `allowedBudgetUsdt` (clamped to wallet once). Exchange still caps by real buying power below.
   */
  pctPolicyCapUsdt = null,
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
  const riskInput = Number(riskPerTrade ?? (isUsdtRisk ? 100 : 1));
  const policyCap = Number(pctPolicyCapUsdt);
  const pctBalanceBase =
    !isUsdtRisk && Number.isFinite(policyCap) && policyCap > 0
      ? Math.min(tradableBalance, policyCap)
      : tradableBalance;
  /**
   * USDT sizing: Kelly tiers compare risk vs **capital allotment** when `pctPolicyCapUsdt` is set (same pool as UI),
   * not full wallet free balance.
   */
  const usdtKellyBase =
    Number.isFinite(policyCap) && policyCap > 0 ? Math.min(tradableBalance, policyCap) : tradableBalance;
  /** Implied balance fraction for Kelly scaling (USDT path: target margin ÷ allowed pool). */
  const basePctForKelly = isUsdtRisk
    ? clamp(riskInput / Math.max(usdtKellyBase, 1e-9), 0.00001, 0.5)
    : clamp(clamp(riskInput, 0, 100) / 100, 0, 1);

  let tierMult = 1.0;
  let sizingMethod = "tier";
  const fixedCapital =
    Boolean(fixedUsdtCapitalSizing) && isUsdtRisk;
  const splitDiv = Math.max(1, Math.floor(Number(fixedUsdtSplitDivisor) || 1));

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
  /** Wallet cap on quote notional (USDT-M: free margin × leverage). */
  const walletBuyingPower = tradableBalance * (Number.isFinite(lev) ? lev : 1);
  /**
   * When `futuresLeverage` is supplied, `riskPerTrade` / `riskBase` are **initial margin USDT** from the
   * capital-allotment path (not quote notional). Linear futures: notional ≈ margin × leverage.
   * Spot / non-futures: `futuresLeverage` is omitted → treat `riskBase` as quote notional (unchanged).
   */
  const futuresMarginSizing = isUsdtRisk && Number.isFinite(levHint) && levHint > 0;

  let qty;
  let riskUsd;
  if (isUsdtRisk) {
    const riskBase = fixedCapital && splitDiv > 1 ? riskInput / splitDiv : riskInput;
    if (fixedCapital && (!Number.isFinite(riskBase) || riskBase <= 0)) {
      return { ok: false, reason: "no_capital_allotment" };
    }
    let targetNotional;
    if (futuresMarginSizing) {
      /**
       * riskBase IS the per-coin margin cap from capital allotment.
       * Rule: notional = margin × leverage. tierMult must not inflate beyond the allocated cap
       * (only allows conservative downscaling for lower-confidence entries, never upscaling).
       * Formula: targetNotional = riskBase × min(tierMult, 1.0) × lev
       *          → final margin = targetNotional / lev ≤ riskBase always.
       */
      const safeTierMult = fixedCapital ? 1.0 : Math.min(tierMult, 1.0);
      targetNotional = riskBase * safeTierMult * lev;
    } else {
      targetNotional = riskBase * tierMult;
    }
    targetNotional = Math.min(targetNotional, walletBuyingPower * 0.90);
    qty = roundTo(targetNotional / px, 6);
    riskUsd = qty * perUnitRisk;
  } else {
    const riskBudget = Math.min(pctBalanceBase * basePctForKelly * tierMult, pctBalanceBase * 0.25);
    qty = roundTo(riskBudget / perUnitRisk, 6);
    const notional = qty * px;
    if (notional > walletBuyingPower * 0.90) {
      qty = roundTo((walletBuyingPower * 0.90) / px, 6);
    }
    riskUsd = qty * perUnitRisk;
  }

  if (!qty || qty <= 0) return { ok: false, reason: "qty_too_small" };

  return { ok: true, qty, stopLoss, takeProfit, tierMult, riskUsd, tradableBalance, sizingMethod };
}

/**
 * Override ATR brackets with fixed %-of-price SL/TP (manual signal paths + backtests).
 * Recalculates qty from `riskUsd` when per-unit risk changes.
 */
export function applyFixedPctBracket(plan, { entryPrice, side, slPct, tpPct, futuresLeverage }) {
  if (!plan?.ok) return plan;
  const px = Number(entryPrice);
  const sl = clamp(Number(slPct), 0.00005, 0.2);
  const tp = clamp(Number(tpPct ?? 0), 0, 0.5);
  if (!px || px <= 0 || sl <= 0) return plan;

  const isLong = side === "BUY";
  const stopLoss = isLong ? px * (1 - sl) : px * (1 + sl);
  const takeProfit =
    tp > 0 ? (isLong ? px * (1 + tp) : px * (1 - tp)) : plan.takeProfit;

  const perUnitRisk = Math.abs(px - stopLoss);
  let qty = plan.qty;
  const riskUsd = Number(plan.riskUsd);
  if (perUnitRisk > 0 && riskUsd > 0) {
    qty = roundTo(riskUsd / perUnitRisk, 6);
    const lev = clamp(Number(futuresLeverage ?? 1), 1, 100);
    const walletBp = Number(plan.tradableBalance) * lev;
    const maxNotional = walletBp * 0.9;
    const notional = qty * px;
    if (notional > maxNotional && px > 0) qty = roundTo(maxNotional / px, 6);
  }

  return { ...plan, qty, stopLoss, takeProfit };
}
