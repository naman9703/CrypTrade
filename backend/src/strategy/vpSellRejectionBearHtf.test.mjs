import test from "node:test";
import assert from "node:assert/strict";
import { passesVpSellRejectionBearHtfFilter } from "./volumeProfileStrategy.js";

function preBear({ htfSep, prior60 = -0.2, prior20 = -0.1 } = {}) {
  return {
    macroPrior60d: [prior60],
    macroPrior20d: [prior20],
    macroAboveEma20d: [false],
    macroEma5dSlope: [0],
    htfSep: [htfSep],
  };
}

test("passesVpSellRejectionBearHtfFilter — off by default", () => {
  assert.equal(
    passesVpSellRejectionBearHtfFilter(preBear({ htfSep: 0.001 }), 0, "SELL", "va_rejection", {}),
    true,
  );
});

test("passesVpSellRejectionBearHtfFilter — abstains shallow HTF in bear_trend", () => {
  assert.equal(
    passesVpSellRejectionBearHtfFilter(preBear({ htfSep: 0.002 }), 0, "SELL", "va_rejection", {
      vpRejectionSellBearMinHtfSepPct: 0.0035,
    }),
    false,
  );
});

test("passesVpSellRejectionBearHtfFilter — allows deep HTF in bear_trend", () => {
  assert.equal(
    passesVpSellRejectionBearHtfFilter(preBear({ htfSep: 0.01 }), 0, "SELL", "va_rejection", {
      vpRejectionSellBearMinHtfSepPct: 0.0035,
    }),
    true,
  );
});

test("passesVpSellRejectionBearHtfFilter — ignores non-bear macros", () => {
  const bull = {
    macroPrior60d: [0.12],
    macroPrior20d: [0.05],
    macroAboveEma20d: [true],
    macroEma5dSlope: [0.001],
    htfSep: [0.001],
  };
  assert.equal(
    passesVpSellRejectionBearHtfFilter(bull, 0, "SELL", "va_rejection", {
      vpRejectionSellBearMinHtfSepPct: 0.0035,
    }),
    true,
  );
});

test("passesVpSellRejectionBearHtfFilter — BUY / other setups pass", () => {
  assert.equal(
    passesVpSellRejectionBearHtfFilter(preBear({ htfSep: 0.001 }), 0, "BUY", "va_rejection", {
      vpRejectionSellBearMinHtfSepPct: 0.0035,
    }),
    true,
  );
  assert.equal(
    passesVpSellRejectionBearHtfFilter(preBear({ htfSep: 0.001 }), 0, "SELL", "val_breakdown", {
      vpRejectionSellBearMinHtfSepPct: 0.0035,
    }),
    true,
  );
});
