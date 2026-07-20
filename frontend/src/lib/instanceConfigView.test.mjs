import test from "node:test";
import assert from "node:assert/strict";
import {
  activeInstanceIdForMode,
  applyInstanceOperationalToBot,
  buildBotViewFromInstanceSnapshot,
  draftForInstance,
  hasDraftForInstance,
} from "./instanceConfigView.ts";

test("activeInstanceIdForMode prefers mode binding, falls back to selected tab", () => {
  const base = { activeInstanceByMode: { paper: "inst-a", demo_api: null, testnet: null, live: null } };
  assert.equal(activeInstanceIdForMode(base, "paper"), "inst-a");
  assert.equal(
    activeInstanceIdForMode(
      {
        ...base,
        activeInstanceByMode: { ...base.activeInstanceByMode, paper: null },
        selectedInstanceId: "inst-b",
      },
      "paper",
    ),
    "inst-b",
  );
});

test("activeInstanceIdForMode prefers selected tab when bound instance is stale during switch", () => {
  const s = {
    activeInstanceByMode: { paper: "inst-a", demo_api: null, testnet: null, live: null },
    selectedInstanceId: "inst-b",
    mainView: "instance",
    instanceConfigLoadingId: null,
  };
  assert.equal(activeInstanceIdForMode(s, "paper"), "inst-b");
});

test("draftForInstance is isolated per instance id", () => {
  const map = {
    "inst-a": { manualStrategy: "VOLUME_PROFILE" },
    "inst-b": { riskPerTrade: 2 },
  };
  assert.deepEqual(draftForInstance(map, "inst-a"), { manualStrategy: "VOLUME_PROFILE" });
  assert.deepEqual(draftForInstance(map, "inst-b"), { riskPerTrade: 2 });
  assert.deepEqual(draftForInstance(map, null), {});
  assert.equal(hasDraftForInstance(map, "inst-a"), true);
  assert.equal(hasDraftForInstance(map, null), false);
});

test("buildBotViewFromInstanceSnapshot merges strategy version + operational fields", () => {
  const s = {
    activeInstanceByMode: { paper: "inst-1", demo_api: null, testnet: null, live: null },
    instancesByMode: {
      paper: [
        {
          id: "inst-1",
          strategyId: "strat-1",
          strategyVersionId: "ver-1",
          operational: { symbol: "BNBUSDT", timeframe: "15m", riskPerTrade: 1.5 },
        },
      ],
    },
    strategiesByMode: {
      paper: [
        {
          id: "strat-1",
          latestVersion: {
            id: "ver-1",
            strategyId: "strat-1",
            versionNumber: 1,
            cfgRaw: {
              manualStrategy: "VOLUME_PROFILE",
              bot: { manualStrategy: "VOLUME_PROFILE", vpPlaybook: "FREQ" },
            },
          },
        },
      ],
    },
    versionsByStrategyId: {},
  };
  const view = buildBotViewFromInstanceSnapshot(s, "paper", "inst-1");
  assert.ok(view);
  assert.equal(view.manualStrategy, "VOLUME_PROFILE");
  assert.equal(view.vpPlaybook, "FREQ");
  assert.equal(view.symbol, "BNBUSDT");
  assert.equal(view.timeframe, "15m");
  assert.equal(view.riskPerTrade, 1.5);
});

test("applyInstanceOperationalToBot only overrides present operational keys", () => {
  const out = applyInstanceOperationalToBot({ manualStrategy: "X", symbol: "ETHUSDT" }, {
    id: "x",
    operational: { symbol: "BNBUSDT", riskPerTrade: 2 },
  });
  assert.equal(out.symbol, "BNBUSDT");
  assert.equal(out.riskPerTrade, 2);
  assert.equal(out.manualStrategy, "X");
});
