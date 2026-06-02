/**
 * USD-M futures: post SL/TP after a market fill.
 * Binance links TP/SL to the position row when using STOP_MARKET / TAKE_PROFIT_MARKET with
 * `closePosition=true` (mutually exclusive with `quantity` and `reduceOnly` per API rules).
 * Fallback: reduceOnly + quantity, then limit STOP/TAKE_PROFIT on -4120.
 */

function futuresOrderErrCode(e) {
  return e?.cause?.response?.data?.code ?? e?.response?.data?.code;
}

/**
 * @param {object} opts
 * @param {(method: string, path: string, params: Record<string, string>) => Promise<unknown>} opts.signed
 * @param {string} opts.symbol
 * @param {"BUY"|"SELL"} opts.closeSide
 * @param {string} opts.stopStr
 * @param {string} opts.tpStr
 * @param {string} opts.slLimitStr
 * @param {string} opts.tpLimitStr
 * @param {string} opts.executedQty
 * @param {Record<string, string>} [opts.hedgeExtras]
 * @param {{ info?: Function }} [opts.log]
 * @param {string} [opts.logPrefix]
 */
function makeClientAlgoId(prefix) {
  const raw = `${prefix}_${Date.now()}`;
  const s = raw.replace(/[^A-Za-z0-9._\-:/]/g, "_");
  return s.length <= 36 ? s : s.slice(0, 36);
}

export async function placeUsdMSlTpAfterMarketEntry(opts) {
  const {
    signed,
    symbol,
    closeSide,
    stopStr,
    tpStr,
    slLimitStr,
    tpLimitStr,
    executedQty,
    hedgeExtras = {},
    log,
    logPrefix = "binance_usdm",
  } = opts;

  const isHedge = Boolean(hedgeExtras?.positionSide);
  /** Algo API: reduceOnly cannot be sent in hedge mode (classic /order still uses reduceOnly). */
  const algoReduceOnly = isHedge ? {} : { reduceOnly: "true" };

  async function tryClassicThen4120Algo(classicFn, algoFn) {
    try {
      await classicFn();
    } catch (e) {
      if (!futuresOrderIs4120(e)) throw e;
      await algoFn();
    }
  }

  async function placeLeg(type, triggerPrice, limitPrice, idTag) {
    const marketType = `${type}_MARKET`;
    const common = {
      symbol,
      side: closeSide,
      stopPrice: String(triggerPrice),
      workingType: "MARK_PRICE",
      newClientOrderId: `${idTag}_${Date.now()}`,
      ...hedgeExtras,
    };

    const algoBase = {
      algoType: "CONDITIONAL",
      symbol,
      side: closeSide,
      triggerPrice: String(triggerPrice),
      workingType: "MARK_PRICE",
      clientAlgoId: makeClientAlgoId(idTag),
      ...hedgeExtras,
    };

    const postCp = async () => {
      await signed("POST", "/fapi/v1/order", {
        ...common,
        type: marketType,
        closePosition: "true",
      });
    };

    const postCpAlgo = async () => {
      await signed("POST", "/fapi/v1/algoOrder", {
        ...algoBase,
        type: marketType,
        closePosition: "true",
      });
    };

    const postRoQty = async () => {
      await signed("POST", "/fapi/v1/order", {
        ...common,
        type: marketType,
        reduceOnly: "true",
        quantity: String(executedQty),
      });
    };

    const postRoQtyAlgo = async () => {
      await signed("POST", "/fapi/v1/algoOrder", {
        ...algoBase,
        type: marketType,
        quantity: String(executedQty),
        ...algoReduceOnly,
      });
    };

    const postRoLimit = async () => {
      await signed("POST", "/fapi/v1/order", {
        ...common,
        type,
        price: String(limitPrice),
        timeInForce: "GTC",
        reduceOnly: "true",
        quantity: String(executedQty),
      });
    };

    const postRoLimitAlgo = async () => {
      await signed("POST", "/fapi/v1/algoOrder", {
        ...algoBase,
        type,
        triggerPrice: String(triggerPrice),
        price: String(limitPrice),
        timeInForce: "GTC",
        quantity: String(executedQty),
        ...algoReduceOnly,
      });
    };

    try {
      await tryClassicThen4120Algo(postCp, postCpAlgo);
    } catch (e1) {
      const c1 = futuresOrderErrCode(e1);
      log?.info?.(`${logPrefix}_sltp_closeposition_fallback`, {
        symbol,
        type,
        code: c1,
        msg: String(e1?.message || e1),
      });
      try {
        await tryClassicThen4120Algo(postRoQty, postRoQtyAlgo);
      } catch (e2) {
        const c2 = futuresOrderErrCode(e2);
        const is4120 = c2 === -4120 || String(e2?.message || "").includes("-4120");
        if (is4120) {
          log?.info?.(`${logPrefix}_sltp_limit_fallback`, { symbol, type });
          await tryClassicThen4120Algo(postRoLimit, postRoLimitAlgo);
        } else {
          throw e2;
        }
      }
    }
  }

  if (stopStr && slLimitStr) await placeLeg("STOP", stopStr, slLimitStr, "sl");
  if (tpStr && tpLimitStr) await placeLeg("TAKE_PROFIT", tpStr, tpLimitStr, "tp");
}

