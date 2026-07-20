import test from "node:test";
import assert from "node:assert/strict";
import {
  pickBotFromStrategyVersion,
  strategyVersionMdeEnabled,
  strategyVersionPrimaryLabel,
  strategyVersionStLine,
  strategyVersionTrailingLabel,
} from "./strategyVersionDisplay.ts";

const emptyBlocks = {
  supertrend: null,
  surfPulse: null,
  emaCross: null,
  rsi: null,
  ai: null,
  entry: null,
  exit: null,
  leverage: null,
  mde: null,
  signalGates: null,
};

test("pickBotFromStrategyVersion reads nested bot subtree", () => {
  const bot = pickBotFromStrategyVersion({
    id: "v1",
    strategyId: "s1",
    versionNumber: 1,
    label: null,
    promotedFrom: null,
    primarySignalType: "SUPERTREND",
    blocks: emptyBlocks,
    cfgSymbol: null,
    cfgTimeframe: null,
    cfgStPeriod: null,
    cfgStMultiplier: null,
    cfgCapitalMode: null,
    cfgCapitalFixedUsdt: null,
    cfgCapitalPct: null,
    cfgTrailingMode: null,
    cfgMarketMode: null,
    cfgRaw: { bot: { supertrendPeriod: 12, marketDecision: { enabled: true } } },
    createdAt: "",
  });
  assert.equal(bot.supertrendPeriod, 12);
  assert.equal(strategyVersionMdeEnabled({ cfgRaw: { bot } }), true);
});

test("strategyVersionStLine falls back to cfgRaw bot fields", () => {
  const v = {
    cfgStPeriod: null,
    cfgStMultiplier: null,
    cfgRaw: { bot: { supertrendPeriod: 10, supertrendMultiplier: 3 } },
  };
  assert.equal(strategyVersionStLine(v), "10 × 3");
});

test("strategyVersionTrailingLabel prefers futuresTrailingStopMode", () => {
  const v = {
    cfgTrailingMode: null,
    cfgRaw: { bot: { futuresTrailingStopMode: "FEE_TIERS" } },
  };
  assert.equal(strategyVersionTrailingLabel(v), "FEE_TIERS");
});

test("strategyVersionPrimaryLabel respects manual strategy key", () => {
  const v = {
    primarySignalType: "MANUAL",
    cfgRaw: { bot: { strategyMode: "MANUAL", manualStrategy: "HTF_RSI" } },
  };
  assert.equal(strategyVersionPrimaryLabel(v), "HTF_RSI");
});
