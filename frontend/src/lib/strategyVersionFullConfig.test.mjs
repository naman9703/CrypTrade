import test from "node:test";
import assert from "node:assert/strict";
import { buildStrategyVersionConfigSections } from "./strategyVersionFullConfig.ts";

test("buildStrategyVersionConfigSections includes intraday gates for SR_INTRADAY", () => {
  const sections = buildStrategyVersionConfigSections({
    id: "v1",
    strategyId: "s1",
    versionNumber: 1,
    label: null,
    promotedFrom: null,
    primarySignalType: "MANUAL",
    blocks: {},
    cfgSymbol: null,
    cfgTimeframe: null,
    cfgStPeriod: 10,
    cfgStMultiplier: 3,
    cfgCapitalMode: null,
    cfgCapitalFixedUsdt: null,
    cfgCapitalPct: null,
    cfgTrailingMode: null,
    cfgMarketMode: null,
    cfgRaw: {
      bot: {
        strategyMode: "MANUAL",
        manualStrategy: "SR_INTRADAY",
        supertrendPeriod: 10,
        supertrendMultiplier: 3,
        intradayGateLiquidity: true,
        intradayGateSmcIct: true,
        intradayGateOrderFlow: false,
        intelligenceGateEnabled: true,
        intelligenceGateManualStrategies: true,
        marketDecision: { enabled: false },
      },
    },
    createdAt: "",
  });
  const titles = sections.map((s) => s.title);
  assert.ok(titles.includes("Intraday gates"));
  const intraday = sections.find((s) => s.title === "Intraday gates");
  const liq = intraday?.rows.find((r) => r.label === "Liquidity");
  assert.equal(liq?.value, "On");
  assert.equal(liq?.enabled, true);
});

test("buildStrategyVersionConfigSections omits intraday gates for SUPERTREND_ELITE", () => {
  const sections = buildStrategyVersionConfigSections({
    id: "v2",
    strategyId: "s1",
    versionNumber: 1,
    label: null,
    promotedFrom: null,
    primarySignalType: "MANUAL",
    blocks: {},
    cfgSymbol: null,
    cfgTimeframe: null,
    cfgStPeriod: 10,
    cfgStMultiplier: 3,
    cfgCapitalMode: null,
    cfgCapitalFixedUsdt: null,
    cfgCapitalPct: null,
    cfgTrailingMode: null,
    cfgMarketMode: null,
    cfgRaw: {
      bot: {
        strategyMode: "MANUAL",
        manualStrategy: "SUPERTREND_ELITE",
        eliteStRequireHtf4hAlign: true,
        intradayGateSmcIct: true,
        intradayGateLiquidity: true,
      },
    },
    createdAt: "",
  });
  const titles = sections.map((s) => s.title);
  assert.ok(!titles.includes("Intraday gates"));
  assert.ok(titles.includes("Elite settings"));
});
