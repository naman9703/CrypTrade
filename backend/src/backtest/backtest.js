import { computeIndicators } from "../strategy/indicators.js";
import { detectRegime } from "../strategy/regime.js";
import { strategies } from "../strategy/strategies.js";
import { pnlWithFeesSlippage, slTpFromAtr } from "../sim/executionModel.js";

function maxDrawdown(equityCurve) {
  let peak = equityCurve[0] ?? 0;
  let mdd = 0;
  for (const x of equityCurve) {
    if (x > peak) peak = x;
    const dd = peak === 0 ? 0 : (peak - x) / Math.abs(peak);
    if (dd > mdd) mdd = dd;
  }
  return mdd;
}

function simulateStrategy({ candles, strategyKey, feeBps, slippageBps }) {
  const strat = strategies[strategyKey];
  const trades = [];
  let open = null;
  let equity = 0;
  const curve = [0];

  for (let i = 60; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const last = slice[slice.length - 1];
    const indicators = computeIndicators(slice);
    const regime = detectRegime({ candles: slice, indicators });

    // If we have an open trade, check SL/TP using this candle (conservative: SL first).
    if (open) {
      const isLong = open.side === "BUY";
      const hitSL = isLong ? last.low <= open.stopLoss : last.high >= open.stopLoss;
      const hitTP = isLong ? last.high >= open.takeProfit : last.low <= open.takeProfit;
      if (hitSL || hitTP) {
        const exitPrice = hitSL ? open.stopLoss : open.takeProfit;
        const sim = pnlWithFeesSlippage({
          side: open.side,
          entryPx: open.entry,
          exitPx: exitPrice,
          qty: 1,
          feeBps,
          slippageBps,
        });
        const pnl = sim.pnl;
        equity += pnl;
        trades.push({ ...open, exitTs: last.ts, exitPrice, pnl, outcome: pnl > 0 ? "WIN" : "LOSS" });
        open = null;
        curve.push(equity);
      }
    }

    // If no open trade, consider entry
    if (!open) {
      const signal = strat.signal({ candles: slice, indicators, regime });
      if (signal.action === "BUY" || signal.action === "SELL") {
        const rules = slTpFromAtr({ entry: last.close, side: signal.action, atr: indicators.latest.atr_14 });
        open = {
          entryTs: last.ts,
          entry: Number(last.close),
          side: signal.action,
          stopLoss: rules.stopLoss,
          takeProfit: rules.takeProfit,
        };
      }
    }
  }

  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const grossLossAbs = Math.abs(trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLossAbs === 0 ? (grossProfit > 0 ? 999 : 0) : grossProfit / grossLossAbs;
  const wins = trades.filter((t) => t.pnl > 0).length;
  const winRate = trades.length ? wins / trades.length : 0;
  const mdd = maxDrawdown(curve);

  return {
    key: strategyKey,
    name: strat.name,
    trades: trades.length,
    winRate,
    grossProfit,
    grossLossAbs,
    profitFactor,
    netPnl: equity,
    maxDrawdown: mdd,
    feeBps: Number(feeBps || 0),
    slippageBps: Number(slippageBps || 0),
  };
}

export function runBacktest({ candles, feeBps = 10, slippageBps = 3 }) {
  const results = Object.keys(strategies).map((k) =>
    simulateStrategy({ candles, strategyKey: k, feeBps, slippageBps })
  );
  results.sort((a, b) => (b.netPnl - a.netPnl) || (b.profitFactor - a.profitFactor));
  return results;
}

