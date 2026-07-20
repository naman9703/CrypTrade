import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePortfolioPositionSizing,
  resolvePortfolioUnitStart,
  resolvePortfolioUnitSizingMode,
} from "./portfolioPositionSizing.js";

test("resolvePortfolioPositionSizing defaults to equal-slice full margin", () => {
  assert.equal(resolvePortfolioPositionSizing({}), "EQUAL_SLICE_FULL_MARGIN");
  assert.equal(
    resolvePortfolioPositionSizing({ portfolioPositionSizing: "EQUAL_SLICE_RISK_AT_SL" }),
    "EQUAL_SLICE_RISK_AT_SL",
  );
});

test("resolvePortfolioUnitStart: slice vs total capital", () => {
  assert.equal(
    resolvePortfolioUnitStart({
      startingUsdt: 100,
      coinCount: 3,
      mode: "EQUAL_SLICE_FULL_MARGIN",
    }),
    100 / 3,
  );
  assert.equal(
    resolvePortfolioUnitStart({
      startingUsdt: 100,
      coinCount: 3,
      mode: "TOTAL_CAPITAL_RISK_AT_SL",
    }),
    100,
  );
});

test("resolvePortfolioUnitSizingMode maps portfolio modes", () => {
  assert.equal(resolvePortfolioUnitSizingMode("EQUAL_SLICE_FULL_MARGIN"), "FULL_EQUITY_MARGIN");
  assert.equal(resolvePortfolioUnitSizingMode("EQUAL_SLICE_RISK_AT_SL"), "RISK_AT_SL");
  assert.equal(resolvePortfolioUnitSizingMode("TOTAL_CAPITAL_RISK_AT_SL"), "RISK_AT_SL");
});
