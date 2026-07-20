import test from "node:test";
import assert from "node:assert/strict";
import {
  buildManualStrategySwitchPatch,
  strategySliceFromCfgRaw,
} from "./strategyConfigSlices.ts";

test("strategySliceFromCfgRaw reads byStrategy slice", () => {
  const cfgRaw = {
    v: 1,
    bot: { manualStrategy: "SR_INTRADAY", intradayGateSmcIct: true },
    byStrategy: {
      SUPERTREND_ELITE: { eliteStMinAdx: 20, trailingStopLossAuto: true },
      SR_INTRADAY: { intradayGateSmcIct: true, intradaySmcMinScore: 6 },
    },
  };
  const elite = strategySliceFromCfgRaw(cfgRaw, "SUPERTREND_ELITE");
  assert.equal(elite.eliteStMinAdx, 20);
  assert.equal(elite.intradayGateSmcIct, undefined);
});

test("buildManualStrategySwitchPatch loads saved slice for new path", () => {
  const cfgRaw = {
    byStrategy: {
      SUPERTREND_ELITE: { eliteStMinAdx: 20, trailingStopLossAuto: true },
    },
  };
  const patch = buildManualStrategySwitchPatch(
    { manualStrategy: "SR_INTRADAY", intradayGateSmcIct: true, futuresLeverage: 10 },
    "SUPERTREND_ELITE",
    cfgRaw,
    null,
  );
  assert.equal(patch.manualStrategy, "SUPERTREND_ELITE");
  assert.equal(patch.eliteStMinAdx, 20);
  assert.equal(patch.intradayGateSmcIct, undefined);
});
