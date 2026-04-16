/**
 * Shared USD-M futures trailing: cancel SL-only orders and replace STOP after `applyTrailingStopBinanceMemory`.
 * Used by live (and optionally demo) Binance USD-M adapters.
 */

import { usdmBracketPriceStrings } from "./binanceFuturesBracketPrices.js";
import { futuresOrderIs4120 } from "./binanceFuturesSlTpBracket.js";

function futuresOrderErrCode(e) {
  return e?.cause?.response?.data?.code ?? e?.response?.data?.code;
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Best-effort global throttling for trailing SL ops (per-process / per-mem).
 * This reduces burstiness when many symbols advance on the same tick.
 */
async function throttleGlobalTrailingOps(mem, minGapMs) {
  const gap = Math.max(0, Math.floor(Number(minGapMs) || 0));
  if (!mem || gap <= 0) return;
  const now = Date.now();
  const nextAt = Number(mem._trailSlGlobalNextAt) || 0;
  if (nextAt > now) await sleepMs(nextAt - now);
  mem._trailSlGlobalNextAt = Date.now() + gap;
}

/** Compare exchange-reported SL to our target using tick grid when available. */
export function exchangeSlMatchesTargetPrice(verifiedSl, targetSl, tickSize) {
  const v = Number(verifiedSl);
  const t = Number(targetSl);
  if (!Number.isFinite(v) || !Number.isFinite(t) || v <= 0 || t <= 0) return false;
  const tick = Number(tickSize);
  if (Number.isFinite(tick) && tick > 0) {
    return Math.round(v / tick) === Math.round(t / tick);
  }
  return Math.abs(v - t) / Math.max(Math.abs(t), 1e-12) < 1e-7;
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
    /** Optional `(symU, newSlPx, markPxHint, prevSl) => Promise<rep>` — demo uses local `replaceExchangeSlOrder`. */
    replaceSlOnExchange,
  } = ctx;

  const depth = Math.max(0, Math.floor(Number(ctx?._trailQueueDepth) || 0));
  // Per-symbol single-slot queue: when an update is already in-flight for this symbol,
  // keep only the latest markPx and run one more pass after unlock.
  const q = (mem._trailSlQueueBySymbol = mem._trailSlQueueBySymbol || {});
  if (trailSymLock.has(s)) {
    q[s] = { markPx, at: Date.now() };
    return;
  }
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

    const trSnap0 = mem.trailingBySymbol[s];
    const snapTrail = trSnap0
      ? {
          trailStep: Number(trSnap0.trailStep) || 0,
          extremePx: trSnap0.extremePx,
          trailTierLabel: trSnap0.trailTierLabel,
          _trailingActivationLoggedTier: trSnap0._trailingActivationLoggedTier,
        }
      : null;
    const snapPb = pbBefore ? { ...pbBefore } : null;

    const advanceQueue = [];
    const wrapOn = onTrailingSlAdvance ? (evt) => advanceQueue.push(evt) : () => {};

    function flushQueuedAdvances() {
      if (!onTrailingSlAdvance || !advanceQueue.length) return;
      for (const evt of advanceQueue) onTrailingSlAdvance(evt);
      advanceQueue.length = 0;
    }

    function rollbackTrailState() {
      const tr = mem.trailingBySymbol[s];
      if (!tr || !snapTrail) return;
      const confirmed = Math.max(0, Math.floor(Number(tr.confirmedTrailStep) || 0));
      tr.trailStep = Math.max(Math.max(0, Math.floor(Number(snapTrail.trailStep) || 0)), confirmed);
      tr.extremePx = snapTrail.extremePx;
      if (snapTrail.trailTierLabel != null) tr.trailTierLabel = snapTrail.trailTierLabel;
      else delete tr.trailTierLabel;
      if (confirmed > 0) {
        // Safety net: never roll back below the last exchange-verified tier.
        tr.trailTierLabel = `T${Math.max(0, tr.trailStep - 1)}`;
      }
      if (snapTrail._trailingActivationLoggedTier !== undefined) {
        tr._trailingActivationLoggedTier = snapTrail._trailingActivationLoggedTier;
      } else {
        delete tr._trailingActivationLoggedTier;
      }
      if (snapPb) mem.placedBracketTargets[s] = { ...snapPb };
      advanceQueue.length = 0;
    }

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
      onTrailingSlAdvance: wrapOn,
      notifyActivity,
    });
    if (!advanced) return;
    const pb = mem.placedBracketTargets[s];
    if (!pb) return;
    const newSlPx = pb.stopLoss;
    if (!Number.isFinite(newSlPx) || newSlPx <= 0) return;

    // Monotonic trailing safety: never allow a backward tier request (e.g. T4 → T3).
    const trAfter = mem.trailingBySymbol[s];
    const pendingStep = Math.max(0, Math.floor(Number(trAfter?.trailStep) || 0));
    const confirmedStep = Math.max(0, Math.floor(Number(trAfter?.confirmedTrailStep) || 0));
    if (pendingStep <= confirmedStep && confirmedStep > 0) {
      // Restore the confirmed tier locally; skip any downgrade attempt.
      if (trAfter) {
        trAfter.trailStep = confirmedStep;
        trAfter.trailTierLabel = `T${Math.max(0, confirmedStep - 1)}`;
      }
      flushQueuedAdvances();
      return;
    }

    const trailEntry = mem.trailingBySymbol[s];
    const TRAIL_GRACE_MS = 30_000;
    if (trailEntry?._openedAt && Date.now() - trailEntry._openedAt < TRAIL_GRACE_MS) {
      flushQueuedAdvances();
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
      flushQueuedAdvances();
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
      flushQueuedAdvances();
      return;
    }

    const trail = mem.trailingBySymbol[s];
    const tierLabel =
      trail?.trailTierLabel ||
      (Number.isFinite(Number(trail?.trailStep)) && Number(trail.trailStep) >= 1
        ? `T${Math.max(0, Math.floor(Number(trail.trailStep)) - 1)}`
        : "T0");
    const prevSl = slPriorToTrailAdvance ?? pb.stopLoss;

    const doReplace =
      typeof replaceSlOnExchange === "function"
        ? (symU, px, markH, prev) => replaceSlOnExchange(symU, px, markH, prev)
        : (symU, px, markH, prev) =>
            replaceExchangeSlOrderUsdM({
              ...replaceCtxBase,
              symU,
              newSlPx: px,
              markPxHint: markH,
              previousExchangeSlPx: prev,
            });

    if (mem.trailingBySymbol[s]) {
      mem.trailingBySymbol[s].slTrailConfirm = {
        status: "REQUESTED",
        requestedSl: newSlPx,
        exchangeSlBefore: slPriorToTrailAdvance,
        tierLabel,
        at: Date.now(),
      };
    }

    const SETTLE_MS = 320;
    const RETRY_GAP_MS = 280;
    const MAX_ATTEMPTS = 3;
    let lastRep = null;
    let lastVerified = null;
    let verifiedOk = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let prevForReplace = slPriorToTrailAdvance;
      if (attempt > 1) {
        replaceCtxBase?.clearSlTpOpenOrdersCache?.(s);
        try {
          const oo = await stopTakeFromExchangeOpenOrders(s);
          if (oo?.sl != null && Number.isFinite(Number(oo.sl))) prevForReplace = Number(oo.sl);
        } catch {
          /* keep prior */
        }
      }

      await throttleGlobalTrailingOps(mem, 120);
      lastRep = await doReplace(s, newSlPx, markPx, prevForReplace).catch((e) => ({
        ok: false,
        code: null,
        msg: String(e?.message || e),
      }));

      if (lastRep?.msg === "skip_would_trigger_precheck") {
        rollbackTrailState();
        if (mem.trailingBySymbol[s]) {
          mem.trailingBySymbol[s].slTrailConfirm = {
            status: "FAILED",
            reason: "skip_would_trigger_precheck",
            requestedSl: newSlPx,
            attempts: attempt,
            at: Date.now(),
          };
        }
        try {
          notifyActivity?.({
            level: "info",
            category: "trailing",
            reason: "trail_sl_replace_skipped_precheck",
            msg: `${s} trailing SL → ${tierLabel} skipped (new SL ${Number(newSlPx).toFixed(8)} would trigger vs mark); exchange SL unchanged — in-memory trail rolled back`,
            detail: { symbol: s, tier: tierLabel, newSlPx, prevSl, markPx },
          });
        } catch {
          /* ignore */
        }
        return;
      }

      if (!lastRep?.ok && lastRep?.localBracketInstalled) {
        flushQueuedAdvances();
        if (mem.trailingBySymbol[s]) delete mem.trailingBySymbol[s].slTrailConfirm;
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
        return;
      }

      if (lastRep?.rolledBack && lastRep?.rollbackSl != null) {
        rollbackTrailState();
        if (mem.trailingBySymbol[s]) {
          mem.trailingBySymbol[s].slTrailConfirm = {
            status: "FAILED",
            reason: "replace_rolled_back",
            requestedSl: newSlPx,
            rollbackSl: lastRep.rollbackSl,
            code: lastRep?.code ?? null,
            msg: lastRep?.msg ?? null,
            attempts: attempt,
            at: Date.now(),
          };
        }
        replaceCtxBase?.clearSlTpOpenOrdersCache?.(s);
        let verifiedSl = null;
        try {
          const oo = await stopTakeFromExchangeOpenOrders(s);
          verifiedSl = oo?.sl != null ? Number(oo.sl) : null;
        } catch {
          /* ignore */
        }
        const rb = Number(lastRep.rollbackSl);
        const slMatch = exchangeSlMatchesTargetPrice(verifiedSl, rb, tick);
        try {
          notifyActivity?.({
            level: slMatch ? "info" : "warn",
            category: "trailing",
            reason: slMatch ? "trail_sl_rollback_restored_ok" : "trail_sl_rollback_restored_verify_mismatch",
            msg: slMatch
              ? `${s} ${tierLabel} — new SL ${newSlPx} failed to place; prior SL ${rb} restored on exchange (verified); trail state rolled back`
              : `${s} ${tierLabel} — new SL failed; rollback to ${rb} requested but exchange shows SL=${verifiedSl ?? "EMPTY"}; trail state rolled back`,
            detail: {
              symbol: s,
              tier: tierLabel,
              prevSl,
              attemptedNewSl: newSlPx,
              rollbackSl: rb,
              verifiedSl,
              code: lastRep?.code ?? null,
              msg: lastRep?.msg ?? null,
            },
          });
        } catch {
          /* ignore */
        }
        return;
      }

      if (!lastRep?.ok) {
        try {
          notifyActivity?.({
            level: "warn",
            category: "trailing",
            reason: "trail_sl_replace_attempt_failed",
            msg: `${s} trailing SL → ${tierLabel} replace attempt ${attempt}/${MAX_ATTEMPTS} failed${lastRep?.code != null ? ` (code ${lastRep.code})` : ""}${lastRep?.msg ? `: ${String(lastRep.msg).slice(0, 200)}` : ""}`,
            detail: {
              symbol: s,
              tier: tierLabel,
              prevSl: prevForReplace,
              newSlPx,
              attempt,
              maxAttempts: MAX_ATTEMPTS,
              code: lastRep?.code ?? null,
              msg: lastRep?.msg ?? null,
            },
          });
        } catch {
          /* ignore */
        }
        if (attempt < MAX_ATTEMPTS) await sleepMs(RETRY_GAP_MS);
        continue;
      }

      await sleepMs(SETTLE_MS);
      replaceCtxBase?.clearSlTpOpenOrdersCache?.(s);
      try {
        const oo = await stopTakeFromExchangeOpenOrders(s);
        lastVerified = oo?.sl != null ? Number(oo.sl) : null;
      } catch {
        lastVerified = null;
      }

      if (exchangeSlMatchesTargetPrice(lastVerified, newSlPx, tick)) {
        verifiedOk = true;
        break;
      }

      try {
        notifyActivity?.({
          level: "warn",
          category: "trailing",
          reason: "trail_sl_verify_mismatch_retry",
          msg: `${s} trailing SL verify attempt ${attempt}/${MAX_ATTEMPTS}: exchange SL=${lastVerified ?? "EMPTY"} expected≈${newSlPx} (tick ${tick || "—"})`,
          detail: {
            symbol: s,
            tier: tierLabel,
            requestedSl: newSlPx,
            verifiedSl: lastVerified,
            attempt,
            tickSize: tick || null,
          },
        });
      } catch {
        /* ignore */
      }
      if (attempt < MAX_ATTEMPTS) await sleepMs(RETRY_GAP_MS);
    }

    if (verifiedOk) {
      flushQueuedAdvances();
      if (mem.trailingBySymbol[s]) delete mem.trailingBySymbol[s].slTrailConfirm;
      if (mem.trailingBySymbol[s]) {
        const curStep = Math.max(0, Math.floor(Number(mem.trailingBySymbol[s].trailStep) || 0));
        const priorConfirmed = Math.max(0, Math.floor(Number(mem.trailingBySymbol[s].confirmedTrailStep) || 0));
        if (curStep > priorConfirmed) {
          mem.trailingBySymbol[s].confirmedTrailStep = curStep;
          mem.trailingBySymbol[s].confirmedTrailTierLabel = curStep >= 1 ? `T${curStep - 1}` : null;
          mem.trailingBySymbol[s].confirmedAt = Date.now();
        }
      }
      try {
        notifyActivity?.({
          level: "info",
          category: "trailing",
          reason: "trail_sl_replace_success",
          msg: `${s} trailing SL → ${tierLabel} SUCCESS · SL ${prevSl != null ? `${prevSl} → ` : ""}${newSlPx} (verified on exchange)`,
          detail: { symbol: s, tier: tierLabel, prevSl, newSlPx, verifiedSl: lastVerified },
        });
      } catch {
        /* ignore */
      }
      return;
    }

    rollbackTrailState();
    if (mem.trailingBySymbol[s]) {
      mem.trailingBySymbol[s].slTrailConfirm = {
        status: "FAILED",
        reason: lastRep?.ok ? "verify_mismatch_after_retries" : "replace_failed_after_retries",
        requestedSl: newSlPx,
        verifiedSl: lastVerified,
        lastCode: lastRep?.code ?? null,
        lastMsg: lastRep?.msg ?? null,
        attempts: MAX_ATTEMPTS,
        at: Date.now(),
      };
    }
    try {
      notifyActivity?.({
        level: "error",
        category: "trailing",
        reason: "trail_sl_exchange_confirm_failed",
        msg: `${s} trailing SL → ${tierLabel} NOT confirmed after ${MAX_ATTEMPTS} attempts — trail state rolled back to pre-advance (exchange SL=${lastVerified ?? "EMPTY"}, target ${newSlPx})`,
        detail: {
          symbol: s,
          tier: tierLabel,
          prevSl,
          requestedSl: newSlPx,
          verifiedSl: lastVerified,
          lastCode: lastRep?.code ?? null,
          lastMsg: lastRep?.msg ?? null,
          attempts: MAX_ATTEMPTS,
        },
      });
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  } finally {
    trailSymLock.delete(s);
    const pending = q[s];
    // latest-job replacement: if any mark arrived while we were processing, run one more pass.
    // Guard to prevent infinite recursion on pathological callers.
    if (pending && depth < 8) {
      delete q[s];
      const mp = Number(pending.markPx);
      if (Number.isFinite(mp) && mp > 0) {
        try {
          await evalTrailingForSymbolUsdM({ ...ctx, markPx: mp, _trailQueueDepth: depth + 1 });
        } catch {
          /* ignore */
        }
      }
    }
  }
}
