/**
 * Shared USD-M futures trailing: cancel SL-only orders and replace STOP after `applyTrailingStopBinanceMemory`.
 * Used by live (and optionally demo) Binance USD-M adapters.
 */

import { usdmBracketPriceStrings } from "./binanceFuturesBracketPrices.js";
import { futuresOrderIs4120 } from "./binanceFuturesSlTpBracket.js";

function futuresOrderErrCode(e) {
  return e?.cause?.response?.data?.code ?? e?.response?.data?.code;
}

/**
 * @param {object} p
 * @param {(m: string, path: string, params?: Record<string, string>) => Promise<unknown>} p.signed
 * @param {string} p.symU
 * @param {"BUY"|"SELL"} p.closeSide
 * @param {(raw: unknown) => unknown[]} p.normalizeAlgoOrdersPayload
 * @param {{ warn?: Function }} [p.log]
 * @param {string} [p.logPrefix]
 */
export async function cancelAllStopLossOrdersForDirectionUsdM({
  signed,
  symU,
  closeSide,
  normalizeAlgoOrdersPayload,
  log,
  logPrefix = "binance_usdm_trail",
}) {
  const sideU = String(closeSide || "").toUpperCase();
  const [openClassic, algoRaw] = await Promise.all([
    signed("GET", "/fapi/v1/openOrders", { symbol: symU }).catch(() => []),
    signed("GET", "/fapi/v1/openAlgoOrders", { symbol: symU, algoType: "CONDITIONAL" }).catch(() => null),
  ]);
  const classicOrders = Array.isArray(openClassic) ? openClassic : [];
  const algoList = normalizeAlgoOrdersPayload(algoRaw);
  let n = 0;
  for (const o of classicOrders) {
    const typ = String(o.origType || o.type || "").toUpperCase();
    const side = String(o.side || "").toUpperCase();
    const isSl = typ.includes("STOP") && !typ.includes("TAKE_PROFIT");
    if (!isSl || side !== sideU) continue;
    await signed("DELETE", "/fapi/v1/order", { symbol: symU, orderId: String(o.orderId) }).catch(() => null);
    n += 1;
  }
  for (const ao of algoList) {
    if (String(ao.symbol || "").toUpperCase() !== symU) continue;
    const typ = String(ao.orderType || ao.origType || ao.type || "").toUpperCase();
    const side = String(ao.side || "").toUpperCase();
    const isSl = typ.includes("STOP") && !typ.includes("TAKE_PROFIT");
    if (!isSl || side !== sideU) continue;
    const algoId = ao.algoId ?? ao.orderId;
    if (!algoId) continue;
    await signed("DELETE", "/fapi/v1/algoOrder", { symbol: symU, algoId: String(algoId) }).catch(() => null);
    n += 1;
  }
  if (n > 0) log?.info?.(`${logPrefix}_trail_sl_cancelled_conflicting`, { symbol: symU, side: sideU, count: n });
}

/**
 * @param {object} ctx
 * @param {object} ctx.mem
 * @param {(m: string, path: string, params?: Record<string, string>) => Promise<unknown>} ctx.signed
 * @param {(path: string, params?: Record<string, string>) => Promise<unknown>} ctx.publicGet
 * @param {(sym: string) => Promise<object>} ctx.getOrLoadSymbolMeta
 * @param {string} ctx.symU
 * @param {number} ctx.newSlPx
 * @param {number} ctx.markPxHint
 * @param {number | null} [ctx.previousExchangeSlPx]
 * @param {number} ctx.defaultLeverage
 * @param {{ info?: Function; warn?: Function }} [ctx.log]
 * @param {string} [ctx.logPrefix]
 * @param {(symU: string) => number | null | undefined} [ctx.getOptionalMarkPx] demo mark-price WS cache; omit on live
 * @param {(symU: string) => void} [ctx.clearSlTpOpenOrdersCache]
 */
