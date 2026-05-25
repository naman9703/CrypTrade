import test from "node:test";
import assert from "node:assert/strict";

/** Mirror of worker pickStrategyKey — keep in sync. */
function pickStrategyKey(cfg, engineType) {
  const mmUp = String(cfg?.marketMode || cfg?.market || "").toUpperCase();
  const stSpot = Boolean(cfg?.supertrendSpotAuto);
  const stFut = Boolean(cfg?.supertrendFuturesAuto);
  const supertrendAutoOn =
    (mmUp === "SPOT" && stSpot) ||
    (mmUp === "FUTURES" && stFut) ||
    (mmUp === "AUTO" && (stSpot || stFut));
  if (supertrendAutoOn) return "SUPERTREND";
  const stratMode = String(cfg?.strategyMode ?? "").toUpperCase();
  if (stratMode === "MANUAL") {
    const m = String(cfg?.manualStrategy ?? "").toUpperCase();
    if (m && m !== "MANUAL" && m !== "AUTO") return m;
    return "SUPERTREND";
  }
  if (stratMode === "AUTO") return "AUTO";
  const et = String(engineType ?? "").toUpperCase();
  if (et && et !== "AUTO" && et !== "MANUAL") return et;
  return "SUPERTREND";
}

test("supertrendFuturesAuto runs SUPERTREND (matches UI engine label)", () => {
  assert.equal(
    pickStrategyKey({
      strategyMode: "MANUAL",
      manualStrategy: "TREND_HTF_ST",
      supertrendFuturesAuto: true,
      marketMode: "FUTURES",
    }),
    "SUPERTREND",
  );
});

test("manual TREND_HTF_ST without stAuto runs TREND_HTF_ST", () => {
  assert.equal(
    pickStrategyKey({
      strategyMode: "MANUAL",
      manualStrategy: "TREND_HTF_ST",
      supertrendFuturesAuto: false,
      marketMode: "FUTURES",
    }),
    "TREND_HTF_ST",
  );
});

test("manual SUPERTREND uses SUPERTREND", () => {
  assert.equal(
    pickStrategyKey({
      strategyMode: "MANUAL",
      manualStrategy: "SUPERTREND",
      supertrendFuturesAuto: false,
      marketMode: "FUTURES",
    }),
    "SUPERTREND",
  );
});
