import test from "node:test";
import assert from "node:assert/strict";
import { resolveMaxHoldBars } from "./runner.js";

const LIQ_SOLO = {
  manualStrategy: "SR_INTRADAY",
  intradayGateLiquidity: true,
  intradayGateSmcIct: false,
};

test("resolveMaxHoldBars: liq solo ignores SMC hold fallback", () => {
  assert.equal(
    resolveMaxHoldBars({
      ...LIQ_SOLO,
      intradaySmcMaxHoldBars: 48,
    }),
    0,
  );
});

test("resolveMaxHoldBars: liq solo honors explicit 0", () => {
  assert.equal(
    resolveMaxHoldBars({
      ...LIQ_SOLO,
      intradayLiqMaxHoldBars: 0,
      intradaySmcMaxHoldBars: 96,
    }),
    0,
  );
});

test("resolveMaxHoldBars: liq solo honors explicit positive hold", () => {
  assert.equal(
    resolveMaxHoldBars({
      ...LIQ_SOLO,
      intradayLiqMaxHoldBars: 96,
      intradaySmcMaxHoldBars: 48,
    }),
    96,
  );
});

test("resolveMaxHoldBars: smc engine still uses smc hold", () => {
  assert.equal(
    resolveMaxHoldBars({
      manualStrategy: "SR_INTRADAY",
      intradayGateLiquidity: false,
      intradayGateSmcIct: true,
      intradaySmcMaxHoldBars: 24,
    }),
    24,
  );
});
