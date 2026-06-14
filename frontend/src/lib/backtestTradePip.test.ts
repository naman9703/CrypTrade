import { describe, expect, it } from "vitest";
import { computeTradePricePip, formatTradePricePip } from "./backtestTradePip";
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

describe("computeTradePricePip", () => {
  it("computes long pip as exit minus entry", () => {
    expect(computeTradePricePip(trade({ entryPrice: 100, exitPrice: 102, direction: "BUY" }))).toBe(2);
  });

  it("computes short pip as entry minus exit", () => {
    expect(computeTradePricePip(trade({ entryPrice: 100, exitPrice: 98, direction: "SELL" }))).toBe(2);
  });

  it("formats signed pip with entry-aware decimals", () => {
    expect(formatTradePricePip(2, 100)).toBe("+2.0000");
    expect(formatTradePricePip(-0.5, 95000)).toBe("-0.50");
  });
});
