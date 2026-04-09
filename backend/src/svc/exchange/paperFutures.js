import { roundTo } from "../../lib/math.js";
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

  function closePositionInternal(posId, markPx, reason = "CLOSE") {
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
    state.positions.splice(idx, 1);
    const t = {
      id: posId,
      ts: new Date().toISOString(),
      type: "CLOSE",
      symbol: p.symbol,
      side: p.side,
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
      meta: { ...(p.meta || {}), closeReason: reason, openFee, exitFee, totalFee: roundTo(totalFee, 6) },
    };
    state.trades.push(t);
    persistSoon();
    return t;
  }

  function reconcileOrders({ markPxBySymbol }) {
    if (!state.openOrders.length) return;
    const remaining = [];
    for (const o of state.openOrders) {
      const px = Number(markPxBySymbol?.[o.symbol] ?? o.lastPx ?? 0);
      if (!px) {
        remaining.push(o);
        continue;
      }

      // Trailing stop logic for SL orders
      if (o.type === "SL") {
        const pos = state.positions.find((p) => p.id === o.posId);
        if (pos) {
          const entryPx = Number(pos.entryPrice);
          const origSlDist = Math.abs(entryPx - o.stopPx);
          const isLong = o.side === "SELL";
          const pnlPerUnit = isLong ? px - entryPx : entryPx - px;

          if (origSlDist > 0) {
            // After 1R: move SL to breakeven + 10% buffer
            if (pnlPerUnit >= origSlDist) {
              const beSL = isLong
                ? entryPx + origSlDist * 0.1
                : entryPx - origSlDist * 0.1;
              if (isLong ? beSL > o.stopPx : beSL < o.stopPx) o.stopPx = beSL;
            }
            // After 1.5R: trail at 0.5R behind price
            if (pnlPerUnit >= origSlDist * 1.5) {
              const trail = origSlDist * 0.5;
              const trSL = isLong ? px - trail : px + trail;
              if (isLong ? trSL > o.stopPx : trSL < o.stopPx) o.stopPx = trSL;
            }
          }
        }
      }

      const hit =
        (o.type === "SL" && ((o.side === "SELL" && px <= o.stopPx) || (o.side === "BUY" && px >= o.stopPx))) ||
        (o.type === "TP" && ((o.side === "SELL" && px >= o.stopPx) || (o.side === "BUY" && px <= o.stopPx)));
      if (hit) {
        closePositionInternal(o.posId, px, o.type === "SL" ? "STOP" : "TAKE_PROFIT");
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
        meta: { ...(meta || {}), leverage, openFee: fee, fee },
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
      return { id, filledPrice: Number(filledPrice), leverage };
    },
    async markToMarket({ symbol, price, markPxBySymbol } = {}) {
      const pxMap = { ...(markPxBySymbol || {}) };
      if (symbol && price && Number.isFinite(Number(price))) pxMap[symbol] = Number(price);
      reconcileOrders({ markPxBySymbol: pxMap });
    },
    async closePosition({ id, price, reason = "MANUAL_CLOSE" }) {
      rolloverIfNeeded();
      const posRow = state.positions.find((p) => p.id === id);
      let px = Number(price);
      if (!Number.isFinite(px) || px <= 0) {
        const ep = Number(posRow?.entryPrice);
        if (Number.isFinite(ep) && ep > 0) px = ep;
      }
      if (!Number.isFinite(px) || px <= 0) return { ok: false, error: "bad_price" };
      const t = closePositionInternal(id, px, reason);
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
  };
}

