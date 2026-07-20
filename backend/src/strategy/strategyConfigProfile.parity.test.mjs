import test from "node:test";
import assert from "node:assert/strict";
import { resolveMaxHoldBars } from "../backtest/engine/runner.js";
import { buildEliteStOptsFromCfg } from "./supertrendElite.js";
import { sanitizeCfgForStrategy } from "./strategyConfigProfile.js";

/** Frozen Elite snapshot shape (polluted with intraday keys — common in DB). */
const POLLUTED_ELITE = {
  manualStrategy: "SUPERTREND_ELITE",
  strategyMode: "MANUAL",
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  supertrendWilderAtr: true,
  eliteStRequireHtf4hAlign: true,
  eliteStRequireHtf1hEmaAlign: true,
  eliteStHtf1hSepMode: "ADX",
  eliteStMinAdx: 20,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  supertrendFuturesUseFixedSl: true,
  supertrendFuturesFixedSlPct: 0.002,
  supertrendFuturesUseFixedTp: false,
  intradayGateSmcIct: true,
  intradaySmcMaxHoldBars: 48,
  intradayGateLiquidity: true,
};

test("profile runtime sanitize preserves Elite adapter opts vs legacy normalize path", () => {
  const legacy = { ...POLLUTED_ELITE };
  legacy.intradaySmcMaxHoldBars = 0;
  legacy.intradayLiqMaxHoldBars = 0;
  legacy.intradayOfMaxHoldBars = 0;

  const profiled = sanitizeCfgForStrategy("SUPERTREND_ELITE", POLLUTED_ELITE, { phase: "runtime" });

  assert.equal(profiled.intradayGateSmcIct, undefined);
  assert.equal(profiled.intradaySmcMaxHoldBars, undefined);
  assert.equal(profiled.eliteStHtf1hSepMode, "ADX");

  assert.equal(resolveMaxHoldBars(POLLUTED_ELITE), 0);
  assert.equal(resolveMaxHoldBars(profiled), 0);

  const legacyOpts = buildEliteStOptsFromCfg(legacy);
  const profileOpts = buildEliteStOptsFromCfg(profiled);
  assert.deepEqual(profileOpts, legacyOpts);
});

test("profile runtime sanitize does not drop SR intraday max-hold semantics", () => {
  const sr = {
    manualStrategy: "SR_INTRADAY",
    intradayGateSmcIct: true,
    intradaySmcMaxHoldBars: 24,
    intradayGateLiquidity: false,
  };
  const out = sanitizeCfgForStrategy("SR_INTRADAY", sr, { phase: "runtime" });
  assert.equal(out.intradayGateSmcIct, true);
  assert.equal(out.intradaySmcMaxHoldBars, 24);
  assert.ok(resolveMaxHoldBars(out) >= 24);
});
