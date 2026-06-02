/**
 * After liquidity partial TP fills (~50% @ 1R), cancel SL and re-post at breakeven for runner.
 */
import { usdmBracketPriceStrings } from "./binanceFuturesBracketPrices.js";
import { futuresOrderIs4120 } from "./binanceFuturesSlTpBracket.js";
import { cancelAllStopLossOrdersForDirectionUsdM } from "./binanceUsdMTrailSlReplace.js";

function makeClientAlgoId(prefix) {
  const raw = `${prefix}_${Date.now()}`;
  const s = raw.replace(/[^A-Za-z0-9._\-:/]/g, "_");
  return s.length <= 36 ? s : s.slice(0, 36);
}

/**
 * @param {object} ctx
 * @param {object} ctx.mem
 * @param {string} ctx.symU
 * @param {Array<{ symbol: string, positionAmt: number, entryPrice: number, positionSide?: string }>} ctx.positions
 * @param {(sym: string) => Promise<number>} ctx.markPxForSymbol
 * @param {Function} ctx.signed
 * @param {Function} ctx.getOrLoadSymbolMeta
 * @param {Function} ctx.normalizeAlgoOrdersPayload
 * @param {{ info?: Function, warn?: Function }} [ctx.log]
 * @param {string} [ctx.logPrefix]
 */
export async function maybeMoveLiqSlToBreakevenAfterPartial(ctx) {
  const {
    mem,
    symU,
    positions,
    markPxForSymbol,
    signed,
    getOrLoadSymbolMeta,
    normalizeAlgoOrdersPayload,
    log,
    logPrefix = "binance_usdm_liq_be",
  } = ctx;

  const tgt = mem?.placedBracketTargets?.[symU];
  if (!tgt || tgt.beAfterPartial === false) return;

  const beAt1R = tgt.liqBeAt1R === true && tgt.liqPartial !== true;
  if (!tgt.liqPartial && !beAt1R) return;
  if (tgt.liqPartial && tgt.partialTaken === true) return;
  if (beAt1R && tgt.beMoved === true) return;

  const pos = (positions || []).find((p) => String(p.symbol || "").toUpperCase() === symU);
  const curQty = pos ? Math.abs(Number(pos.positionAmt || 0)) : 0;
  if (curQty < 1e-8) return;

  const initQty = Number(tgt.initialQty);
  const frac = Math.min(0.75, Math.max(0.25, Number(tgt.partialFrac) || 0.5));
  const runnerQty = beAt1R ? initQty : initQty * (1 - frac);
  const markPx = await markPxForSymbol(symU);
  if (!Number.isFinite(markPx) || markPx <= 0) return;

  const tp1 = Number(tgt.tp1Price);
  const isLong = Boolean(tgt.isLong);
  const hitTp1 =
    Number.isFinite(tp1) &&
    tp1 > 0 &&
    (isLong ? markPx >= tp1 * 0.9995 : markPx <= tp1 * 1.0005);
  const qtyReduced =
    !beAt1R &&
    initQty > 0 &&
    curQty <= runnerQty * 1.08 &&
    curQty < initQty * (1 - frac * 0.85);

  if (!hitTp1 && !qtyReduced) return;

  const entry = Number(tgt.entryPrice);
  if (!Number.isFinite(entry) || entry <= 0) return;

  const feeBuf = Number(tgt.feeBuf) || 0.001;
  const bePx = isLong ? entry * (1 + feeBuf) : entry * (1 - feeBuf);
  const closeSide = tgt.closeSide || (isLong ? "SELL" : "BUY");
  const hedgeExtras = tgt.hedgeExtras || {};

  const m = await getOrLoadSymbolMeta(symU);
  const { stopStr, slLimitStr } = usdmBracketPriceStrings({
    isLong,
    stopPx: bePx,
    tpPx: Number(tgt.takeProfit) || bePx,
    meta: m,
    closeSide,
  });
  if (!stopStr) return;

  try {
    await cancelAllStopLossOrdersForDirectionUsdM({
      signed,
      symU,
      closeSide,
      normalizeAlgoOrdersPayload,
      log,
      logPrefix,
    });
  } catch (e) {
    log?.warn?.(`${logPrefix}_cancel_sl_failed`, { symbol: symU, error: String(e?.message || e) });
    return;
  }

  const qtyStr = String(beAt1R ? tgt.qty : tgt.qtyRunner ?? tgt.qty);
  const algoReduceOnly = hedgeExtras?.positionSide ? {} : { reduceOnly: "true" };

  const postStop = async () => {
    await signed("POST", "/fapi/v1/order", {
      symbol: symU,
      side: closeSide,
      type: "STOP_MARKET",
      stopPrice: stopStr,
      workingType: "MARK_PRICE",
      reduceOnly: "true",
      quantity: qtyStr,
      newClientOrderId: `liq_be_${Date.now()}`,
      ...hedgeExtras,
    });
  };

  const postStopAlgo = async () => {
    await signed("POST", "/fapi/v1/algoOrder", {
      algoType: "CONDITIONAL",
      symbol: symU,
      side: closeSide,
      type: "STOP_MARKET",
      triggerPrice: stopStr,
      workingType: "MARK_PRICE",
      quantity: qtyStr,
      clientAlgoId: makeClientAlgoId("liq_be"),
      ...hedgeExtras,
      ...algoReduceOnly,
    });
  };

  try {
    try {
      await postStop();
    } catch (e) {
      if (!futuresOrderIs4120(e)) throw e;
      await postStopAlgo();
    }
    if (beAt1R) tgt.beMoved = true;
    else tgt.partialTaken = true;
    tgt.stopLoss = bePx;
    tgt.qty = qtyStr;
    log?.info?.(`${logPrefix}_moved`, {
      symbol: symU,
      bePx,
      curQty,
      initQty,
      hitTp1,
      qtyReduced,
      beAt1R,
    });
  } catch (e) {
    log?.warn?.(`${logPrefix}_place_failed`, { symbol: symU, error: String(e?.message || e) });
  }
}
