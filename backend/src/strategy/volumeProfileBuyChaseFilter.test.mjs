import assert from "node:assert/strict";
import test from "node:test";
import { passesVpBuyChaseFilter } from "./volumeProfileStrategy.js";

test("passesVpBuyChaseFilter — off by default", () => {
  const pre = { macroPrior5d: [0.12] };
  assert.equal(passesVpBuyChaseFilter(pre, 0, "BUY", "vah_breakout", {}), true);
});

test("passesVpBuyChaseFilter — blocks VAH BUY after sharp 5d rally", () => {
  const pre = { macroPrior5d: [0.12] };
  const opts = { vpBuyChaseFilter: true, vpBuyChaseMaxPrior5dPct: 0.08 };
  assert.equal(passesVpBuyChaseFilter(pre, 0, "BUY", "vah_breakout", opts), false);
});

test("passesVpBuyChaseFilter — allows washout / mild bounce VAH", () => {
  const pre = { macroPrior5d: [0.04] };
  const opts = { vpBuyChaseFilter: true, vpBuyChaseMaxPrior5dPct: 0.08 };
  assert.equal(passesVpBuyChaseFilter(pre, 0, "BUY", "vah_breakout", opts), true);
});

test("passesVpBuyChaseFilter — ignores non-VAH and SELL", () => {
  const pre = { macroPrior5d: [0.2] };
  const opts = { vpBuyChaseFilter: true, vpBuyChaseMaxPrior5dPct: 0.08 };
  assert.equal(passesVpBuyChaseFilter(pre, 0, "SELL", "val_breakdown", opts), true);
  assert.equal(passesVpBuyChaseFilter(pre, 0, "BUY", "poc_bounce", opts), true);
});

test("passesVpBuyChaseFilter — non-bull-only blocks weak macro", () => {
  const pre = { macroPrior5d: [0.12], macroPrior60d: [0.01] };
  const opts = {
    vpBuyChaseFilter: true,
    vpBuyChaseMaxPrior5dPct: 0.08,
    vpBuyChaseNonBullOnly: true,
    vpBuyChaseBullPrior60dPct: 0.05,
  };
  assert.equal(passesVpBuyChaseFilter(pre, 0, "BUY", "vah_breakout", opts), false);
});

test("passesVpBuyChaseFilter — non-bull-only allows strong bull macro", () => {
  const pre = { macroPrior5d: [0.12], macroPrior60d: [0.09] };
  const opts = {
    vpBuyChaseFilter: true,
    vpBuyChaseMaxPrior5dPct: 0.08,
    vpBuyChaseNonBullOnly: true,
    vpBuyChaseBullPrior60dPct: 0.05,
  };
  assert.equal(passesVpBuyChaseFilter(pre, 0, "BUY", "vah_breakout", opts), true);
});
