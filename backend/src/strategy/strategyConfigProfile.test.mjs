import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAllowedKeySet,
  getStrategyProfile,
  pickProfileBot,
  profileAllowsKey,
  profileUsesIntradayMaxHold,
  sanitizeCfgForStrategy,
  exportProfileMetadata,
} from "./strategyConfigProfile.js";
import { sanitizeSignalBrainCfgRaw } from "../lib/strategySignalBrain.js";
import { sanitizeBacktestConfigSnapshot } from "../lib/strategySignalBrain.js";

test("getStrategyProfile returns elite profile for SUPERTREND_ELITE", () => {
  const p = getStrategyProfile("SUPERTREND_ELITE");
  assert.equal(p.key, "SUPERTREND_ELITE");
  assert.equal(p.prepare, "elite");
  assert.equal(p.chartMarkup, "elite");
  assert.equal(profileUsesIntradayMaxHold("SUPERTREND_ELITE"), false);
});

test("getStrategyProfile falls back to baseline for EMA_CROSS", () => {
  const p = getStrategyProfile("EMA_CROSS");
  assert.equal(p.key, "baseline");
});

test("Elite profile strips intraday pollution keys", () => {
  const out = sanitizeCfgForStrategy("SUPERTREND_ELITE", {
    manualStrategy: "SUPERTREND_ELITE",
    eliteStRequireHtf4hAlign: true,
    intradayGateSmcIct: true,
    intradaySmcMaxHoldBars: 48,
    intradayGateLiquidity: true,
    supertrendPeriod: 10,
  });
  assert.equal(out.eliteStRequireHtf4hAlign, true);
  assert.equal(out.intradayGateSmcIct, undefined);
  assert.equal(out.intradaySmcMaxHoldBars, undefined);
  assert.equal(out.intradayGateLiquidity, undefined);
});

test("SR_INTRADAY keeps intraday keys, drops eliteSt", () => {
  const out = sanitizeCfgForStrategy("SR_INTRADAY", {
    manualStrategy: "SR_INTRADAY",
    intradayGateSmcIct: true,
    intradaySmcMinScore: 5,
    eliteStRequireHtf4hAlign: true,
    eliteStMinAdx: 20,
  });
  assert.equal(out.intradayGateSmcIct, true);
  assert.equal(out.intradaySmcMinScore, 5);
  assert.equal(out.eliteStRequireHtf4hAlign, undefined);
  assert.equal(out.eliteStMinAdx, undefined);
});

test("profileAllowsKey respects strategy scope", () => {
  assert.equal(profileAllowsKey("eliteStMinAdx", "SUPERTREND_ELITE"), true);
  assert.equal(profileAllowsKey("intradayGateSmcIct", "SUPERTREND_ELITE"), false);
  assert.equal(profileAllowsKey("intradayGateSmcIct", "SR_INTRADAY"), true);
  assert.equal(profileAllowsKey("intelligenceGateEnabled", "SUPERTREND_ELITE"), true);
});

test("sanitizeSignalBrainCfgRaw applies profile on save path", () => {
  const raw = sanitizeSignalBrainCfgRaw({
    v: 1,
    bot: {
      manualStrategy: "SUPERTREND_ELITE",
      eliteStRequireHtf4hAlign: true,
      intradayGateSmcIct: true,
      supertrendPeriod: 10,
    },
  });
  assert.equal(raw.bot.intradayGateSmcIct, undefined);
  assert.equal(raw.bot.eliteStRequireHtf4hAlign, true);
});

test("Elite allowed key set excludes intraday native keys", () => {
  const elite = buildAllowedKeySet(getStrategyProfile("SUPERTREND_ELITE"));
  const sr = buildAllowedKeySet(getStrategyProfile("SR_INTRADAY"));
  assert.ok(sr.size > elite.size);
  for (const k of elite) {
    if (k.startsWith("intraday") || k.startsWith("srIntraday")) {
      assert.fail(`Elite allowlist must not include ${k}`);
    }
  }
});

test("exportProfileMetadata includes all panel strategies with baseline fallback", () => {
  const meta = exportProfileMetadata();
  assert.ok(meta.profiles.SUPERTREND_ELITE);
  assert.ok(meta.profiles.SR_INTRADAY);
  assert.ok(meta.profiles.baseline);
});

test("pickProfileBot preserves explicit false values", () => {
  const out = pickProfileBot(
    { manualStrategy: "SUPERTREND_ELITE", eliteStRequireHtf4hAlign: false },
    getStrategyProfile("SUPERTREND_ELITE"),
  );
  assert.equal(out.eliteStRequireHtf4hAlign, false);
});

test("SR_INTRADAY save keeps trailOnlyAfterTp2Fill", () => {
  const raw = sanitizeSignalBrainCfgRaw({
    v: 1,
    bot: {
      manualStrategy: "SR_INTRADAY",
      intradayGateLiquidity: true,
      trailOnlyAfterTp2Fill: false,
      intradayLiqMaxHoldBars: 48,
    },
  });
  assert.equal(raw.bot.trailOnlyAfterTp2Fill, false);
  assert.equal(raw.bot.intradayLiqMaxHoldBars, 48);
});

test("VOLUME_PROFILE save keeps FREQ funnel knobs", () => {
  const raw = sanitizeSignalBrainCfgRaw({
    v: 1,
    bot: {
      manualStrategy: "VOLUME_PROFILE",
      vpTierAOnly: false,
      vpRequireHtfAlign: true,
      vpMinHtfSepPct: 0.0015,
      vpMaxTradesPerDay: 1,
      vpMinAdx: 0,
      vpAllowedSetups: ["vah_breakout", "val_breakdown", "va_rejection"],
      vpRegimeImmunity: false,
      vpMinScore: 8,
      requireVpSetup: true,
    },
  });
  assert.equal(raw.bot.vpTierAOnly, false);
  assert.equal(raw.bot.vpRequireHtfAlign, true);
  assert.equal(raw.bot.vpMinHtfSepPct, 0.0015);
  assert.equal(raw.bot.vpMaxTradesPerDay, 1);
  assert.equal(raw.bot.vpMinAdx, 0);
  assert.equal(raw.bot.vpRegimeImmunity, false);
  assert.deepEqual(raw.bot.vpAllowedSetups, ["vah_breakout", "val_breakdown", "va_rejection"]);
  assert.equal(raw.bot.requireVpSetup, true);

  const snap = sanitizeBacktestConfigSnapshot({
    v: 1,
    bot: raw.bot,
  });
  assert.equal(snap.bot.vpTierAOnly, false);
  assert.equal(snap.bot.vpMaxTradesPerDay, 1);
  assert.ok(Array.isArray(snap.bot.vpAllowedSetups));
});
