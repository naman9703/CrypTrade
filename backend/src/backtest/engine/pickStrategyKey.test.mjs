import test from "node:test";
import assert from "node:assert/strict";
import { pickStrategyKeyFromCfg } from "./pickStrategyKey.js";

test("MANUAL LIQ_CASCADE wins over supertrendFuturesAuto (live parity)", () => {
  assert.equal(
    pickStrategyKeyFromCfg({
      strategyMode: "MANUAL",
      manualStrategy: "LIQ_CASCADE",
      supertrendFuturesAuto: true,
      marketMode: "FUTURES",
    }),
    "LIQ_CASCADE",
  );
});

test("MANUAL TREND_HTF_ST wins over supertrendFuturesAuto", () => {
  assert.equal(
    pickStrategyKeyFromCfg({
      strategyMode: "MANUAL",
      manualStrategy: "TREND_HTF_ST",
      supertrendFuturesAuto: true,
      marketMode: "FUTURES",
    }),
    "TREND_HTF_ST",
  );
});

test("manual TREND_HTF_ST without stAuto runs TREND_HTF_ST", () => {
  assert.equal(
    pickStrategyKeyFromCfg({
      strategyMode: "MANUAL",
      manualStrategy: "TREND_HTF_ST",
      supertrendFuturesAuto: false,
      marketMode: "FUTURES",
    }),
    "TREND_HTF_ST",
  );
});

test("manual SUPERTREND + st auto uses SUPERTREND", () => {
  assert.equal(
    pickStrategyKeyFromCfg({
      strategyMode: "MANUAL",
      manualStrategy: "SUPERTREND",
      supertrendFuturesAuto: true,
      marketMode: "FUTURES",
    }),
    "SUPERTREND",
  );
});

test("st auto without explicit manual panel strategy uses SUPERTREND", () => {
  assert.equal(
    pickStrategyKeyFromCfg({
      strategyMode: "MANUAL",
      manualStrategy: "SUPERTREND",
      supertrendFuturesAuto: true,
      marketMode: "FUTURES",
    }),
    "SUPERTREND",
  );
});
