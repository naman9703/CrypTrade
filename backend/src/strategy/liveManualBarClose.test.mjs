import test from "node:test";
import assert from "node:assert/strict";
import {
  manualStrategyUsesLiveBarClose,
  LIVE_BAR_CLOSE_ADAPTER_KEYS,
  PANEL_MANUAL_STRATEGY_KEYS,
  resolveTradingVenueForBarClose,
  barCloseActivityKindFor,
  shouldSuppressBarCloseAutotradeOffActivity,
  barCloseTradingConfigured,
  barCloseWatchConfigured,
  supertrendAutotradeActive,
  tickExecutionOwnedByBarClose,
  barCloseSignalStrategyKey,
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

test("resolveTradingVenueForBarClose uses marketMode for MANUAL adapter (not ST autotrade toggles)", () => {
  const cfg = {
    strategyMode: "MANUAL",
    manualStrategy: "TREND_HTF_ST",
    marketMode: "AUTO",
    supertrendSpotAuto: false,
    supertrendFuturesAuto: false,
    running: false,
  };
  assert.deepEqual(resolveTradingVenueForBarClose(cfg, "AUTO"), { stSpot: false, stFut: true });
});

test("resolveTradingVenueForBarClose respects supertrend autotrade toggles in AUTO mode", () => {
  const cfg = {
    strategyMode: "AUTO",
    manualStrategy: "TREND_HTF_ST",
    marketMode: "AUTO",
    supertrendSpotAuto: false,
    supertrendFuturesAuto: false,
  };
  assert.deepEqual(resolveTradingVenueForBarClose(cfg, "AUTO"), { stSpot: false, stFut: false });
});

test("shouldSuppressBarCloseAutotradeOffActivity silences raw ST with autotrade off", () => {
  assert.equal(
    shouldSuppressBarCloseAutotradeOffActivity({
      strategyMode: "AUTO",
      manualStrategy: "TREND_HTF_ST",
    }),
    true,
  );
  assert.equal(
    shouldSuppressBarCloseAutotradeOffActivity({
      strategyMode: "MANUAL",
      manualStrategy: "SUPERTREND",
    }),
    true,
  );
});

test("shouldSuppressBarCloseAutotradeOffActivity keeps MANUAL adapter skips visible", () => {
  assert.equal(
    shouldSuppressBarCloseAutotradeOffActivity({
      strategyMode: "MANUAL",
      manualStrategy: "TREND_HTF_ST",
    }),
    false,
  );
});

test("barCloseActivityKindFor labels MANUAL adapter as strategy", () => {
  const cfg = { strategyMode: "MANUAL", manualStrategy: "HTF_RSI" };
  assert.equal(barCloseActivityKindFor(cfg, "HTF_RSI"), "strategy");
  assert.equal(barCloseActivityKindFor(cfg, "SUPERTREND"), "supertrend");
  assert.equal(barCloseActivityKindFor({ strategyMode: "AUTO" }, "SUPERTREND"), "supertrend");
});

test("barCloseTradingConfigured and watch helpers unify venue checks", () => {
  const manual = { strategyMode: "MANUAL", manualStrategy: "TREND_HTF_ST", marketMode: "AUTO" };
  assert.equal(barCloseTradingConfigured(manual, "AUTO"), true);
  assert.equal(barCloseWatchConfigured(manual, "AUTO"), true);
  assert.equal(supertrendAutotradeActive(manual, "AUTO"), false);

  const autoOff = { strategyMode: "AUTO", marketMode: "AUTO", supertrendSpotAuto: false, supertrendFuturesAuto: false };
  assert.equal(barCloseTradingConfigured(autoOff, "AUTO"), false);
  assert.equal(barCloseWatchConfigured(autoOff, "AUTO"), false);
});

test("tickExecutionOwnedByBarClose disables tick trading for MANUAL even when stopped", () => {
  const cfg = { strategyMode: "MANUAL", manualStrategy: "HTF_RSI", running: false, marketMode: "AUTO" };
  assert.equal(tickExecutionOwnedByBarClose(cfg, "AUTO", { liveFeed: true }), true);
  assert.equal(tickExecutionOwnedByBarClose(cfg, "AUTO", { liveFeed: false }), false);
});

test("barCloseSignalStrategyKey matches active bar-close strategy", () => {
  assert.equal(
    barCloseSignalStrategyKey({ strategyMode: "MANUAL", manualStrategy: "TREND_HTF_ST" }),
    "TREND_HTF_ST",
  );
  assert.equal(barCloseSignalStrategyKey({ strategyMode: "AUTO" }), "SUPERTREND");
});
