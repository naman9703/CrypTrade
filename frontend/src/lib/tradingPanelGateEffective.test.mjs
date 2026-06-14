import test from "node:test";
import assert from "node:assert/strict";
import {
  isGateEffective,
  manualAdapterPath,
  stAutotradeOnlyGatesEffective,
} from "./tradingPanelGateEffective.ts";

test("manualAdapterPath for SUPERTREND_ELITE MANUAL", () => {
  const cfg = {
    strategyMode: "MANUAL",
    manualStrategy: "SUPERTREND_ELITE",
    supertrendFuturesAuto: false,
  };
  assert.equal(manualAdapterPath(cfg), true);
  assert.equal(stAutotradeOnlyGatesEffective(cfg), false);
  assert.equal(isGateEffective(cfg, "moveQuality"), false);
  assert.equal(isGateEffective(cfg, "intelligence"), false);
});

test("intelligence effective on MANUAL when intelligenceGateManualStrategies true", () => {
  const cfg = {
    strategyMode: "MANUAL",
    manualStrategy: "SUPERTREND_ELITE",
    intelligenceGateEnabled: true,
    intelligenceGateManualStrategies: true,
  };
  assert.equal(isGateEffective(cfg, "intelligence"), true);
});

test("ST autotrade gates effective when futures auto on and not manual adapter", () => {
  const cfg = {
    strategyMode: "MANUAL",
    manualStrategy: "SUPERTREND",
    marketMode: "FUTURES",
    supertrendFuturesAuto: true,
    signalStrengthGatesTrades: true,
  };
  assert.equal(manualAdapterPath(cfg), false);
  assert.equal(isGateEffective(cfg, "signalStrength"), true);
});

test("SUPERTREND plain MANUAL is not manualAdapterPath", () => {
  const cfg = { strategyMode: "MANUAL", manualStrategy: "SUPERTREND" };
  assert.equal(manualAdapterPath(cfg), false);
});
