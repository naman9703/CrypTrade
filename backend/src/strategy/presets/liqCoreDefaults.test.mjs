import test from "node:test";
import assert from "node:assert/strict";
import {
  INTRADAY_PRO_LIQ_CORE_15M,
  INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M,
  fillLiqSoloPresetDefaults,
} from "./srIntradayOptimized.js";

test("LIQ_CORE preset — chronological + concept-only defaults", () => {
  assert.equal(INTRADAY_PRO_LIQ_CORE_15M.intradayLiqPlaybook, "LIQ_CORE");
  assert.equal(INTRADAY_PRO_LIQ_CORE_15M.intradayLiqPickMode, "chronological");
  assert.equal(INTRADAY_PRO_LIQ_CORE_15M.intradayLiqOnePickPerDay, false);
  assert.equal(INTRADAY_PRO_LIQ_CORE_15M.intradayLiqSessionExtreme, true);
  assert.equal(INTRADAY_PRO_LIQ_CORE_15M.intradayLiqRejectSameBarReclaim, false);
  assert.equal(INTRADAY_PRO_LIQ_CORE_15M.intradayLiqMinReclaimBodyRatio, 0);
  assert.equal(INTRADAY_PRO_LIQ_CORE_15M.intradayLiqUseEntryScore, false);
  assert.equal(INTRADAY_PRO_LIQ_CORE_15M.intradayLiqRequireHtfAlign, false);
  assert.equal(INTRADAY_PRO_LIQ_CORE_15M.intradayLiqMinRr, 1);
  assert.equal(INTRADAY_PRO_LIQ_CORE_15M.intradayLiqPartialTp, false);
  assert.equal(INTRADAY_PRO_LIQ_CORE_15M.intradayLiqBreakevenAfterPartial, false);
});

test("LIQ BNB AST+vol15 research sleeve — gate stack locked", () => {
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.symbol, "BNBUSDT");
  assert.deepEqual(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.intradayLiqSessionNarratives, [
    "asia_accum",
    "london_sweep",
  ]);
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.intradayLiqSessionExtreme, false);
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.intradayLiqRequireSameBarReclaim, true);
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.intradayLiqDaySituationBias, true);
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.intradayLiqMaxSlPct, 0.008);
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.intradayLiqRequirePremiumDiscountAlign, true);
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.intradayLiqSweepMinVolRatio, 1.5);
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.srIntradaySessionStartHour, 0);
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.maxDailyLoss, 3);
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.riskConsecutiveLossLimit, 3);
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.intradayLiqPickMode, "chronological");
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.intradayLiqPartialTp, false);
  assert.equal(INTRADAY_PRO_LIQ_BNB_AST_VOL15_15M.intradayLiqMaxTpRr, 2);
});

test("fillLiqSoloPresetDefaults — LIQ_CORE does not inject legacy body/score stack", () => {
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
    intradayLiqPlaybook: "LIQ_CORE",
    intradayLiqPickMode: "chronological",
    intradayLiqOnePickPerDay: false,
  });
  assert.equal(out.intradayLiqPlaybook, "LIQ_CORE");
  assert.equal(out.intradayLiqPickMode, "chronological");
  assert.equal(out.intradayLiqOnePickPerDay, false);
  assert.equal(out.intradayLiqMinReclaimBodyRatio, 0);
  assert.equal(out.intradayLiqUseEntryScore, false);
  assert.equal(out.intradayLiqSessionExtreme, true);
});
