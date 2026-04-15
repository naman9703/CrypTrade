import { roundTo } from "../../lib/math.js";
import { mergeStopWithTrail, clampFeeRate, advanceTrailingStopState, buildTrailLockPrices } from "../../lib/trailingStopLoss.js";
import { computeSupertrendTrailingSlUpdate, feeRateBreakevenPadded, trailStepToTierLabel } from "../../lib/supertrendTrailingSl.js";
import { resolveDefaultPaperFuturesStoreDir } from "../../lib/tradingModePersistence.js";
import { createPaperStore } from "./paperStore.js";

export function createPaperFuturesExchange({ log, name = "paper_futures", baseDir } = {}) {
  const store = createPaperStore({ baseDir: baseDir ?? resolveDefaultPaperFuturesStoreDir() });
  const feeBps = Number(process.env.PAPER_FUTURES_FEE_BPS ?? 4); // 0.04% typical taker-ish
  const slippageBps = Number(process.env.PAPER_FUTURES_SLIPPAGE_BPS ?? 8);
  const feeRate = Math.max(0, feeBps) / 10_000;
  const slipRate = Math.max(0, slippageBps) / 10_000;
  const defaultLeverage = Math.max(1, Math.min(100, Number(process.env.FUTURES_DEFAULT_LEVERAGE || 5)));

  const state = {
    equity: 10_000,
    dailyStartEquity: 10_000,
    dayKey: null,
    positions: [],
    trades: [],
    openOrders: [],
  };

  const snap = store.loadSnapshot();
  if (snap) {
    state.equity = Number(snap.equity ?? state.equity);
    state.dailyStartEquity = Number(snap.dailyStartEquity ?? state.dailyStartEquity);
    state.dayKey = snap.dayKey ?? state.dayKey;
    state.positions = Array.isArray(snap.positions) ? snap.positions : state.positions;
    state.trades = Array.isArray(snap.trades) ? snap.trades : state.trades;
    state.openOrders = Array.isArray(snap.openOrders) ? snap.openOrders : state.openOrders;
  }

  let persistTimer = null;
  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        store.saveSnapshot({
          equity: state.equity,
          dailyStartEquity: state.dailyStartEquity,
          dayKey: state.dayKey,
          positions: state.positions,
          trades: state.trades.slice(-500),
          openOrders: state.openOrders.slice(-200),
        });
      } catch (e) {
        log?.warn?.("paper_futures_persist_failed", { error: String(e?.message || e) });
      }
    }, 250);
  }

  function currentDayKey() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  }

  function rolloverIfNeeded() {
    const k = currentDayKey();
    if (state.dayKey !== k) {
      state.dayKey = k;
      state.dailyStartEquity = state.equity;
    }
  }

  function feeForNotional(notional) {
    const n = Math.abs(Number(notional || 0));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n * feeRate;
  }

  function fillPrice({ side, px }) {
    const p = Number(px);
    if (!Number.isFinite(p) || p <= 0) return p;
    if (side === "BUY") return p * (1 + slipRate);
    return p * (1 - slipRate);
  }

  function getDailyPnlPct() {
    rolloverIfNeeded();
    return state.dailyStartEquity === 0 ? 0 : (state.equity - state.dailyStartEquity) / state.dailyStartEquity;
  }

  function calcUnrealizedPnl(pos, markPx) {
    const px = Number(markPx);
    const entry = Number(pos.entryPrice);
    const qty = Number(pos.qty);
    if (!Number.isFinite(px) || !Number.isFinite(entry) || !Number.isFinite(qty)) return 0;
    const dir = pos.side === "BUY" ? 1 : -1;
    return (px - entry) * qty * dir;
  }

  function emitPaperFuturesCloseActivity(notifyActivity, reason, p, markPx) {
    if (typeof notifyActivity !== "function") return;
    const r = String(reason || "").toUpperCase();
    const px = Number(markPx);
    const pxs = Number.isFinite(px) ? px.toFixed(4) : String(markPx == null ? "" : markPx);
    let label = "Position closed (paper futures)";
    let reasonKey = "paper_futures_close";
    if (r === "STOP" || r === "STOP_LOSS") {
      label = "Stop loss (paper futures)";
      reasonKey = "stop_loss_trigger";
    } else if (r === "TAKE_PROFIT") {
      label = "Take profit (paper futures)";
      reasonKey = "take_profit_trigger";
    } else if (r === "MANUAL_CLOSE" || r === "MANUAL") {
      label = "Manual close (paper futures)";
      reasonKey = "manual_close";
    } else if (r === "TIME_EXIT") {
      label = "Time-based exit (paper futures)";
      reasonKey = "time_exit";
    }
    notifyActivity({
      level: "info",
      msg: `${label} · ${p.symbol} @ ~${pxs}`,
      category: "risk",
      reason: reasonKey,
      symbol: p.symbol,
      detail: { closeReason: reason, markPx },
    });
  }

  function closePositionInternal(posId, markPx, reason = "CLOSE", notifyActivity) {
    const idx = state.positions.findIndex((p) => p.id === posId);
    if (idx < 0) return null;
    const p = state.positions[idx];
    const exitSide = p.side === "BUY" ? "SELL" : "BUY";
    const filled = fillPrice({ side: exitSide, px: markPx });
    const gross = calcUnrealizedPnl(p, filled);
    const notional = Number(filled) * Number(p.qty);
    const exitFee = feeForNotional(notional);
    const openFee = Number(p?.meta?.openFee ?? p?.meta?.fee ?? 0);
    const totalFee = openFee + exitFee;
    const netPnl = roundTo(gross - totalFee, 4);
    state.equity = roundTo(state.equity + gross - exitFee, 2);
    const rU = String(reason || "").toUpperCase();
    const trailStepAtClose = Number(p?.meta?.trailStep) || 0;
    const trailTierAtClose = p?.meta?.trailTierLabel ?? (trailStepAtClose > 0 ? trailStepToTierLabel(trailStepAtClose) : null);
    const exitViaTrailedStop = (rU === "STOP" || rU === "STOP_LOSS") && trailStepAtClose > 0;
    let bracketType = null;
    let reasonNorm = rU;
    if (rU === "STOP" || rU === "STOP_LOSS") {
      bracketType = "SL";
      /** e.g. "TRAILED_STOP_LOSS_T0", "TRAILED_STOP_LOSS_T1" — or plain TRAILED_STOP_LOSS if no tier info */
      reasonNorm = exitViaTrailedStop
        ? trailTierAtClose
          ? `TRAILED_STOP_LOSS_${trailTierAtClose}`
          : "TRAILED_STOP_LOSS"
        : "STOP_LOSS_DEFAULT";
    } else if (rU === "TAKE_PROFIT") {
      bracketType = "TP";
      reasonNorm = "TAKE_PROFIT";
    } else if (rU === "SUPERTREND_EXIT" || rU === "SUPERTREND_FLIP") {
      reasonNorm = rU;
    } else if (rU === "MANUAL_CLOSE" || rU === "MANUAL") {
      reasonNorm = "MANUAL_CLOSE";
    }
    state.positions.splice(idx, 1);
    const t = {
      id: posId,
      ts: new Date().toISOString(),
      type: "CLOSE",
      symbol: p.symbol,
      /** Reduce-only order side (SELL closes long, BUY closes short) — matches Binance futures CLOSE rows. */
      side: exitSide,
      qty: p.qty,
      price: Number(filled),
      entryPrice: p.entryPrice,
      exitPrice: filled,
      stopLoss: p.stopLoss ?? null,
      takeProfit: p.takeProfit ?? null,
      leverage: p.leverage ?? p?.meta?.leverage ?? null,
      pnl: netPnl,
      fee: roundTo(totalFee, 6),
      grossPnl: roundTo(gross, 4),
      strategy: p.strategy,
      reason: reasonNorm,
      meta: {
        ...(p.meta || {}),
        closeSide: exitSide,
        positionSideAtClose: p.side,
        closeReason: reason,
        openFee,
        exitFee,
        totalFee: roundTo(totalFee, 6),
        ...(bracketType ? { bracketType } : {}),
        exitViaTrailedStop,
        trailStepAtClose,
        trailTierAtClose,
        ...(rU === "SUPERTREND_EXIT" || rU === "SUPERTREND_FLIP" ? { supertrendSignalClose: true } : {}),
      },
    };
    state.trades.push(t);
    persistSoon();
    emitPaperFuturesCloseActivity(notifyActivity, reason, p, markPx);
    return t;
  }

  function reconcileOrders({ markPxBySymbol, trailingStopLoss, onTrailingSlAdvance, notifyActivity } = {}) {
    if (!state.openOrders.length) return;
    const remaining = [];
    for (const o of state.openOrders) {
      const px = Number(markPxBySymbol?.[o.symbol] ?? o.lastPx ?? 0);
      if (!px) {
        remaining.push(o);
        continue;
      }

      if (o.type === "SL") {
        const pos = state.positions.find((p) => p.id === o.posId);
        if (pos?.meta?.autoTradeTrailing && trailingStopLoss?.enabled) {
          const entryPx = Number(pos.entryPrice);
          const isLong = pos.side === "BUY";
          const prevSl = Number(o.stopPx);
          const lev = Number(pos.leverage ?? pos.meta?.leverage ?? defaultLeverage);
          const feeR = clampFeeRate(trailingStopLoss.feeRate);
          const buf = Number.isFinite(Number(trailingStopLoss.bufferRate)) ? Number(trailingStopLoss.bufferRate) : 0.0005;
          const mm = Number.isFinite(Number(trailingStopLoss.maintenanceMarginRate))
            ? Number(trailingStopLoss.maintenanceMarginRate)
            : 0.005;
          const minDist =
            trailingStopLoss.minSlDistanceFrac != null &&
            Number.isFinite(Number(trailingStopLoss.minSlDistanceFrac))
              ? Number(trailingStopLoss.minSlDistanceFrac)
              : 0.002;
          const mode =
            String(trailingStopLoss.mode || "SUPERTREND").toUpperCase() === "FEE_LADDER" ? "FEE_LADDER" : "SUPERTREND";

          if (Number.isFinite(prevSl) && prevSl > 0) {
            let merged = null;
            let trailStatus = "OK";
            let stPx = NaN;
            let trailKind = "supertrend_trailing_sl";

            if (mode === "FEE_LADDER") {
              const feeBeMultiplierFL = trailingStopLoss.feeBeMultiplier != null ? Number(trailingStopLoss.feeBeMultiplier) : undefined;
              const openRFL = trailingStopLoss.openFeeRate != null ? Number(trailingStopLoss.openFeeRate) : null;
              const closeRFL = trailingStopLoss.closeFeeRate != null ? Number(trailingStopLoss.closeFeeRate) : null;
              const rtRateFL = openRFL != null && closeRFL != null ? openRFL + closeRFL : null;
              const adv = advanceTrailingStopState({
                entryPx,
                isLong,
                trailStep: pos.meta.trailStep,
                extremePx: pos.meta.extremePx,
                markPx: px,
                feeRate: feeR,
                roundTripFeeRate: rtRateFL ?? undefined,
                feeBeMultiplier: feeBeMultiplierFL,
                extraScalpingPctsOfEntry: trailingStopLoss.extraScalpingPcts ?? [],
              });
              pos.meta.trailStep = adv.trailStep;
              pos.meta.extremePx = adv.extremePx;
              if (adv.advanced && adv.proposedSl != null) {
                pos.meta.trailTierLabel = adv.tierLabel;
                merged = mergeStopWithTrail({ isLong, currentStopPx: prevSl, trailSlPx: adv.proposedSl });
                trailKind = "fee_ladder_trailing_sl";
              }
            } else {
              /**
               * Per-symbol ST price: prefer `supertrendBySymbol[pos.symbol]` (set for each open
               * futures position by bot.js) over the primary-symbol fallback `supertrendPx`.
               * Without this, multi-coin positions (XRPUSDT, ETHUSDT, etc.) would trail using the
               * primary bot symbol's Supertrend line — wrong price, wrong direction.
               */
              const stBySymMap = trailingStopLoss.supertrendBySymbol;
              const stFromMap =
                stBySymMap && typeof stBySymMap === "object"
                  ? Number(stBySymMap[pos.symbol] ?? stBySymMap[pos.symbol?.toUpperCase()])
                  : NaN;
              const stFallback =
                trailingStopLoss.supertrendPx != null ? Number(trailingStopLoss.supertrendPx) : NaN;
              stPx = Number.isFinite(stFromMap) && stFromMap > 0 ? stFromMap : stFallback;

              const useAdv = trailingStopLoss.supertrendUseAdvancedTrail !== false;
              const useFeeBeTrail = trailingStopLoss.supertrendUseFeeBreakeven !== false;
              const tieredStMode = useFeeBeTrail && useAdv;
              const hasValidStPx = Number.isFinite(stPx) && stPx > 0;
              /**
               * Degrade gracefully when ST price is unavailable: if fee-breakeven trail is enabled,
               * still ratchet SL to breakeven once activation is crossed (don't silently skip).
               * Previously the code did nothing here, so a momentary ST compute failure would
               * prevent trailing even after activation was already reached.
               */
              const effectiveUseAdv = useAdv && hasValidStPx;
              const stForCompute = effectiveUseAdv ? stPx : null;

              if (!effectiveUseAdv && !useFeeBeTrail) {
                /* neither ST nor fee-BE available — nothing to do */
              } else {
                const feeBeMultiplier = trailingStopLoss.feeBeMultiplier != null ? Number(trailingStopLoss.feeBeMultiplier) : undefined;
                const openRST = trailingStopLoss.openFeeRate != null ? Number(trailingStopLoss.openFeeRate) : null;
                const closeRST = trailingStopLoss.closeFeeRate != null ? Number(trailingStopLoss.closeFeeRate) : null;
                const rtRateST = openRST != null && closeRST != null ? openRST + closeRST : 2 * feeR;
                const feeBe = feeRateBreakevenPadded(rtRateST, feeBeMultiplier);
                const stLevels = tieredStMode
                  ? buildTrailLockPrices({
                      entryPx,
                      isLong,
                      feeRate: feeR,
                      roundTripFeeRate: rtRateST,
                      feeBeMultiplier,
                      extraScalpingPctsOfEntry: trailingStopLoss.extraScalpingPcts ?? [],
                    })
                  : [];
                const stepNow = Math.max(0, Math.floor(Number(pos.meta.trailStep) || 0));
                const ext0 = Number.isFinite(Number(pos.meta.extremePx)) ? Number(pos.meta.extremePx) : px;
                const hwm = isLong ? Math.max(ext0, px) : Math.min(ext0, px);
                pos.meta.extremePx = hwm;
                const nextLevel = stLevels.length ? stLevels[Math.min(stepNow, stLevels.length - 1)] : null;
                const activationTierPx = nextLevel?.lockPx != null ? Number(nextLevel.lockPx) : null;
                const crossedTier =
                  activationTierPx == null ? true : isLong ? hwm >= activationTierPx : hwm <= activationTierPx;
                if (!crossedTier) {
                  // Keep existing SL unchanged; hit-check still runs below on this tick.
                } else {
                const pxForCompute = activationTierPx == null ? px : (isLong ? Math.max(px, activationTierPx) : Math.min(px, activationTierPx));
                const bePx = useFeeBeTrail
                  ? isLong
                    ? entryPx * (1 + feeBe)
                    : entryPx * (1 - feeBe)
                  : entryPx;
                const r = computeSupertrendTrailingSlUpdate({
                  entryPrice: entryPx,
                  currentPrice: pxForCompute,
                  supertrend: stForCompute,
                  previousSl: prevSl,
                  isLong,
                  leverage: lev,
                  feeRate: feeBe,
                  bufferRate: buf,
                  maintenanceMarginRate: mm,
                  minSlDistanceFrac: minDist,
                  useFeeBreakeven: useFeeBeTrail,
                  useAdvancedTrail: effectiveUseAdv,
                  activationPrice: activationTierPx ?? undefined,
                  breakevenPrice: bePx,
                });
                if (
                  r.status !== "REJECT_TRADE" &&
                  r.status !== "INVALID" &&
                  r.status !== "NO_SUPERTREND" &&
                  r.status !== "NO_TRAIL"
                ) {
                  merged = mergeStopWithTrail({ isLong, currentStopPx: prevSl, trailSlPx: r.newSl });
                  trailStatus = r.status;
                }
                }
              }
            }

            if (merged != null && merged !== prevSl) {
              const nextSl = roundTo(merged, 8);
              if (nextSl !== prevSl) {
                if (mode === "SUPERTREND") {
                  pos.meta.trailStep = (Number(pos.meta.trailStep) || 0) + 1;
                  /** T0 = first advance (fee-BE), T1 = second, etc. */
                  pos.meta.trailTierLabel = trailStepToTierLabel(pos.meta.trailStep);
                  pos.meta.extremePx = isLong
                    ? Math.max(Number(pos.meta.extremePx) || px, px)
                    : Math.min(Number(pos.meta.extremePx) || px, px);
                }
                o.stopPx = nextSl;
                pos.stopLoss = nextSl;
                const feeBeMultiplier2 = trailingStopLoss.feeBeMultiplier != null ? Number(trailingStopLoss.feeBeMultiplier) : undefined;
                const openREvt = trailingStopLoss.openFeeRate != null ? Number(trailingStopLoss.openFeeRate) : null;
                const closeREvt = trailingStopLoss.closeFeeRate != null ? Number(trailingStopLoss.closeFeeRate) : null;
                const rtEvt = openREvt != null && closeREvt != null ? openREvt + closeREvt : 2 * feeR;
                const feeBeEvt = feeRateBreakevenPadded(rtEvt, feeBeMultiplier2);
                const breakeven = isLong ? entryPx * (1 + feeBeEvt) : entryPx * (1 - feeBeEvt);
                const activation = isLong ? entryPx * (1 + feeBeEvt + buf) : entryPx * (1 - feeBeEvt - buf);
                onTrailingSlAdvance?.({
                  symbol: pos.symbol,
                  venue: "FUTURES",
                  side: pos.side,
                  prevStopLoss: prevSl,
                  newStopLoss: nextSl,
                  trailStep: pos.meta.trailStep,
                  tierLabel: pos.meta.trailTierLabel,
                  maxTrailSteps: trailingStopLoss.maxTrailSteps ?? 1,
                  entryPrice: entryPx,
                  isLong,
                  supertrendPx: Number.isFinite(stPx) && stPx > 0 ? stPx : null,
                  trailStatus,
                  breakeven,
                  activationPrice: activation,
                  leverage: lev,
                  bufferRate: buf,
                  maintenanceMarginRate: mm,
                  kind: trailKind,
                  trailingMode: mode,
                  source: "paper_futures",
                });
              }
            }
          }
        }
      }

      const hit =
        (o.type === "SL" && ((o.side === "SELL" && px <= o.stopPx) || (o.side === "BUY" && px >= o.stopPx))) ||
        (o.type === "TP" && ((o.side === "SELL" && px >= o.stopPx) || (o.side === "BUY" && px <= o.stopPx)));
      if (hit) {
        closePositionInternal(o.posId, px, o.type === "SL" ? "STOP" : "TAKE_PROFIT", notifyActivity);
      } else {
        remaining.push({ ...o, lastPx: px });
      }
    }
    state.openOrders = remaining;
  }

  return {
    name,
    supportsAutoTrading: true,
    storeInfo: { dir: store.dir, snapshotPath: store.snapshotPath, tradesPath: store.tradesPath },
    async getAccount() {
      rolloverIfNeeded();
      return {
        equity: state.equity,
        freeBalance: state.equity, // in this simplified sim, equity is usable margin
        dailyStartEquity: state.dailyStartEquity,
        dailyPnlPct: getDailyPnlPct(),
        leverage: defaultLeverage,
      };
    },
    async getPositions() {
      return state.positions.map((p) => ({
        ...p,
        venue: p.venue || "FUTURES",
        syncSource: p.syncSource || "paper_local",
        trailTierLabel: p.meta?.trailTierLabel ?? null,
      }));
    },
    async getTrades() {
      return state.trades.slice(-200);
    },
    async placeOrder({ symbol, side, qty, price, stopLoss, takeProfit, strategy, meta }) {
      rolloverIfNeeded();
      const leverage = Math.max(1, Math.min(100, Number(meta?.futuresLeverage || meta?.leverage || defaultLeverage)));
      const id = `pfut_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const markPx = Number(price);
      const filledPrice = fillPrice({ side, px: markPx });
      const notional = Number(filledPrice) * Number(qty);
      const fee = feeForNotional(notional);
      // Futures: we don't reserve margin precisely; we just apply fees now and PnL on close.
      state.equity = roundTo(state.equity - fee, 2);

      const pos = {
        id,
        venue: "FUTURES",
        syncSource: "paper_local",
        symbol,
        side,
        qty: Number(qty),
        entryPrice: Number(filledPrice),
        stopLoss: Number(stopLoss),
        takeProfit: Number(takeProfit),
        leverage,
        openedAt: new Date().toISOString(),
        strategy,
        meta: {
          ...(meta || {}),
          leverage,
          openFee: fee,
          fee,
          ...(meta?.autoTradeTrailing
            ? { trailStep: 0, extremePx: Number(filledPrice), autoTradeTrailing: true }
            : {}),
        },
      };
      state.positions.push(pos);
      state.trades.push({
        id,
        ts: new Date().toISOString(),
        type: "OPEN",
        symbol,
        side,
        qty: Number(qty),
        price: Number(filledPrice),
        stopLoss: Number(stopLoss),
        takeProfit: Number(takeProfit),
        strategy,
        fee: roundTo(fee, 6),
        meta: { ...(meta || {}), leverage, openFee: fee, fee },
      });

      // Attach synthetic bracket orders
      state.openOrders.push({ posId: id, symbol, type: "SL", side: side === "BUY" ? "SELL" : "BUY", stopPx: Number(stopLoss) });
      state.openOrders.push({ posId: id, symbol, type: "TP", side: side === "BUY" ? "SELL" : "BUY", stopPx: Number(takeProfit) });

      persistSoon();
      return {
        id,
        filledPrice: Number(filledPrice),
        leverage,
        stopLoss: Number(stopLoss),
        takeProfit: Number(takeProfit),
      };
    },
    async markToMarket({ symbol, price, markPxBySymbol, trailingStopLoss, onTrailingSlAdvance, notifyActivity } = {}) {
      const pxMap = { ...(markPxBySymbol || {}) };
      if (symbol && price && Number.isFinite(Number(price))) pxMap[symbol] = Number(price);
      reconcileOrders({ markPxBySymbol: pxMap, trailingStopLoss, onTrailingSlAdvance, notifyActivity });
    },
    async closePosition({ id, price, reason = "MANUAL_CLOSE", notifyActivity } = {}) {
      rolloverIfNeeded();
      const posRow = state.positions.find((p) => p.id === id);
      let px = Number(price);
      if (!Number.isFinite(px) || px <= 0) {
        const ep = Number(posRow?.entryPrice);
        if (Number.isFinite(ep) && ep > 0) px = ep;
      }
      if (!Number.isFinite(px) || px <= 0) return { ok: false, error: "bad_price" };
      const t = closePositionInternal(id, px, reason, notifyActivity);
      if (!t) return { ok: false, error: "not_found" };
      state.openOrders = state.openOrders.filter((o) => o.posId !== id);
      persistSoon();
      return { ok: true, pnl: t.pnl };
    },
    async getSymbolOrderConstraints(arg) {
      const sym =
        typeof arg === "string"
          ? String(arg || "").toUpperCase()
          : String(arg?.symbol || "").toUpperCase();
      return {
        ok: true,
        symbol: sym || "—",
        venue: "FUTURES",
        minNotional: 5,
        quoteAsset: "USDT",
        synthetic: true,
        rule: "Paper futures sim — no live Binance exchangeInfo",
      };
    },
    async close() {
      // no-op
    },
    getStatus() {
      return { udf: { ok: true, syncMode: "sim", error: null } };
    },
    /**
     * Recovery pass after bot restart: reconstruct extremePx for open trailing positions
     * that have never been trailed (trailStep === 0) by scanning historical OHLCV candles
     * for the true high (LONG) or low (SHORT) since entry.
     *
     * Call once per symbol before the first markToMarket so the FEE_LADDER mode
     * correctly skips tiers that were already crossed during downtime, and
     * so the SUPERTREND mode starts from the correct extreme.
     *
     * @param {Record<string, Array<{time?: number; high?: number; low?: number; close?: number}>>} candlesBySymbol
     */
    recoverTrailingExtremeFromCandles(candlesBySymbol = {}) {
      let changed = false;
      for (const pos of state.positions) {
        if (!pos.meta?.autoTradeTrailing) continue;
        // Already advanced — extremePx is being tracked live; only recover cold positions
        if ((pos.meta.trailStep ?? 0) > 0) continue;
        const sym = String(pos.symbol || "").toUpperCase();
        const bars = candlesBySymbol[sym];
        if (!Array.isArray(bars) || !bars.length) continue;
        const isLong = pos.side === "BUY";
        // Filter candles that opened at or after the position's entry (with 2-min grace)
        const entryMs =
          pos.meta?.entryTime != null
            ? Number(pos.meta.entryTime)
            : pos.openedAt != null
              ? new Date(String(pos.openedAt)).getTime()
              : 0;
        const entryTimeSec = entryMs > 0 ? Math.floor(entryMs / 1000) : 0;
        const barsAfterEntry =
          entryTimeSec > 0
            ? bars.filter((b) => Number(b.time ?? 0) >= entryTimeSec - 120)
            : bars;
        if (!barsAfterEntry.length) continue;
        let extremePx;
        if (isLong) {
          extremePx = barsAfterEntry.reduce(
            (mx, b) => Math.max(mx, Number(b.high) || Number(b.close) || 0),
            0,
          );
        } else {
          extremePx = barsAfterEntry.reduce(
            (mn, b) => Math.min(mn, Number(b.low) || Number(b.close) || Infinity),
            Infinity,
          );
        }
        if (!Number.isFinite(extremePx) || extremePx <= 0 || extremePx === Infinity) continue;
        const currentExtreme = Number.isFinite(Number(pos.meta.extremePx))
          ? Number(pos.meta.extremePx)
          : Number(pos.entryPrice ?? 0);
        if (isLong && extremePx > currentExtreme) {
          pos.meta.extremePx = extremePx;
          changed = true;
          log?.debug?.("trail_extreme_recovered", { symbol: sym, side: "LONG", extremePx, prevExtreme: currentExtreme });
        } else if (!isLong && extremePx < currentExtreme) {
          pos.meta.extremePx = extremePx;
          changed = true;
          log?.debug?.("trail_extreme_recovered", { symbol: sym, side: "SHORT", extremePx, prevExtreme: currentExtreme });
        }
      }
      if (changed) persistSoon();
    },
  };
}

