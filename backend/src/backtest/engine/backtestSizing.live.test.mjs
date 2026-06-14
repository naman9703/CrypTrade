import test from "node:test";
import assert from "node:assert/strict";
import {
  computeEntryQtyDetailed,
  resolveBacktestMarginCapUsdt,
  resolveBacktestPolicyCapUsdt,
} from "./backtestSizing.js";
import { resolveCostModel } from "./costModel.js";

const cm5 = resolveCostModel({ marketMode: "FUTURES", futuresLeverage: 5 });
const entry = 670;
const sl = entry * 0.998;

test("allowedBudgetUsdt below equity caps margin lane", () => {
  const cap = resolveBacktestMarginCapUsdt({
    cfg: { allowedBudgetUsdt: 50 },
    equity: 100,
    symbol: "BNBUSDT",
  });
  assert.ok(Math.abs(cap - 50) < 0.01);
});

test("single-coin backtest uses full capital even when bot cfg is MULTIPLE", () => {
  const cfg = {
    allowedBudgetUsdt: 2000,
    universeCoinSelectMode: "MULTIPLE",
    multiBudgetSplitMode: "EQUAL",
    multiCoinCapitalSizingActive: true,
    universeCustomSymbols: ["BTCUSDT", "BNBUSDT", "ETHUSDT", "XRPUSDT", "DOGEUSDT", "LINKUSDT", "ADAUSDT"],
  };
  const cap = resolveBacktestMarginCapUsdt({ cfg, equity: 100, symbol: "BNBUSDT" });
  assert.ok(Math.abs(cap - 100) < 0.02);
  const policy = resolveBacktestPolicyCapUsdt(cfg, 100, "BNBUSDT");
  assert.ok(Math.abs(policy - 100) < 0.02);
});

test("live multi-coin split opt-in uses pool / n coins for margin cap", () => {
  const cfg = {
    backtestApplyLiveMultiCoinSplit: true,
    allowedBudgetUsdt: 100,
    universeCoinSelectMode: "MULTIPLE",
    multiBudgetSplitMode: "EQUAL",
    multiCoinCapitalSizingActive: true,
    universeCustomSymbols: ["BTCUSDT", "BNBUSDT", "ETHUSDT", "XRPUSDT", "DOGEUSDT", "LINKUSDT", "ADAUSDT"],
  };
  const cap = resolveBacktestMarginCapUsdt({ cfg, equity: 100, symbol: "BNBUSDT" });
  assert.ok(Math.abs(cap - 100 / 7) < 0.02);
  const policy = resolveBacktestPolicyCapUsdt(cfg, 100, "BNBUSDT");
  assert.ok(Math.abs(policy - 100 / 7) < 0.02);
});

test("RISK_AT_SL tight stop sets leverageCapped when uncapped exceeds max notional", () => {
  const res = computeEntryQtyDetailed({
    equity: 100,
    entryFill: entry,
    sl,
    cfg: { backtestPositionSizing: "RISK_AT_SL", riskPerTrade: 5, riskPerTradeUnit: "PCT" },
    cm: cm5,
    isFutures: true,
    symbol: "BNBUSDT",
  });
  assert.equal(res.leverageCapped, true);
  assert.ok(Math.abs(res.marginUsdt - 100) < 0.02);
  assert.ok(res.uncappedQty > res.qty);
});

test("allowed budget 50 on 5x yields margin 50 not 100", () => {
  const res = computeEntryQtyDetailed({
    equity: 100,
    entryFill: entry,
    sl,
    cfg: {
      allowedBudgetUsdt: 50,
      backtestPositionSizing: "RISK_AT_SL",
      riskPerTrade: 5,
      riskPerTradeUnit: "PCT",
    },
    cm: cm5,
    isFutures: true,
    symbol: "BNBUSDT",
  });
  assert.ok(Math.abs(res.marginCapUsdt - 50) < 0.01);
  assert.ok(Math.abs(res.marginUsdt - 50) < 0.05);
  assert.equal(res.allotmentCapped, true);
});

test("wide stop can avoid leverage cap", () => {
  const wideSl = entry * 0.9;
  const res = computeEntryQtyDetailed({
    equity: 1000,
    entryFill: entry,
    sl: wideSl,
    cfg: { backtestPositionSizing: "RISK_AT_SL", riskPerTrade: 5, riskPerTradeUnit: "PCT" },
    cm: cm5,
    isFutures: true,
    symbol: "BNBUSDT",
  });
  assert.equal(res.leverageCapped, false);
  assert.ok(res.marginUsdt < 500);
});
