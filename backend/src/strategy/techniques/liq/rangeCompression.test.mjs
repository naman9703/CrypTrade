import test from "node:test";
import assert from "node:assert/strict";
import { liqRangeCompressionAt, passesLiqMarketActivation } from "./marketState.js";

function buildSeries(opts = {}) {
  const days = opts.days ?? 120;
  const compressLast14 = opts.compressLast14 === true;
  const out = [];
  const dayMs = 86_400_000;
  const start = Date.UTC(2025, 0, 1);
  for (let d = 0; d < days; d++) {
    for (let b = 0; b < 96; b++) {
      const ts = start + d * dayMs + b * 900_000;
      const wide = !compressLast14 || d < days - 14;
      const half = wide ? 5 : 0.2;
      const mid = 100;
      out.push({
        ts,
        open: mid,
        high: mid + half,
        low: mid - half,
        close: mid,
        volume: 1,
      });
    }
  }
  return out;
}

test("liqRangeCompressionAt — causal, lower in compressed regime", () => {
  const wide = buildSeries({ days: 120, compressLast14: false });
  const compressed = buildSeries({ days: 120, compressLast14: true });
  const rWide = liqRangeCompressionAt(wide, wide.length - 1);
  const rComp = liqRangeCompressionAt(compressed, compressed.length - 1);
  assert.ok(rWide != null && rWide > 0.9, `wide ratio expected ~1, got ${rWide}`);
  assert.ok(rComp != null && rComp < 0.5, `compressed ratio expected <<1, got ${rComp}`);
});

test("passesLiqMarketActivation — rangeCompressionMin stands down", () => {
  const compressed = buildSeries({ days: 120, compressLast14: true });
  const idx = compressed.length - 1;
  assert.equal(passesLiqMarketActivation(compressed, idx, null, {}), true);
  assert.equal(
    passesLiqMarketActivation(compressed, idx, null, { intradayLiqRangeCompressionMin: 0.75 }),
    false,
  );
  const wide = buildSeries({ days: 120, compressLast14: false });
  assert.equal(
    passesLiqMarketActivation(wide, wide.length - 1, null, { intradayLiqRangeCompressionMin: 0.75 }),
    true,
  );
});

test("passesLiqMarketActivation — maxAdx stands down", () => {
  const candles = buildSeries({ days: 120, compressLast14: false });
  const idx = candles.length - 1;
  const series = new Array(candles.length).fill({ regime: "RANGE", adx: 55, atrPct: 0.01 });
  assert.equal(
    passesLiqMarketActivation(candles, idx, null, { _regimeSeries: series }),
    true,
  );
  assert.equal(
    passesLiqMarketActivation(candles, idx, null, {
      _regimeSeries: series,
      intradayLiqMaxAdx: 50,
    }),
    false,
  );
  const mild = new Array(candles.length).fill({ regime: "RANGE", adx: 40, atrPct: 0.01 });
  assert.equal(
    passesLiqMarketActivation(candles, idx, null, {
      _regimeSeries: mild,
      intradayLiqMaxAdx: 50,
    }),
    true,
  );
});

test("liqIntradayPadFromMs — 150d before fromMs", async () => {
  const { liqIntradayPadFromMs, needsLiqIntradayPad, LIQ_INTRADAY_PAD_DAYS } = await import(
    "./marketState.js"
  );
  const from = Date.UTC(2026, 0, 1);
  assert.equal(liqIntradayPadFromMs(from), from - LIQ_INTRADAY_PAD_DAYS * 86_400_000);
  assert.equal(needsLiqIntradayPad({ intradayGateLiquidity: true }), true);
  assert.equal(needsLiqIntradayPad({ intradayLiqRangeCompressionMin: 0.75 }), true);
  assert.equal(needsLiqIntradayPad({}), false);
});
