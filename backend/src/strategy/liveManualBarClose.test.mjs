import test from "node:test";
import assert from "node:assert/strict";
import {
  manualStrategyUsesLiveBarClose,
  LIVE_BAR_CLOSE_ADAPTER_KEYS,
  PANEL_MANUAL_STRATEGY_KEYS,
} from "./liveStrategyBarClose.js";

test("manualStrategyUsesLiveBarClose requires MANUAL mode", () => {
  assert.equal(
    manualStrategyUsesLiveBarClose({ strategyMode: "AUTO", manualStrategy: "SUPERTREND_ELITE" }),
    false,
  );
  assert.equal(
    manualStrategyUsesLiveBarClose({ strategyMode: "MANUAL", manualStrategy: "SUPERTREND_ELITE" }),
    true,
  );
  assert.equal(
    manualStrategyUsesLiveBarClose({ strategyMode: "MANUAL", manualStrategy: "EMA_CROSS" }),
    true,
  );
  assert.equal(
    manualStrategyUsesLiveBarClose({ strategyMode: "MANUAL", manualStrategy: "NOT_A_STRATEGY" }),
    false,
  );
});

test("PANEL_MANUAL_STRATEGY_KEYS includes full trading panel list", () => {
  assert.ok(PANEL_MANUAL_STRATEGY_KEYS.has("SUPERTREND_ELITE"));
  assert.ok(PANEL_MANUAL_STRATEGY_KEYS.has("REGIME_ADAPTIVE"));
  assert.ok(PANEL_MANUAL_STRATEGY_KEYS.has("EMA_CROSS"));
  assert.equal(PANEL_MANUAL_STRATEGY_KEYS.size, LIVE_BAR_CLOSE_ADAPTER_KEYS.size);
});
