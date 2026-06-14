import { describe, expect, it } from "vitest";
import { avgTradePriceRr, computeTradePriceRr } from "./backtestTradeRr";
import type { BacktestTrade } from "../types/backtest";

function trade(partial: Partial<BacktestTrade>): BacktestTrade {
  return {
    tradeNumber: 1,
    direction: "BUY",
    entryTs: "",
    exitTs: "",
    entryPrice: 100,
    exitPrice: 102,
    qty: 1,
    slPrice: 99,
    tpPrice: null,
    exitReason: "tp",
    grossPnl: 2,
    fees: 0,
    fundingPaid: 0,
    slippageCost: 0,
    netPnl: 2,
    barsHeld: 1,
    maePct: null,
    mfePct: null,
    intelScoreAtEntry: null,
    gateAction: null,
    trailTierLabel: null,
    trailStep: 0,
    equityAtEntry: null,
    marginUsdt: null,
    ...partial,
  };
}

describe("computeTradePriceRr", () => {
  it("computes long RR from initial SL", () => {
    const rr = computeTradePriceRr(
      trade({ entryPrice: 100, exitPrice: 102, initialSlPrice: 99, direction: "BUY" }),
    );
    expect(rr).toBeCloseTo(2, 5);
  });

  it("computes short RR", () => {
    const rr = computeTradePriceRr(
      trade({ entryPrice: 100, exitPrice: 98, initialSlPrice: 101, direction: "SELL" }),
    );
    expect(rr).toBeCloseTo(2, 5);
  });

  it("ignores trailed SL at entry", () => {
    const rr = computeTradePriceRr(
      trade({ entryPrice: 100, exitPrice: 102, slPrice: 100, initialSlPrice: 99 }),
    );
    expect(rr).toBeCloseTo(2, 5);
  });

  it("averages RR across trades", () => {
    const avg = avgTradePriceRr([
      trade({ entryPrice: 100, exitPrice: 102, initialSlPrice: 99 }),
      trade({ entryPrice: 100, exitPrice: 99, initialSlPrice: 99 }),
    ]);
    expect(avg).toBeCloseTo(0.5, 5);
  });
});
