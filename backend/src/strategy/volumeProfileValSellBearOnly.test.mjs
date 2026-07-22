import test from "node:test";
import assert from "node:assert/strict";
import { passesVpValSellMacroFilter } from "./volumeProfileStrategy.js";

test("vpValSellBearOnly blocks VAL short in macroBull", () => {
  const pre = { macroAboveEma20d: [true], macroEma5dSlope: [0], macroPrior20d: [0.05] };
  assert.equal(passesVpValSellMacroFilter(pre, 0, "SELL", "val_breakdown", { vpValSellBearOnly: true }), false);
});

test("vpValSellBearOnly allows VAL short in macroBear", () => {
  const pre = { macroAboveEma20d: [false], macroEma5dSlope: [-0.01], macroPrior20d: [-0.08] };
  assert.equal(passesVpValSellMacroFilter(pre, 0, "SELL", "val_breakdown", { vpValSellBearOnly: true }), true);
});

test("vpValSellBearOnly does not touch va_rejection", () => {
  const pre = { macroAboveEma20d: [true], macroEma5dSlope: [0], macroPrior20d: [0.05] };
  assert.equal(passesVpValSellMacroFilter(pre, 0, "SELL", "va_rejection", { vpValSellBearOnly: true }), true);
});

test("vpValSellRequirePrior60dBear blocks when prior60d above floor", () => {
  const pre = {
    macroAboveEma20d: [false],
    macroEma5dSlope: [-0.01],
    macroPrior20d: [-0.08],
    macroPrior60d: [0.02],
  };
  assert.equal(
    passesVpValSellMacroFilter(pre, 0, "SELL", "val_breakdown", {
      vpValSellRequirePrior60dBear: true,
      vpValSellPrior60dBearPct: -0.05,
    }),
    false,
  );
});

test("vpValSellRequirePrior60dBear allows deep bear prior60d", () => {
  const pre = {
    macroAboveEma20d: [true],
    macroEma5dSlope: [0.01],
    macroPrior20d: [0.03],
    macroPrior60d: [-0.12],
  };
  assert.equal(
    passesVpValSellMacroFilter(pre, 0, "SELL", "val_breakdown", {
      vpValSellRequirePrior60dBear: true,
      vpValSellPrior60dBearPct: -0.05,
    }),
    true,
  );
});

test("vpValSellRequirePrior60dBear fail-closed when prior60 missing", () => {
  const pre = {
    macroAboveEma20d: [false],
    macroEma5dSlope: [-0.01],
    macroPrior20d: [-0.08],
    macroPrior60d: [null],
  };
  assert.equal(
    passesVpValSellMacroFilter(pre, 0, "SELL", "val_breakdown", {
      vpValSellRequirePrior60dBear: true,
      vpValSellPrior60dBearPct: -0.05,
    }),
    false,
  );
});

test("vpValSellBlockFlatPrior60 fail-closed when prior60 missing", () => {
  const pre = { macroPrior60d: [null], macroPrior20d: [-0.02] };
  assert.equal(
    passesVpValSellMacroFilter(pre, 0, "SELL", "val_breakdown", {
      vpValSellBlockFlatPrior60: true,
    }),
    false,
  );
});

test("precomputeVolumeProfile leaves macroPrior60d null until lookback", async () => {
  const { precomputeVolumeProfile } = await import("./volumeProfileStrategy.js");
  const bars = 200;
  const candles = Array.from({ length: bars }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 15 * 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100 + i * 0.01,
    volume: 1000,
  }));
  const pre = precomputeVolumeProfile(candles);
  assert.equal(pre.macroPrior60d[0], null);
  assert.equal(pre.macroPrior60d[bars - 1], null); // 200 << 5760 for 15m
});