export async function replaceExchangeSlOrderUsdM(ctx) {
  const {
    mem,
    signed,
    publicGet,
    getOrLoadSymbolMeta,
    symU,
    newSlPx,
    markPxHint,
    previousExchangeSlPx = null,
    defaultLeverage,
    log,
    logPrefix = "binance_usdm_trail",
    getOptionalMarkPx,
    clearSlTpOpenOrdersCache,
  } = ctx;

  const tgt = mem.placedBracketTargets[symU];
  if (!tgt || !Number.isFinite(newSlPx) || newSlPx <= 0) return { ok: false, code: null, msg: "missing_target" };
  if (!tgt.closeSide) return { ok: false, code: null, msg: "missing_close_side" };
  const isLong = tgt.closeSide === "SELL";

  function resolveQtyStr() {
    const q0 = Number(tgt.qty ?? 0);
    if (Number.isFinite(q0) && q0 > 0) return String(q0);
    if (Array.isArray(mem.lastPositionSnapshot)) {
      const p = mem.lastPositionSnapshot.find((r) => String(r?.symbol || "").toUpperCase() === symU);
      const qa = Math.abs(Number(p?.positionAmt || 0));
      if (Number.isFinite(qa) && qa > 0) return String(qa);
    }
    return null;
  }

  const hedgeExtrasR = tgt.hedgeExtras || {};
  const isHedge = Boolean(hedgeExtrasR.positionSide);
  const algoReduceOnly = isHedge ? {} : { reduceOnly: "true" };

  async function executePlaceAttempts(slPxTarget) {
    const mloc = await getOrLoadSymbolMeta(symU).catch(() => null);
    const { stopStr: st0 } = usdmBracketPriceStrings({
      isLong,
      stopPx: slPxTarget,
      tpPx: Number(tgt.takeProfit) || slPxTarget * (isLong ? 2 : 0.5),
      meta: mloc,
      closeSide: tgt.closeSide,
    });
    const st = st0;
    if (!st) return { placed: false, immediate2021: false, lastCode: null, lastMsg: "bad_stop_str" };
    let placedInner = false;
    let lastCodeInner = null;
    let lastMsgInner = null;
    const attemptsInner = [
      { endpoint: "algo", mode: "closePosition" },
      { endpoint: "algo", mode: "reduceOnly" },
      { endpoint: "classic", mode: "closePosition" },
      { endpoint: "classic", mode: "reduceOnly" },
    ];
    for (const { endpoint, mode } of attemptsInner) {
      if (placedInner) break;
      try {
        if (mode === "reduceOnly") {
          if (isHedge) continue;
          const qStr = resolveQtyStr();
          if (!qStr) continue;
          if (endpoint === "algo") {
            await signed("POST", "/fapi/v1/algoOrder", {
              algoType: "CONDITIONAL",
              symbol: symU,
              side: tgt.closeSide,
              type: "STOP_MARKET",
              triggerPrice: st,
              workingType: "MARK_PRICE",
              reduceOnly: "true",
              quantity: qStr,
              newClientAlgoId: `trail_sl_ro_${Date.now()}`,
              ...hedgeExtrasR,
            });
          } else {
            await signed("POST", "/fapi/v1/order", {
              symbol: symU,
              side: tgt.closeSide,
              type: "STOP_MARKET",
              stopPrice: st,
              workingType: "MARK_PRICE",
              reduceOnly: "true",
              quantity: qStr,
              newClientOrderId: `trail_sl_ro_${Date.now()}`,
              ...hedgeExtrasR,
            });
          }
        } else if (endpoint === "algo") {
          await signed("POST", "/fapi/v1/algoOrder", {
            algoType: "CONDITIONAL",
            symbol: symU,
            side: tgt.closeSide,
            type: "STOP_MARKET",
            triggerPrice: st,
            workingType: "MARK_PRICE",
            closePosition: "true",
            newClientAlgoId: `trail_sl_${Date.now()}`,
            ...hedgeExtrasR,
          });
        } else {
          await signed("POST", "/fapi/v1/order", {
            symbol: symU,
            side: tgt.closeSide,
            type: "STOP_MARKET",
            stopPrice: st,
            workingType: "MARK_PRICE",
            closePosition: "true",
            newClientOrderId: `trail_sl_${Date.now()}`,
            ...hedgeExtrasR,
          });
        }
        placedInner = true;
      } catch (e) {
        lastCodeInner = futuresOrderErrCode(e);
        lastMsgInner = e?.cause?.response?.data?.msg ?? e?.response?.data?.msg ?? e?.message ?? null;
        if (lastCodeInner === -2021) {
          log?.info?.(`${logPrefix}_trail_sl_immediate_trigger`, {
            symbol: symU,
            newSlPx: slPxTarget,
            msg: "Mark crossed SL — installing local bracket for immediate close",
          });
          const qStr = resolveQtyStr();
          const positionSideField = hedgeExtrasR.positionSide || undefined;
          mem.localBrackets[symU] = {
            stopLoss: slPxTarget,
            takeProfit: Number(tgt.takeProfit) || (isLong ? slPxTarget * 10 : slPxTarget * 0.01),
            isLong,
            closeSide: tgt.closeSide,
            qty: qStr || tgt.qty || "0",
            positionSide: positionSideField,
            entryPrice: mem.trailingBySymbol[symU]?.entryPrice ?? 0,
            leverage: mem.trailingBySymbol[symU]?.leverage ?? defaultLeverage,
            strategy: "trailing_sl_breach",
            _installedAt: Date.now(),
          };
          mem.placedBracketTargets[symU] = { ...tgt, stopLoss: slPxTarget };
          return { placed: false, immediate2021: true, lastCode: lastCodeInner, lastMsg: lastMsgInner };
        }
      }
    }
    return { placed: placedInner, immediate2021: false, lastCode: lastCodeInner, lastMsg: lastMsgInner };
  }

  try {
    let markForCheck = Number(markPxHint);
    if (!Number.isFinite(markForCheck) || markForCheck <= 0) {
      try {
        const cached = typeof getOptionalMarkPx === "function" ? getOptionalMarkPx(symU) : null;
        if (cached != null && Number.isFinite(cached) && cached > 0) markForCheck = cached;
        else {
          const d = await publicGet("/fapi/v1/premiumIndex", { symbol: symU });
          markForCheck = Number(d?.markPrice);
        }
      } catch {
        /* use hint */
      }
    }
    if (Number.isFinite(markForCheck) && markForCheck > 0) {
      const wouldTrigger = isLong ? markForCheck <= newSlPx : markForCheck >= newSlPx;
      if (wouldTrigger) {
        log?.warn?.(`${logPrefix}_trail_sl_skip_would_trigger`, {
          symbol: symU,
          newSlPx,
          markPx: markForCheck,
          msg: "Skipping SL replace — new trailing SL would immediately trigger; keeping existing exchange SL",
        });
        return { ok: false, code: -2021, msg: "skip_would_trigger_precheck" };
      }
    }

    await cancelAllStopLossOrdersForDirectionUsdM({
      signed,
      symU,
      closeSide: tgt.closeSide,
      normalizeAlgoOrdersPayload: ctx.normalizeAlgoOrdersPayload,
      log,
      logPrefix,
    });
    clearSlTpOpenOrdersCache?.(symU);

    const prNew = await executePlaceAttempts(newSlPx);
    if (prNew.immediate2021) {
      return { ok: true, localBracketInstalled: true };
    }
    if (prNew.placed) {
      mem.placedBracketTargets[symU] = { ...mem.placedBracketTargets[symU], stopLoss: newSlPx };
      log?.info?.(`${logPrefix}_trail_sl_replaced`, { symbol: symU, newSl: newSlPx });
      return { ok: true };
    }

    const prevBk = Number(previousExchangeSlPx);
    const prevOk =
      Number.isFinite(prevBk) &&
      prevBk > 0 &&
      Math.abs(prevBk - newSlPx) / Math.max(newSlPx, 1e-12) > 1e-10;
    if (prevOk && Number.isFinite(markForCheck) && markForCheck > 0) {
      const rbTrig = isLong ? markForCheck <= prevBk : markForCheck >= prevBk;
      if (!rbTrig) {
        const prRb = await executePlaceAttempts(prevBk);
        if (prRb.immediate2021) {
          return { ok: true, localBracketInstalled: true };
        }
        if (prRb.placed) {
          mem.placedBracketTargets[symU] = { ...mem.placedBracketTargets[symU], stopLoss: prevBk };
          log?.warn?.(`${logPrefix}_trail_sl_rollback_previous_restored`, {
            symbol: symU,
            rollbackSl: prevBk,
            failedNewSl: newSlPx,
            lastCode: prNew.lastCode,
            lastMsg: prNew.lastMsg,
          });
          return {
            ok: false,
            code: prNew.lastCode,
            msg: "trail_new_failed_restored_previous_sl",
            rolledBack: true,
            rollbackSl: prevBk,
            localBracketInstalled: false,
          };
        }
      }
    }

    const safetySl = prevOk && Number.isFinite(prevBk) && prevBk > 0 ? prevBk : newSlPx;
    log?.warn?.(`${logPrefix}_trail_sl_place_failed_safety_bracket`, {
      symbol: symU,
      newSlPx,
      safetySl,
      code: prNew.lastCode,
      msg: prNew.lastMsg,
    });
    const qStr = resolveQtyStr();
    const positionSideField = hedgeExtrasR.positionSide || undefined;
    mem.localBrackets[symU] = {
      stopLoss: safetySl,
      takeProfit: Number(tgt.takeProfit) || (isLong ? safetySl * 10 : safetySl * 0.01),
      isLong,
      closeSide: tgt.closeSide,
      qty: qStr || tgt.qty || "0",
      positionSide: positionSideField,
      entryPrice: mem.trailingBySymbol[symU]?.entryPrice ?? 0,
      leverage: mem.trailingBySymbol[symU]?.leverage ?? defaultLeverage,
      strategy: "trailing_sl_safety",
      _installedAt: Date.now(),
    };
    mem.placedBracketTargets[symU] = { ...mem.placedBracketTargets[symU], stopLoss: safetySl };
    return { ok: false, code: prNew.lastCode, msg: prNew.lastMsg || "not_placed", localBracketInstalled: true };
  } catch (e) {
    const code = futuresOrderErrCode(e);
    const msg = e?.cause?.response?.data?.msg ?? e?.response?.data?.msg ?? e?.message ?? null;
    log?.warn?.(`${logPrefix}_trail_replace_sl_failed`, {
      symbol: symU,
      newSlPx,
      code,
      msg,
      error: String(e?.message || e),
    });
    if (!mem.localBrackets[symU]) {
      const qStr = resolveQtyStr();
      const positionSideField = (tgt.hedgeExtras || {}).positionSide || undefined;
      mem.localBrackets[symU] = {
        stopLoss: newSlPx,
        takeProfit: Number(tgt.takeProfit) || (isLong ? newSlPx * 10 : newSlPx * 0.01),
        isLong,
        closeSide: tgt.closeSide,
        qty: qStr || tgt.qty || "0",
        positionSide: positionSideField,
        entryPrice: mem.trailingBySymbol[symU]?.entryPrice ?? 0,
        leverage: mem.trailingBySymbol[symU]?.leverage ?? defaultLeverage,
        strategy: "trailing_sl_safety",
        _installedAt: Date.now(),
      };
      mem.placedBracketTargets[symU] = { ...tgt, stopLoss: newSlPx };
    }
    return { ok: false, code, msg, localBracketInstalled: true };
  }
}

