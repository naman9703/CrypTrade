import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTrailingOptsFromCfg,
  isTrailingEnabledInCfg,
  resolveTrailOnlyAfterTp2Fill,
} from "./trailingOptsFromCfg.js";
import { resolveCostModel } from "../backtest/engine/costModel.js";
import { materializeLiqTrailingGateOnCfg } from "../strategy/intradayPanelKeys.js";
import { INTRADAY_PRO_LIQ_ETH_15M } from "../strategy/presets/srIntradayOptimized.js";

test("isTrailingEnabledInCfg requires futures + auto + mode", () => {
  assert.equal(isTrailingEnabledInCfg({ trailingStopLossAuto: true, marketMode: "FUTURES" }), true);
  assert.equal(isTrailingEnabledInCfg({ trailingStopLossAuto: true, marketMode: "SPOT" }), false);
  assert.equal(
    isTrailingEnabledInCfg({
      trailingStopLossAuto: true,
      marketMode: "FUTURES",
      futuresTrailingStopMode: "OFF",
    }),
    false,
  );
});

test("buildTrailingOptsFromCfg maps buffer and fee keys", () => {
  const cfg = {
    trailingStopLossAuto: true,
    marketMode: "FUTURES",
    futuresTrailingStopMode: "SUPERTREND",
    trailBufferRate: 0.001,
    futuresTrailingStFeeBreakeven: true,
    futuresTrailingStAdvanced: true,
    trailT01LockSlippageFrac: 0.0001,
  };
  const cm = resolveCostModel(cfg);
  const opts = buildTrailingOptsFromCfg(cfg, cm, { supertrendPx: 100_000 });
  assert.equal(opts.enabled, true);
  assert.equal(opts.mode, "SUPERTREND");
  assert.ok(opts.bufferRate > 0);
  assert.equal(opts.supertrendPx, 100_000);
  assert.equal(opts.supertrendUseFeeBreakeven, true);
  assert.equal(opts.supertrendUseAdvancedTrail, true);
});

test("resolveTrailOnlyAfterTp2Fill auto-enables for liq TP2 ladder", () => {
  const cfg = {
    trailingStopLossAuto: true,
    marketMode: "FUTURES",
    intradayLiqTp1Rr: 1,
    intradayLiqTp2Rr: 2,
    intradayLiqTp2PartialFrac: 0.25,
  };
  assert.equal(resolveTrailOnlyAfterTp2Fill(cfg), true);
  assert.equal(materializeLiqTrailingGateOnCfg(cfg).trailOnlyAfterTp2Fill, true);
});

test("resolveTrailOnlyAfterTp2Fill respects explicit false", () => {
  const cfg = {
    trailingStopLossAuto: true,
    marketMode: "FUTURES",
    trailOnlyAfterTp2Fill: false,
    intradayLiqTp2Rr: 2,
    intradayLiqTp2PartialFrac: 0.25,
  };
  assert.equal(resolveTrailOnlyAfterTp2Fill(cfg), false);
});

test("resolveTrailOnlyAfterTp2Fill ETH preset is off (base LIQ trail)", () => {
  assert.equal(resolveTrailOnlyAfterTp2Fill(INTRADAY_PRO_LIQ_ETH_15M), false);
});