/**
 * Liquidity partial: SL full size, TP1 @ 1R (partial qty), TP2 @ opposing liquidity (runner).
 * @param {object} opts — same as placeUsdMSlTpAfterMarketEntry plus tp1Str, tp1LimitStr, partialFrac, formatQty(qtyNum)=>string
 */
export async function placeUsdMPartialLiqBrackets(opts) {
  const {
    signed,
    symbol,
    closeSide,
    stopStr,
    tpStr,
    tp1Str,
    slLimitStr,
    tpLimitStr,
    tp1LimitStr,
    executedQty,
    partialFrac = 0.5,
    formatQty,
    hedgeExtras = {},
    log,
    logPrefix = "binance_usdm",
  } = opts;

  if (!tp1Str || !formatQty) {
    await placeUsdMSlTpAfterMarketEntry(opts);
    return;
  }

  const isHedge = Boolean(hedgeExtras?.positionSide);
  const algoReduceOnly = isHedge ? {} : { reduceOnly: "true" };
  const frac = Math.min(0.75, Math.max(0.25, Number(partialFrac) || 0.5));
  const total = Number(executedQty);
  const qty1Str = formatQty(total * frac);
  const qty2Str = formatQty(Math.max(0, total - Number(qty1Str)));
  if (!qty1Str || !qty2Str || Number(qty2Str) <= 0) {
    await placeUsdMSlTpAfterMarketEntry(opts);
    return;
  }

  async function tryClassicThen4120Algo(classicFn, algoFn) {
    try {
      await classicFn();
    } catch (e) {
      if (!futuresOrderIs4120(e)) throw e;
      await algoFn();
    }
  }

  async function placeLegQty(type, triggerPrice, limitPrice, idTag, qtyStr) {
    const marketType = `${type}_MARKET`;
    const common = {
      symbol,
      side: closeSide,
      stopPrice: String(triggerPrice),
      workingType: "MARK_PRICE",
      newClientOrderId: `${idTag}_${Date.now()}`,
      ...hedgeExtras,
    };
    const algoBase = {
      algoType: "CONDITIONAL",
      symbol,
      side: closeSide,
      triggerPrice: String(triggerPrice),
      workingType: "MARK_PRICE",
      clientAlgoId: makeClientAlgoId(idTag),
      ...hedgeExtras,
    };

    const postRoQty = async () => {
      await signed("POST", "/fapi/v1/order", {
        ...common,
        type: marketType,
        reduceOnly: "true",
        quantity: String(qtyStr),
      });
    };
    const postRoQtyAlgo = async () => {
      await signed("POST", "/fapi/v1/algoOrder", {
        ...algoBase,
        type: marketType,
        quantity: String(qtyStr),
        ...algoReduceOnly,
      });
    };
    const postRoLimit = async () => {
      await signed("POST", "/fapi/v1/order", {
        ...common,
        type,
        price: String(limitPrice),
        timeInForce: "GTC",
        reduceOnly: "true",
        quantity: String(qtyStr),
      });
    };
    const postRoLimitAlgo = async () => {
      await signed("POST", "/fapi/v1/algoOrder", {
        ...algoBase,
        type,
        triggerPrice: String(triggerPrice),
        price: String(limitPrice),
        timeInForce: "GTC",
        quantity: String(qtyStr),
        ...algoReduceOnly,
      });
    };

    try {
      await tryClassicThen4120Algo(postRoQty, postRoQtyAlgo);
    } catch (e2) {
      const c2 = futuresOrderErrCode(e2);
      if (c2 === -4120 || String(e2?.message || "").includes("-4120")) {
        await tryClassicThen4120Algo(postRoLimit, postRoLimitAlgo);
      } else {
        throw e2;
      }
    }
  }

  await placeLegQty("STOP", stopStr, slLimitStr, "sl", executedQty);
  await placeLegQty("TAKE_PROFIT", tp1Str, tp1LimitStr ?? tpLimitStr, "tp1", qty1Str);
  if (opts.tp2Enabled !== false && tpStr && Number(tpStr) > 0) {
    await placeLegQty("TAKE_PROFIT", tpStr, tpLimitStr, "tp2", qty2Str);
  }
  log?.info?.(`${logPrefix}_partial_liq_brackets`, {
    symbol,
    qty1: qty1Str,
    qty2: qty2Str,
    frac,
    tp2: opts.tp2Enabled !== false,
  });
}

export function futuresOrderIs4120(e) {
  const c = futuresOrderErrCode(e);
  return c === -4120 || String(e?.message || "").includes("-4120");
}
