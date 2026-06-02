import test from "node:test";
import assert from "node:assert/strict";
import { buildSmcBrackets, resolveSmcTp2Level } from "./smcBrackets.js";
import { nearestInternalLiquidityTarget } from "./marketStructure.js";

const candles = [{ high: 102, low: 98, close: 100 }];
const setup = { wick: 97, opposing: 105, reclaimIdx: 0 };

test("buildSmcBrackets — SMC min R:R wins over liquidity min R:R", () => {
  const base = {
    intradaySmcSlMode: "sweep",
    intradayLiqPartialFrac: 0.5,
    intradaySmcMaxTpRr: 4,
  };
  const loose = buildSmcBrackets("BUY", 100, setup, candles, 0, {
    ...base,
    intradayLiqMinRr: 99,
    intradaySmcMinRr: 0,
  });
  const strict = buildSmcBrackets("BUY", 100, setup, candles, 0, {
    ...base,
    intradayLiqMinRr: 0,
    intradaySmcMinRr: 99,
  });
  assert.ok(loose, "liquidity min R:R must not filter SMC brackets");
  assert.equal(strict, null, "SMC min R:R must filter low-R:R brackets");
});

test("resolveSmcTp2Level — internal mode prefers swing over opposing", () => {
  const tp = resolveSmcTp2Level("BUY", 100, 120, 108, { intradaySmcTp2Mode: "internal" });
  assert.equal(tp, 108);
  const fallback = resolveSmcTp2Level("BUY", 100, 120, null, { intradaySmcTp2Mode: "internal" });
  assert.equal(fallback, 120);
});
