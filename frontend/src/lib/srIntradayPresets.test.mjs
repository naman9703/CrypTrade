import test from "node:test";
import assert from "node:assert/strict";
import {
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_LIQ_ETH_15M,
  INTRADAY_PRO_LIQ_BTC_15M,
  buildEthLiqPresetApplyPatch,
  buildBtcLiqPresetApplyPatch,
  presetMatchesBot,
  INTRADAY_PRO_LIQ_ETH_15M_SIGNATURE_KEYS,
  INTRADAY_PRO_LIQ_BTC_15M_SIGNATURE_KEYS,
} from "./srIntradayPresets.ts";

test("buildBtcLiqPresetApplyPatch routes SR_INTRADAY LIQ solo with research gates", () => {
  const patch = buildBtcLiqPresetApplyPatch();
  assert.equal(patch.symbol, "BTCUSDT");
  assert.equal(patch.manualStrategy, "SR_INTRADAY");
  assert.equal(patch.intradayGateLiquidity, true);
  assert.equal(patch.intradayLiqBreakdownDayBias, true);
  assert.equal(patch.intradayLiqRequireChoch, false);
  assert.equal(patch.intradayLiqRequireKillzone, false);
  assert.equal(patch.intradayLiqPartialTp, INTRADAY_PRO_LIQ_BTC_15M.intradayLiqPartialTp);
  assert.equal(
    presetMatchesBot(patch, patch, INTRADAY_PRO_LIQ_BTC_15M_SIGNATURE_KEYS),
    true,
  );
});

test("buildEthLiqPresetApplyPatch keeps trail-only exit from ETH preset", () => {
  const patch = buildEthLiqPresetApplyPatch();
  assert.equal(patch.trailingStopLossAuto, true);
  assert.equal(patch.intradayLiqAllowTrailOnlyExit, true);
  assert.equal(patch.intradayLiqPartialTp, false);
  assert.equal(patch.intradayLiqTp1Enabled, false);
  assert.equal(patch.intradayLiqTp2Enabled, false);
  assert.equal(patch.trailOnlyAfterTp2Fill, false);
  assert.equal(patch.manualStrategy, "SR_INTRADAY");
  assert.equal(patch.intradayGateLiquidity, true);
});

test("presetMatchesBot flags ETH LIQ when trail is accidentally off", () => {
  const patch = buildEthLiqPresetApplyPatch();
  assert.equal(
    presetMatchesBot(patch, { ...patch, trailingStopLossAuto: false }, INTRADAY_PRO_LIQ_ETH_15M_SIGNATURE_KEYS),
    false,
  );
  assert.equal(
    presetMatchesBot(patch, patch, INTRADAY_PRO_LIQ_ETH_15M_SIGNATURE_KEYS),
    true,
  );
});

test("INTRADAY_PRO_LIQ_ETH_15M and apply patch agree on trail exit", () => {
  const patch = buildEthLiqPresetApplyPatch();
  assert.equal(patch.trailingStopLossAuto, INTRADAY_PRO_LIQ_ETH_15M.trailingStopLossAuto);
  assert.equal(
    patch.intradayLiqAllowTrailOnlyExit,
    INTRADAY_PRO_LIQ_ETH_15M.intradayLiqAllowTrailOnlyExit,
  );
});

test("ETH LIQ preset uses fade + context score + sweep quality gates", () => {
  assert.equal(INTRADAY_PRO_LIQ_ETH_15M.intradayLiqEntryMode, "fade");
  assert.equal(INTRADAY_PRO_LIQ_ETH_15M.intradayLiqRequirePostReclaimDisplacement, false);
  assert.equal(INTRADAY_PRO_LIQ_ETH_15M.intradayLiqTrailUseContextScore, true);
  assert.equal(INTRADAY_PRO_LIQ_ETH_15M.intradayLiqMinEntryScore, 38);
  assert.equal(INTRADAY_PRO_LIQ_ETH_15M.intradayLiqSweepQualityGate, false);
  assert.equal(INTRADAY_PRO_LIQ_ETH_15M.intradayLiqReclaimHoldBars, 0);
  assert.equal(INTRADAY_PRO_LIQ_ETH_15M.intradayLiqPdhPdlOnly, false);
  assert.equal(INTRADAY_PRO_LIQ_ETH_15M.intradayLiqMinRr, 0);
});