/**
 * @param {object} ctx
 * @param {(...args: any[]) => boolean} ctx.applyTrailingStopBinanceMemory
 */
export async function evalTrailingForSymbolUsdM(ctx) {
  const {
    s,
    markPx,
    trailingStopLoss,
    onTrailingSlAdvance,
    notifyActivity,
    primaryChartSymU,
    mem,
    applyTrailingStopBinanceMemory,
    getOrLoadSymbolMeta,
    signed,
    publicGet,
    defaultLeverage,
    trailSymLock,
    stopTakeFromExchangeOpenOrders,
    replaceCtxBase,
    log,
  } = ctx;

  if (trailSymLock.has(s)) return;
  const trailMode = String(trailingStopLoss?.mode || "SUPERTREND").toUpperCase();
  const stBySym =
    trailingStopLoss?.supertrendBySymbol && typeof trailingStopLoss.supertrendBySymbol === "object"
      ? trailingStopLoss.supertrendBySymbol
      : null;
  const primU = String(primaryChartSymU || "").toUpperCase();
  let stPx = null;
  if (trailMode === "FEE_LADDER") {
    stPx = Number(trailingStopLoss.supertrendPx);
  } else {
    const fromMap = stBySym?.[s];
    if (fromMap != null && Number.isFinite(Number(fromMap)) && Number(fromMap) > 0) {
      stPx = Number(fromMap);
    } else if (primU && s === primU && trailingStopLoss.supertrendPx != null) {
      const v = Number(trailingStopLoss.supertrendPx);
      if (Number.isFinite(v) && v > 0) stPx = v;
    }
  }
  if (trailMode === "SUPERTREND") {
    const advOn = trailingStopLoss?.supertrendUseAdvancedTrail !== false;
    const feeBeOn = trailingStopLoss?.supertrendUseFeeBreakeven !== false;
    if (advOn && (!Number.isFinite(stPx) || stPx <= 0) && !feeBeOn) return;
  }

  trailSymLock.add(s);
  try {
    const m = await getOrLoadSymbolMeta(s);
    const tick = Number(m?.tickSize);
    const pbBefore = mem.placedBracketTargets[s];
    const slPriorToTrailAdvance =
      pbBefore && Number.isFinite(Number(pbBefore.stopLoss)) && Number(pbBefore.stopLoss) > 0
        ? Number(pbBefore.stopLoss)
        : null;
    const advanced = applyTrailingStopBinanceMemory({
      symbol: s,
      markPx,
      trailingOpts: {
        enabled: true,
        mode: trailingStopLoss.mode,
        feeRate: trailingStopLoss.feeRate,
        openFeeRate: trailingStopLoss.openFeeRate,
        closeFeeRate: trailingStopLoss.closeFeeRate,
        feeBeMultiplier: trailingStopLoss.feeBeMultiplier,
        extraScalpingPcts: trailingStopLoss.extraScalpingPcts ?? [],
        maxTrailSteps: trailingStopLoss.maxTrailSteps,
        supertrendPx: trailMode === "FEE_LADDER" ? trailingStopLoss.supertrendPx : stPx,
        bufferRate: trailingStopLoss.bufferRate,
        maintenanceMarginRate: trailingStopLoss.maintenanceMarginRate,
        minSlDistanceFrac: trailingStopLoss.minSlDistanceFrac,
        supertrendUseFeeBreakeven: trailingStopLoss.supertrendUseFeeBreakeven !== false,
        supertrendUseAdvancedTrail: trailingStopLoss.supertrendUseAdvancedTrail !== false,
      },
      trailingBySymbol: mem.trailingBySymbol,
      localBrackets: mem.localBrackets,
      placedBracketTargets: mem.placedBracketTargets,
      tickSize: Number.isFinite(tick) && tick > 0 ? tick : null,
      onTrailingSlAdvance,
      notifyActivity,
    });
    if (!advanced) return;
    const pb = mem.placedBracketTargets[s];
    if (!pb) return;
    const newSlPx = pb.stopLoss;
    if (!Number.isFinite(newSlPx) || newSlPx <= 0) return;

    const trailEntry = mem.trailingBySymbol[s];
    const TRAIL_GRACE_MS = 30_000;
    if (trailEntry?._openedAt && Date.now() - trailEntry._openedAt < TRAIL_GRACE_MS) {
      return;
    }

    if (mem.localBrackets[s]) {
      try {
        notifyActivity?.({
          level: "warn",
          category: "trailing",
          reason: "trail_advanced_local_brackets",
          msg: `${s} trail advanced but exchange brackets are LOCAL (Binance SL/TP will stay empty)`,
          detail: { symbol: s, newSlPx },
        });
      } catch {
        /* ignore */
      }
      return;
    }

    if (!pb.closeSide) {
      try {
        notifyActivity?.({
          level: "warn",
          category: "trailing",
          reason: "trail_advanced_missing_close_side",
          msg: `${s} trail advanced but cannot replace Binance SL (missing closeSide)`,
          detail: { symbol: s, newSlPx },
        });
      } catch {
        /* ignore */
      }
      return;
    }

    const trail = mem.trailingBySymbol[s];
    const tierLabel = trail?.trailTierLabel || `T${Math.max(0, (Number(trail?.trailStep) || 1) - 1)}`;
    const prevSl = slPriorToTrailAdvance ?? pb.stopLoss;

    const rep = await replaceExchangeSlOrderUsdM({
      ...replaceCtxBase,
      symU: s,
      newSlPx,
      markPxHint: markPx,
      previousExchangeSlPx: slPriorToTrailAdvance,
    }).catch((e) => ({
      ok: false,
      code: null,
      msg: String(e?.message || e),
    }));

    if (rep?.ok && rep?.localBracketInstalled) {
      try {
        notifyActivity?.({
          level: "info",
          category: "trailing",
          reason: "trail_sl_breached_local_close",
          msg: `${s} ${tierLabel} — mark crossed trailing SL ${newSlPx}, local bracket for immediate close`,
          detail: { symbol: s, tier: tierLabel, newSlPx, prevSl },
        });
      } catch {
        /* ignore */
      }
    } else if (rep?.ok) {
      replaceCtxBase.clearSlTpOpenOrdersCache?.(s);
      let verifiedSl = null;
      try {
        const oo = await stopTakeFromExchangeOpenOrders(s);
        verifiedSl = oo?.sl != null ? Number(oo.sl) : null;
      } catch {
        /* ignore */
      }
      const slMatch =
        verifiedSl != null &&
        Number.isFinite(verifiedSl) &&
        Math.abs(verifiedSl - newSlPx) / Math.max(newSlPx, 1e-8) < 0.005;
      if (slMatch) {
        try {
          notifyActivity?.({
            level: "info",
            category: "trailing",
            reason: "trail_sl_replace_success",
            msg: `${s} trailing SL → ${tierLabel} SUCCESS · SL ${prevSl != null ? `${prevSl} → ` : ""}${newSlPx} (verified on exchange)`,
            detail: { symbol: s, tier: tierLabel, prevSl, newSlPx, verifiedSl },
          });
        } catch {
          /* ignore */
        }
      } else {
        try {
          notifyActivity?.({
            level: "warn",
            category: "trailing",
            reason: "trail_sl_replace_verify_mismatch",
            msg: `${s} trailing SL → ${tierLabel} placed OK but exchange shows SL=${verifiedSl ?? "EMPTY"} (expected ${newSlPx})`,
            detail: { symbol: s, tier: tierLabel, prevSl, newSlPx, verifiedSl },
          });
        } catch {
          /* ignore */
        }
      }
    } else if (rep?.msg === "skip_would_trigger_precheck") {
      try {
        notifyActivity?.({
          level: "info",
          category: "trailing",
          reason: "trail_sl_replace_skipped_precheck",
          msg: `${s} trailing SL → ${tierLabel} skipped (new SL ${Number(newSlPx).toFixed(8)} would trigger vs mark); exchange SL unchanged`,
          detail: {
            symbol: s,
            tier: tierLabel,
            newSlPx,
            prevSl,
            markPx,
          },
        });
      } catch {
        /* ignore */
      }
    } else if (rep?.rolledBack && rep?.rollbackSl != null) {
      replaceCtxBase.clearSlTpOpenOrdersCache?.(s);
      let verifiedSl = null;
      try {
        const oo = await stopTakeFromExchangeOpenOrders(s);
        verifiedSl = oo?.sl != null ? Number(oo.sl) : null;
      } catch {
        /* ignore */
      }
      const rb = Number(rep.rollbackSl);
      const slMatch =
        verifiedSl != null &&
        Number.isFinite(verifiedSl) &&
        Number.isFinite(rb) &&
        rb > 0 &&
        Math.abs(verifiedSl - rb) / Math.max(rb, 1e-8) < 0.005;
      try {
        notifyActivity?.({
          level: slMatch ? "info" : "warn",
          category: "trailing",
          reason: slMatch ? "trail_sl_rollback_restored_ok" : "trail_sl_rollback_restored_verify_mismatch",
          msg: slMatch
            ? `${s} ${tierLabel} — new SL ${newSlPx} failed to place; prior SL ${rb} restored on exchange (verified)`
            : `${s} ${tierLabel} — new SL failed; rollback to ${rb} requested but exchange shows SL=${verifiedSl ?? "EMPTY"}`,
          detail: {
            symbol: s,
            tier: tierLabel,
            prevSl,
            attemptedNewSl: newSlPx,
            rollbackSl: rb,
            verifiedSl,
            code: rep?.code ?? null,
            msg: rep?.msg ?? null,
          },
        });
      } catch {
        /* ignore */
      }
    } else {
      const safetyNote = rep?.localBracketInstalled ? " (local safety bracket installed)" : "";
      try {
        notifyActivity?.({
          level: "warn",
          category: "trailing",
          reason: "trail_sl_replace_failed",
          msg: `${s} trailing SL → ${tierLabel} FAILED${rep?.code != null ? ` (code ${rep.code})` : ""}${rep?.msg ? `: ${String(rep.msg).slice(0, 120)}` : ""}${safetyNote}`,
          detail: {
            symbol: s,
            tier: tierLabel,
            prevSl,
            newSlPx,
            code: rep?.code ?? null,
            msg: rep?.msg ?? null,
            localBracketInstalled: !!rep?.localBracketInstalled,
          },
        });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  } finally {
    trailSymLock.delete(s);
  }
}
