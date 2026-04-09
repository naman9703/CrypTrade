import { roundTo } from "../../lib/math.js";
import { resolveDefaultPaperStoreDir } from "../../lib/tradingModePersistence.js";
import { createPaperStore } from "./paperStore.js";

export function createPaperExchange({ log, name = "paper", baseDir } = {}) {
  const store = createPaperStore({ baseDir: baseDir ?? resolveDefaultPaperStoreDir() });
  const feeBps = Number(process.env.PAPER_FEE_BPS ?? 10); // 0.10%
  const slippageBps = Number(process.env.PAPER_SLIPPAGE_BPS ?? 8); // 0.08%
  const feeRate = Math.max(0, feeBps) / 10_000;
  const slipRate = Math.max(0, slippageBps) / 10_000;

  const state = {
    equity: 10_000,
    dailyStartEquity: 10_000,
    dayKey: null,
    positions: [],
    trades: [],
  };

  // Load persisted state (best-effort)
  const snap = store.loadSnapshot();
  if (snap) {
    state.equity = Number(snap.equity ?? state.equity);
    state.dailyStartEquity = Number(snap.dailyStartEquity ?? state.dailyStartEquity);
    state.dayKey = snap.dayKey ?? state.dayKey;
    state.positions = Array.isArray(snap.positions) ? snap.positions : state.positions;
    state.trades = Array.isArray(snap.trades) ? snap.trades : state.trades;
    log.info("paper_loaded_snapshot", { snapshotPath: store.snapshotPath, positions: state.positions.length });
  } else {
    log.info("paper_no_snapshot", { snapshotPath: store.snapshotPath });
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
        });
      } catch (e) {
        log.warn("paper_persist_failed", { error: String(e?.message || e) });
      }
    }, 250);
  }

  function currentDayKey() {
    const d = new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
      d.getUTCDate()
    ).padStart(2, "0")}`;
  }

  function rolloverIfNeeded() {
    const k = currentDayKey();
    if (state.dayKey !== k) {
      state.dayKey = k;
      state.dailyStartEquity = state.equity;
    }
  }

  function getDailyPnlPct() {
    rolloverIfNeeded();
    return state.dailyStartEquity === 0 ? 0 : (state.equity - state.dailyStartEquity) / state.dailyStartEquity;
  }

  function fillPrice({ side, px }) {
    // Slippage against the trader.
    const p = Number(px);
    if (!Number.isFinite(p) || p <= 0) return p;
    if (side === "BUY") return p * (1 + slipRate);
    return p * (1 - slipRate);
  }

  function feeForNotional(notional) {
    const n = Math.abs(Number(notional || 0));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n * feeRate;
  }

  function resetState() {
    state.equity = 10_000;
    state.dailyStartEquity = 10_000;
    state.dayKey = null;
    state.positions = [];
    state.trades = [];
    persistSoon();
  }

  return {
    name,
    storeInfo: { dir: store.dir, snapshotPath: store.snapshotPath, tradesPath: store.tradesPath },
    async getAccount() {
      rolloverIfNeeded();
      return {
        equity: state.equity,
        dailyStartEquity: state.dailyStartEquity,
        dailyPnlPct: getDailyPnlPct(),
      };
    },
    async getPositions() {
      return state.positions.slice();
    },
    async getTrades() {
      return state.trades.slice(-200);
    },
    async placeOrder({ symbol, side, qty, price, stopLoss, takeProfit, strategy, meta }) {
      // Immediate fill with fee + slippage (market simulation)
      rolloverIfNeeded();
      const id = `paper_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const markPx = Number(price);
      const filledPrice = fillPrice({ side, px: markPx });
      const entryNotional = filledPrice * Number(qty);
      const entryFee = feeForNotional(entryNotional);
      state.equity = roundTo(state.equity - entryFee, 2);
      const position = {
        id,
        symbol,
        side,
        qty: Number(qty),
        entryPrice: filledPrice,
        stopLoss: stopLoss ?? null,
        originalStopLoss: stopLoss ?? null,
        takeProfit: takeProfit ?? null,
        openedAt: new Date().toISOString(),
        strategy,
        meta: { ...(meta || {}), feeBps, slippageBps, entryFee },
      };
      state.positions.push(position);

      const tradeRow = {
        id,
        ts: new Date().toISOString(),
        symbol,
        side,
        qty: Number(qty),
        price: filledPrice,
        type: "OPEN",
        strategy,
        stopLoss: stopLoss ?? null,
        takeProfit: takeProfit ?? null,
        fee: roundTo(entryFee, 6),
        meta: { ...(meta || {}), feeBps, slippageBps, entryFee },
      };
      state.trades.push(tradeRow);
      store.appendTradeCsv(tradeRow);
      persistSoon();

      log.info("paper_order_filled", { id, symbol, side, qty: Number(qty), price: filledPrice, strategy });
      return { id, filledPrice };
    },
    async markToMarket({ symbol, price }) {
      rolloverIfNeeded();
      const px = Number(price);
      const stillOpen = [];
      for (const p of state.positions) {
        if (p.symbol !== symbol) {
          stillOpen.push(p);
          continue;
        }
        const isLong = p.side === "BUY";
        const entryPx = Number(p.entryPrice);
        const origSL = Number(p.originalStopLoss ?? p.stopLoss);
        const origSlDist = Math.abs(entryPx - origSL);

        // --- Trailing stop ---
        if (p.stopLoss != null && origSlDist > 0) {
          const pnlPerUnit = isLong ? px - entryPx : entryPx - px;
          // After 1R: move SL to breakeven + 10% buffer
          if (pnlPerUnit >= origSlDist) {
            const beSL = isLong
              ? entryPx + origSlDist * 0.1
              : entryPx - origSlDist * 0.1;
            if (isLong ? beSL > p.stopLoss : beSL < p.stopLoss) p.stopLoss = beSL;
          }
          // After 1.5R: trail at 0.5R behind price
          if (pnlPerUnit >= origSlDist * 1.5) {
            const trail = origSlDist * 0.5;
            const trSL = isLong ? px - trail : px + trail;
            if (isLong ? trSL > p.stopLoss : trSL < p.stopLoss) p.stopLoss = trSL;
          }
        }

        const hitSL = p.stopLoss != null && (isLong ? px <= p.stopLoss : px >= p.stopLoss);
        const hitTP = p.takeProfit != null && (isLong ? px >= p.takeProfit : px <= p.takeProfit);

        if (!hitSL && !hitTP) {
          stillOpen.push(p);
          continue;
        }

        const exitReason = hitSL ? "STOP_LOSS" : "TAKE_PROFIT";
        const exitSide = isLong ? "SELL" : "BUY";
        const exitFill = fillPrice({ side: exitSide, px });
        const entryFill = Number(p.entryPrice);
        const gross = isLong ? (exitFill - entryFill) * p.qty : (entryFill - exitFill) * p.qty;
        const exitFee = feeForNotional(exitFill * p.qty);
        const entryFee = Number(p?.meta?.entryFee || 0);
        const pnl = gross - entryFee - exitFee;
        state.equity = roundTo(state.equity + gross - exitFee, 2);
        const totalFee = roundTo(entryFee + exitFee, 6);
        const tradeRow = {
          id: p.id,
          ts: new Date().toISOString(),
          symbol: p.symbol,
          side: exitSide,
          qty: p.qty,
          price: exitFill,
          stopLoss: p.stopLoss ?? null,
          takeProfit: p.takeProfit ?? null,
          type: "CLOSE",
          reason: exitReason,
          pnl,
          fee: totalFee,
          grossPnl: roundTo(gross, 4),
          strategy: p.strategy,
          meta: { ...(p.meta || {}), exitFee, totalFee, markPx: px },
        };
        state.trades.push(tradeRow);
        store.appendTradeCsv(tradeRow);
        persistSoon();
        log.info("paper_position_closed", { id: p.id, symbol: p.symbol, reason: exitReason, pnl });
      }
      state.positions = stillOpen;
      persistSoon();
    },
    async closePosition({ id, price, reason = "MANUAL_CLOSE" }) {
      rolloverIfNeeded();
      const px = Number(price);
      const idx = state.positions.findIndex((p) => p.id === id);
      if (idx === -1) return { ok: false, error: "not_found" };
      const p = state.positions[idx];
      state.positions.splice(idx, 1);

      const isLong = p.side === "BUY";
      const exitSide = isLong ? "SELL" : "BUY";
      const exitFill = fillPrice({ side: exitSide, px });
      const entryFill = Number(p.entryPrice);
      const gross = isLong ? (exitFill - entryFill) * p.qty : (entryFill - exitFill) * p.qty;
      const exitFee = feeForNotional(exitFill * p.qty);
      const entryFee = Number(p?.meta?.entryFee || 0);
      const pnl = gross - entryFee - exitFee;
      state.equity = roundTo(state.equity + gross - exitFee, 2);
      const totalFee = roundTo(entryFee + exitFee, 6);
      const tradeRow = {
        id: p.id,
        ts: new Date().toISOString(),
        symbol: p.symbol,
        side: exitSide,
        qty: p.qty,
        price: exitFill,
        stopLoss: p.stopLoss ?? null,
        takeProfit: p.takeProfit ?? null,
        type: "CLOSE",
        reason,
        pnl,
        fee: totalFee,
        grossPnl: roundTo(gross, 4),
        strategy: p.strategy,
        meta: { ...(p.meta || {}), exitFee, totalFee, markPx: px },
      };
      state.trades.push(tradeRow);
      store.appendTradeCsv(tradeRow);
      persistSoon();
      log.info("paper_position_closed", { id: p.id, symbol: p.symbol, reason, pnl });
      return { ok: true, pnl };
    },
    async getClosedTradesSince(n) {
      return state.trades.slice(n).filter((t) => t.type === "CLOSE");
    },
    async getSymbolOrderConstraints(arg) {
      const sym =
        typeof arg === "string"
          ? String(arg || "").toUpperCase()
          : String(arg?.symbol || "").toUpperCase();
      return {
        ok: true,
        symbol: sym || "—",
        venue: "SPOT",
        minNotional: 5,
        quoteAsset: "USDT",
        synthetic: true,
        rule: "Paper sim — no live Binance exchangeInfo",
      };
    },
    async reset({ confirm }) {
      if (confirm !== true) return { ok: false, error: "confirm_required" };
      store.resetFiles();
      resetState();
      log.warn("paper_reset", { dir: store.dir });
      return { ok: true };
    },
  };
}

