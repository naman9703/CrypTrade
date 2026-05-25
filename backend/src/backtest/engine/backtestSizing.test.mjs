import test from "node:test";
import assert from "node:assert/strict";
import { computeEntryQty } from "./runner.js";
import { resolveCostModel } from "./costModel.js";

test("FULL_EQUITY_MARGIN uses equity as margin on futures", () => {
  const cm = resolveCostModel({ marketMode: "FUTURES", futuresLeverage: 50 });
  const equity = 110;
  const entry = 100_000;
  const sl = entry * 0.992;
  const qty = computeEntryQty({
    equity,
    entryFill: entry,
    sl,
    cfg: { backtestPositionSizing: "FULL_EQUITY_MARGIN" },
    cm,
    isFutures: true,
  });
  const margin = (qty * entry) / cm.leverage;
  assert.ok(Math.abs(margin - equity) < 0.01, `margin ${margin} vs equity ${equity}`);
});

test("RISK_AT_SL uses fraction of equity at stop", () => {
  const cm = resolveCostModel({ marketMode: "FUTURES", futuresLeverage: 50 });
  const equity = 1000;
  const entry = 100_000;
  const sl = entry * 0.992;
  const qty = computeEntryQty({
    equity,
    entryFill: entry,
    sl,
    cfg: { riskPerTrade: 5, riskPerTradeUnit: "PCT_EQUITY" },
    cm,
    isFutures: true,
  });
  const margin = (qty * entry) / cm.leverage;
  assert.ok(margin < equity * 0.2, `margin ${margin} should be well below full equity`);
});
