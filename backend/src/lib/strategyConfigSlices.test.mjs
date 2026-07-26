import test from "node:test";
import assert from "node:assert/strict";
import {
  persistCfgRawWithStrategySlices,
  hydrateCfgRawForEngine,
  getStrategySlice,
  ensureByStrategyFromLegacy,
} from "./strategyConfigSlices.js";

test("save preserves other strategy slices when manualStrategy changes", () => {
  const elite = {
    manualStrategy: "SUPERTREND_ELITE",
    strategyMode: "MANUAL",
    eliteStHtf1hSepMode: "ADX",
    eliteStRequireHtf4hAlign: true,
    trailingStopLossAuto: true,
    futuresLeverage: 15,
  };
  const first = persistCfgRawWithStrategySlices({ v: 1, bot: elite });
  assert.ok(first.byStrategy.SUPERTREND_ELITE);
  assert.equal(first.byStrategy.SUPERTREND_ELITE.eliteStHtf1hSepMode, "ADX");

  const sr = {
    manualStrategy: "SR_INTRADAY",
    strategyMode: "MANUAL",
    intradayGateSmcIct: true,
    intradaySmcMinScore: 7,
    trailingStopLossAuto: true,
    futuresLeverage: 10,
  };
  const second = persistCfgRawWithStrategySlices({ ...first, bot: sr });
  assert.equal(second.bot.manualStrategy, "SR_INTRADAY");
  assert.equal(second.byStrategy.SR_INTRADAY.intradayGateSmcIct, true);
  assert.equal(second.byStrategy.SUPERTREND_ELITE.eliteStHtf1hSepMode, "ADX");
  assert.equal(second.byStrategy.SUPERTREND_ELITE.intradayGateSmcIct, undefined);
});

test("hydrate reloads active slice into bot", () => {
  const saved = persistCfgRawWithStrategySlices({
    v: 1,
    bot: {
      manualStrategy: "SUPERTREND_ELITE",
      eliteStMinAdx: 22,
      intradayGateSmcIct: true,
    },
    byStrategy: {
      SR_INTRADAY: { manualStrategy: "SR_INTRADAY", intradayGateSmcIct: true },
    },
  });
  saved.bot.manualStrategy = "SR_INTRADAY";
  const hydrated = hydrateCfgRawForEngine(saved);
  assert.equal(hydrated.bot.manualStrategy, "SR_INTRADAY");
  assert.equal(hydrated.bot.intradayGateSmcIct, true);
  assert.equal(hydrated.bot.eliteStMinAdx, undefined);
  assert.equal(hydrated.byStrategy.SUPERTREND_ELITE.eliteStMinAdx, 22);
});

test("legacy flat cfg_raw seeds byStrategy on first persist", () => {
  const legacy = {
    v: 1,
    bot: {
      manualStrategy: "SUPERTREND_ELITE",
      eliteStRequireHtf4hAlign: true,
      intradayGateSmcIct: true,
    },
  };
  const seeded = ensureByStrategyFromLegacy(legacy);
  assert.ok(seeded.byStrategy.SUPERTREND_ELITE);
  assert.equal(seeded.byStrategy.SUPERTREND_ELITE.intradayGateSmcIct, undefined);
});

test("getStrategySlice returns saved slice without active bot pollution", () => {
  const saved = persistCfgRawWithStrategySlices({
    v: 1,
    bot: { manualStrategy: "SUPERTREND_ELITE", eliteStMinAdx: 18 },
  });
  const slice = getStrategySlice(saved, "SUPERTREND_ELITE");
  assert.equal(slice?.eliteStMinAdx, 18);
});

