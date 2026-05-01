import test from "node:test";
import assert from "node:assert/strict";
import {
  INSTANCE_FIELD_KEYS,
  PRIMARY_SIGNAL_TYPES,
  buildSignalBrainBlocks,
  extractInstanceConfig,
  isInstanceFieldKey,
  mergeInstanceIntoCfgRaw,
  resolvePrimarySignalType,
  stripInstanceFieldsFromCfgRaw,
} from "./strategyInstanceSplit.js";

const SAMPLE_FLAT = {
  // operational (instance) fields
  symbol: "BTCUSDT",
  timeframe: "1m",
  symbolMode: "SINGLE",
  marketMode: "FUTURES",
  riskPerTrade: 0.01,
  riskPerTradeUnit: "PCT",
  maxDailyLoss: 0.05,
  maxDailyLossUnit: "PCT",
  allowedBudgetInputMode: "FIXED",
  allowedBudgetUsdt: 2000,
  allowedBudgetWalletPct: null,
  capitalAllotmentCompoundPnlUi: false,
  universe: { mode: "SINGLE", pinnedSymbols: ["BTCUSDT"] },

  // signal-brain fields
  strategyMode: "AUTO",
  manualStrategy: null,
  aiThreshold: 0.6,
  supertrendPeriod: 10,
  supertrendMultiplier: 3,
  supertrendWilderAtr: true,
  supertrendSpotAuto: false,
  supertrendFuturesAuto: true,
  supertrendFuturesFixedSlPct: 1.5,
  supertrendFuturesFixedTpPct: 3,
  supertrendFuturesEntryOpenStyle: "LIMIT",
  supertrendFuturesMaxEntrySlippagePct: 0.1,
  supertrendFuturesMaxSignalLagMs: 500,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  trailBufferMode: "ATR",
  trailBufferRate: 0.002,
  trailOpenFeeRate: 0.0002,
  trailCloseFeeRate: 0.0002,
  futuresLeverageMode: "FIXED",
  futuresLeverage: 3,
  signalStrengthGatesTrades: true,
  signalStrengthOpenMin: 0.5,
  marketDecision: { regimeFilterEnabled: true },
};

test("INSTANCE_FIELD_KEYS contains the canonical operational keys", () => {
  for (const k of [
    "symbol",
    "timeframe",
    "symbolMode",
    "marketMode",
    "riskPerTrade",
    "maxDailyLoss",
    "allowedBudgetInputMode",
    "allowedBudgetUsdt",
    "allowedBudgetWalletPct",
    "capitalAllotmentCompoundPnlUi",
    "universe",
  ]) {
    assert.equal(isInstanceFieldKey(k), true, `missing ${k}`);
  }
  // signal-brain fields must NOT be flagged as instance-side
  for (const k of [
    "supertrendPeriod",
    "aiThreshold",
    "futuresLeverage",
    "trailBufferRate",
    "marketDecision",
  ]) {
    assert.equal(isInstanceFieldKey(k), false, `wrongly flagged ${k}`);
  }
});

test("PRIMARY_SIGNAL_TYPES enumerates allowed values", () => {
  assert.deepEqual(
    [...PRIMARY_SIGNAL_TYPES].sort(),
    ["EMA_CROSS", "MANUAL", "RSI", "SUPERTREND", "SURF_PULSE_ML"],
  );
});

test("resolvePrimarySignalType: defaults to SUPERTREND", () => {
  assert.equal(resolvePrimarySignalType({}), "SUPERTREND");
  assert.equal(resolvePrimarySignalType({ strategyMode: "AUTO" }), "SUPERTREND");
});

test("resolvePrimarySignalType: MANUAL routes by manualStrategy", () => {
  assert.equal(
    resolvePrimarySignalType({ strategyMode: "MANUAL", manualStrategy: "SURF_PULSE_ML" }),
    "SURF_PULSE_ML",
  );
  assert.equal(
    resolvePrimarySignalType({ strategyMode: "MANUAL", manualStrategy: "EMA_CROSS" }),
    "EMA_CROSS",
  );
  assert.equal(
    resolvePrimarySignalType({ strategyMode: "MANUAL", manualStrategy: "ANYTHING" }),
    "MANUAL",
  );
});

test("buildSignalBrainBlocks: populates only the active signal block", () => {
  const blocks = buildSignalBrainBlocks(SAMPLE_FLAT);
  assert.equal(blocks.primary_signal_type, "SUPERTREND");
  assert.ok(blocks.cfg_supertrend, "supertrend block should be set");
  assert.equal(blocks.cfg_surf_pulse, null);
  assert.equal(blocks.cfg_ema_cross, null);
  assert.equal(blocks.cfg_rsi, null);
  assert.equal(blocks.cfg_supertrend.period, 10);
  assert.equal(blocks.cfg_supertrend.multiplier, 3);
  assert.equal(blocks.cfg_exit.fixedSlPct, 1.5);
  assert.equal(blocks.cfg_exit.fixedTpPct, 3);
  assert.equal(blocks.cfg_leverage.mode, "FIXED");
  assert.equal(blocks.cfg_leverage.value, 3);
  assert.equal(blocks.cfg_signal_gates.strengthOpenMin, 0.5);
  assert.deepEqual(blocks.cfg_mde, { regimeFilterEnabled: true });
});

