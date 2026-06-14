import test from "node:test";
import assert from "node:assert/strict";
import {
  patchValueAcked,
  pruneDraftBotPatchAcked,
  noteStrategySaveWsAckGuard,
  composeViewBotFromLiveAndDraft,
} from "./configPatchInFlight.ts";

test("patchValueAcked compares numbers with epsilon", () => {
  assert.equal(patchValueAcked(0.004, 0.004), true);
  assert.equal(patchValueAcked(0.002, 0.004), false);
});

test("pruneDraftBotPatchAcked removes acked keys only", () => {
  const draft = {
    supertrendFuturesFixedSlPct: 0.004,
    supertrendFuturesFixedTpPct: 0.015,
    manualStrategy: "SUPERTREND_ELITE",
  };
  const patch = { supertrendFuturesFixedSlPct: 0.004 };
  const server = { supertrendFuturesFixedSlPct: 0.004, supertrendFuturesFixedTpPct: 0.015 };
  const next = pruneDraftBotPatchAcked(draft, patch, server);
  assert.equal(next.supertrendFuturesFixedSlPct, undefined);
  assert.equal(next.supertrendFuturesFixedTpPct, 0.015);
  assert.equal(next.manualStrategy, "SUPERTREND_ELITE");
});

test("composeViewBotFromLiveAndDraft: draft wins over strategy-save WS ack guard", () => {
  noteStrategySaveWsAckGuard({ manualStrategy: "SUPERTREND_ELITE", strategyMode: "MANUAL" });
  const view = composeViewBotFromLiveAndDraft(
    { manualStrategy: "SUPERTREND_ELITE", strategyMode: "MANUAL" },
    { manualStrategy: "SAFE_INTRADAY" },
  );
  assert.equal(view.manualStrategy, "SAFE_INTRADAY");
  assert.equal(view.strategyMode, "MANUAL");
});