test("materializeStrategyCfgRawForSave applies ETH LIQ preset over stale hold/BE", async () => {
  const { materializeStrategyCfgRawForSave } = await import("./strategyConfigSlices.js");
  const raw = await materializeStrategyCfgRawForSave({
    v: 1,
    bot: {
      manualStrategy: "SR_INTRADAY",
      symbol: "ETHUSDT",
      timeframe: "15m",
      intradayGateLiquidity: true,
      intradayGateFib: false,
      intradayGateVp: false,
      intradayGateOrderFlow: false,
      intradayGateHtfRegime: false,
      intradayGateSmcIct: false,
      intradayLiqMaxHoldBars: 0,
      intradayLiqBreakevenAfterPartial: false,
      trailOnlyAfterTp2Fill: true,
      intradayLiqMinReclaimBodyRatio: 0,
    },
  });
  assert.equal(raw.bot.intradayLiqMaxHoldBars, 48);
  assert.equal(raw.bot.intradayLiqBreakevenAfterPartial, false);
  assert.equal(raw.bot.trailOnlyAfterTp2Fill, false);
  assert.equal(raw.bot.intradayLiqMinReclaimBodyRatio, 0.4);
});

test("materializeStrategyCfgRawForSave preserves explicit ETH LIQ overrides", async () => {
  const { materializeStrategyCfgRawForSave } = await import("./strategyConfigSlices.js");
  const raw = await materializeStrategyCfgRawForSave({
    v: 1,
    bot: {
      manualStrategy: "SR_INTRADAY",
      symbol: "ETHUSDT",
      timeframe: "15m",
      intradayGateLiquidity: true,
      intradayGateFib: false,
      intradayGateVp: false,
      intradayGateOrderFlow: false,
      intradayGateHtfRegime: false,
      intradayLiqRequireHtfAlign: false,
      intradayLiqMaxTpRr: 3,
      intradayLiqMinReclaimBodyRatio: 0.5,
      intradayLiqMinRr: 2,
      intradayLiqMaxHoldBars: 36,
    },
  });
  assert.equal(raw.bot.intradayLiqRequireHtfAlign, false);
  assert.equal(raw.bot.intradayLiqMaxTpRr, 3);
  assert.equal(raw.bot.intradayLiqMinReclaimBodyRatio, 0.5);
  assert.equal(raw.bot.intradayLiqMinRr, 2);
  assert.equal(raw.bot.intradayLiqMaxHoldBars, 36);
});

test("materializeStrategyCfgRawForSave repairs leaked SMC gate on a one-sided LIQ config", async () => {
  const { materializeStrategyCfgRawForSave } = await import("./strategyConfigSlices.js");
  // UI race: LIQ preset tuning applied, but the live SMC gate flags leaked through.
  const raw = await materializeStrategyCfgRawForSave({
    v: 1,
    bot: {
      manualStrategy: "SR_INTRADAY",
      symbol: "BNBUSDT",
      timeframe: "15m",
      intradayLiqPlaybook: "LIQ_CORE",
      intradayLiqDaySituationBias: "buy_breakdown",
      intradayLiqMitigationEntry: true,
      intradayLiqRequireDisplacementV2: true,
      intradayGateLiquidity: false,
      intradayGateSmcIct: true,
      intradaySmcIctMode: true,
    },
  });
  assert.equal(raw.bot.intradayGateLiquidity, true);
  assert.equal(raw.bot.intradayGateSmcIct, false);
  assert.equal(raw.bot.intradaySmcIctMode, false);
  assert.equal(raw.bot.intradayLiqDaySituationBias, "buy_breakdown");
});

test("materializeStrategyCfgRawForSave leaves a genuine SMC/ICT config untouched", async () => {
  const { materializeStrategyCfgRawForSave } = await import("./strategyConfigSlices.js");
  const raw = await materializeStrategyCfgRawForSave({
    v: 1,
    bot: {
      manualStrategy: "SR_INTRADAY",
      symbol: "BNBUSDT",
      timeframe: "15m",
      intradayGateLiquidity: false,
      intradayGateSmcIct: true,
      intradaySmcIctMode: true,
      intradaySmcMinScore: 6,
    },
  });
  assert.equal(raw.bot.intradayGateSmcIct, true);
  assert.equal(raw.bot.intradayGateLiquidity, false);
});
