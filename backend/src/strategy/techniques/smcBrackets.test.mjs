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

test("buildSmcBrackets — pd_array SL uses FVG far edge when no OB", () => {
  const fvg = { top: 101, bottom: 99.5 };
  const br = buildSmcBrackets(
    "BUY",
    100.5,
    { wick: 98, opposing: 110, reclaimIdx: 0, fvg },
    candles,
    0,
    {
      intradaySmcSlMode: "pd_array",
      intradaySmcMinRr: 0,
      intradayLiqPartialFrac: 0.5,
      slBufferPct: 0.001,
    },
  );
  assert.ok(br);
  // BUY SL just below FVG bottom — ignore deeper sweep wick (guide OB/FVG edge).
  assert.ok(br.slPrice < 99.5 && br.slPrice > 98.5, `expected SL near FVG bottom, got ${br.slPrice}`);
  assert.equal(br.smcSlMode, "pd_array");
});

test("buildSmcBrackets — pd_array SL prefers OB far edge", () => {
  const ob = { top: 101, bottom: 99 };
  const br = buildSmcBrackets(
    "SELL",
    100,
    { wick: 105, opposing: 90, reclaimIdx: 0, ob },
    candles,
    0,
    {
      intradaySmcSlMode: "pd_array",
      intradaySmcMinRr: 0,
      intradayLiqPartialFrac: 0.5,
      slBufferPct: 0.001,
    },
  );
  assert.ok(br);
  // SELL: SL just above OB top — do not use farther sweep wick 105.
  assert.ok(br.slPrice > 101 && br.slPrice < 103, `expected SL near OB top, got ${br.slPrice}`);
});