test("extractInstanceConfig: pulls operational fields", () => {
  const inst = extractInstanceConfig(SAMPLE_FLAT);
  assert.equal(inst.inst_symbol, "BTCUSDT");
  assert.equal(inst.inst_timeframe, "1m");
  assert.equal(inst.inst_market_mode, "FUTURES");
  assert.equal(inst.inst_risk_per_trade, 0.01);
  assert.equal(inst.inst_max_daily_loss, 0.05);
  assert.equal(inst.inst_capital_mode, "FIXED");
  assert.equal(inst.inst_capital_usdt, 2000);
  assert.deepEqual(inst.inst_universe, { mode: "SINGLE", pinnedSymbols: ["BTCUSDT"] });
});

test("stripInstanceFieldsFromCfgRaw: removes operational keys", () => {
  const stripped = stripInstanceFieldsFromCfgRaw(SAMPLE_FLAT);
  for (const k of INSTANCE_FIELD_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(stripped, k),
      false,
      `expected ${k} to be removed`,
    );
  }
  // signal-brain fields must remain intact
  assert.equal(stripped.supertrendPeriod, 10);
  assert.equal(stripped.aiThreshold, 0.6);
  assert.equal(stripped.futuresLeverage, 3);
});

test("stripInstanceFieldsFromCfgRaw: handles `{ bot }` envelope", () => {
  const wrapped = { v: 1, bot: { ...SAMPLE_FLAT }, tradingFormDefaults: {} };
  const stripped = stripInstanceFieldsFromCfgRaw(wrapped);
  assert.equal(stripped.v, 1);
  assert.equal(stripped.tradingFormDefaults != null, true);
  for (const k of INSTANCE_FIELD_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(stripped.bot, k),
      false,
      `bot.${k} should be removed`,
    );
  }
  assert.equal(stripped.bot.supertrendPeriod, 10);
});

test("mergeInstanceIntoCfgRaw: instance overrides win, signal brain preserved", () => {
  const stripped = stripInstanceFieldsFromCfgRaw(SAMPLE_FLAT);
  const inst = extractInstanceConfig({
    ...SAMPLE_FLAT,
    symbol: "ETHUSDT",
    riskPerTrade: 0.02,
    allowedBudgetUsdt: 5000,
  });
  const merged = mergeInstanceIntoCfgRaw(stripped, inst);
  assert.equal(merged.symbol, "ETHUSDT");
  assert.equal(merged.timeframe, "1m");
  assert.equal(merged.riskPerTrade, 0.02);
  assert.equal(merged.allowedBudgetUsdt, 5000);
  // signal-brain unchanged
  assert.equal(merged.supertrendPeriod, 10);
  assert.equal(merged.aiThreshold, 0.6);
  assert.equal(merged.futuresLeverage, 3);
});

test("mergeInstanceIntoCfgRaw: null instance value falls back to strategy default", () => {
  const stripped = stripInstanceFieldsFromCfgRaw(SAMPLE_FLAT);
  // simulate strategy keeping a default symbol while instance leaves it null
  const fakeStrategyWithDefaults = { ...stripped, symbol: "BTCUSDT" };
  const inst = extractInstanceConfig({}); // all nulls
  const merged = mergeInstanceIntoCfgRaw(fakeStrategyWithDefaults, inst);
  assert.equal(merged.symbol, "BTCUSDT");
});

test("mergeInstanceIntoCfgRaw: works with `{ bot }` envelope", () => {
  const stripped = stripInstanceFieldsFromCfgRaw({ v: 1, bot: { ...SAMPLE_FLAT } });
  const inst = extractInstanceConfig({ ...SAMPLE_FLAT, symbol: "SOLUSDT" });
  const merged = mergeInstanceIntoCfgRaw(stripped, inst);
  assert.equal(merged.bot.symbol, "SOLUSDT");
  assert.equal(merged.bot.supertrendPeriod, 10);
});

test("end-to-end: same strategy reused across two instance overlays", () => {
  // Save: strip instance fields out of strategy
  const strategyCfg = stripInstanceFieldsFromCfgRaw(SAMPLE_FLAT);

  // Two instances on the SAME strategy with different symbols/capital
  const instA = extractInstanceConfig({
    ...SAMPLE_FLAT,
    symbol: "BTCUSDT",
    allowedBudgetUsdt: 2000,
  });
  const instB = extractInstanceConfig({
    ...SAMPLE_FLAT,
    symbol: "ETHUSDT",
    allowedBudgetUsdt: 1000,
  });

  const botA = mergeInstanceIntoCfgRaw(strategyCfg, instA);
  const botB = mergeInstanceIntoCfgRaw(strategyCfg, instB);

  // Different operational fields per instance
  assert.equal(botA.symbol, "BTCUSDT");
  assert.equal(botB.symbol, "ETHUSDT");
  assert.equal(botA.allowedBudgetUsdt, 2000);
  assert.equal(botB.allowedBudgetUsdt, 1000);

  // Same signal brain across both
  assert.equal(botA.supertrendPeriod, botB.supertrendPeriod);
  assert.equal(botA.aiThreshold, botB.aiThreshold);
  assert.equal(botA.futuresLeverage, botB.futuresLeverage);
  assert.deepEqual(botA.marketDecision, botB.marketDecision);
});
