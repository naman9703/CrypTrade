import assert from "node:assert/strict";
import test from "node:test";
import { createVpNoveltyMonitor, decideVpNovelty } from "./vpNoveltyMonitor.js";
import { DEFAULT_BTC_BLEED } from "./vpNoveltyLive.js";

test("BTC bleed cells abstain — must not silently attach on ETH FREQ", () => {
  const mon = createVpNoveltyMonitor({
    bleedCells: DEFAULT_BTC_BLEED,
    preparedCells: ["BUY|va_rejection|bull_trend|structured"],
    unknownPolicy: "trade",
  });
  // ETH edge that BTC matrix treats as bleed
  const vacValBear = decideVpNovelty(mon, "SELL|val_breakdown|bear_trend|vacuum");
  assert.equal(vacValBear.allow, false);
  assert.equal(vacValBear.policy, "bleed_cell");
});
