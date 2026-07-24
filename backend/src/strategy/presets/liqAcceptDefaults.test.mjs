import assert from "node:assert/strict";
import test from "node:test";
import {
  INTRADAY_PRO_LIQ_ACCEPT_BNB_15M,
  fillLiqSoloPresetDefaults,
} from "./srIntradayOptimized.js";
import {
  acceptHeldOnBar,
  acceptHeldThrough,
  computeAcceptanceBrackets,
} from "../techniques/liquidity.js";

test("LIQ_ACCEPT preset — continuation playbook defaults", () => {
  assert.equal(INTRADAY_PRO_LIQ_ACCEPT_BNB_15M.intradayLiqPlaybook, "LIQ_ACCEPT");
  assert.equal(INTRADAY_PRO_LIQ_ACCEPT_BNB_15M.intradayLiqClassicEnabled, false);
  assert.equal(INTRADAY_PRO_LIQ_ACCEPT_BNB_15M.intradayLiqAcceptEnabled, true);
  assert.equal(INTRADAY_PRO_LIQ_ACCEPT_BNB_15M.intradayLiqAcceptHoldBars, 2);
});

test("fillLiqSoloPresetDefaults — LIQ_ACCEPT does not inject legacy fade stack", () => {
  const out = fillLiqSoloPresetDefaults({
    symbol: "BNBUSDT",
    timeframe: "15m",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    intradayGateLiquidity: true,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
    intradayLiqPlaybook: "LIQ_ACCEPT",
  });
  assert.equal(out.intradayLiqPlaybook, "LIQ_ACCEPT");
  assert.equal(out.intradayLiqClassicEnabled, false);
  assert.equal(out.intradayLiqAcceptEnabled, true);
});

test("acceptHeldOnBar + brackets — SSL breakdown short", () => {
  const candles = [
    { open: 100, high: 101, low: 99, close: 99.5 },
    { open: 99.5, high: 100, low: 98.5, close: 98.8 },
    { open: 98.8, high: 99, low: 98.2, close: 98.4 },
  ];
  const level = 99;
  assert.equal(acceptHeldOnBar(candles, 1, "BUY", level), true);
  assert.equal(acceptHeldThrough(candles, 1, 2, "BUY", level), true);
  const br = computeAcceptanceBrackets("SELL", 98.4, level, 96, { intradayLiqMinRr: 0 });
  assert.ok(br);
  assert.ok(br.slPrice > 98.4);
  assert.ok(br.tp2Price < 98.4);
});
