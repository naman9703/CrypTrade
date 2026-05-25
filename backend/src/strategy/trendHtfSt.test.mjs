import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTrendHtfStSignalSeries,
  buildTrendHtfStQualityOpts,
  TREND_HTF_ST_MAX_ENTRY_RANGE_ATR,
} from "./trendHtfSt.js";

function trendingCandles(n = 200) {
  const out = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p *= 1.002 + (Math.random() - 0.5) * 0.001;
    const o = p * 0.999;
    const c = p;
    out.push({
      ts: 1_700_000_000_000 + i * 900_000,
      open: o,
      high: Math.max(o, c) * 1.001,
      low: Math.min(o, c) * 0.999,
      close: c,
      volume: 1000 + i,
    });
  }
  return out;
}

describe("TREND_HTF_ST", () => {
  it("default opts: spike filter on, no strict ADX/sep chop", () => {
    const o = buildTrendHtfStQualityOpts({});
    assert.equal(o.maxEntryRangeAtr, TREND_HTF_ST_MAX_ENTRY_RANGE_ATR);
    assert.equal(o.minAdx, 0);
    assert.equal(o.minHtfSep, 0.0005);
  });

  it("strict mode enables ADX and sep gates", () => {
    const o = buildTrendHtfStQualityOpts({ trendHtfStQualityFilter: true });
    assert.equal(o.minAdx, 20);
    assert.equal(o.minHtfSep, 0.0012);
  });

  it("spike filter reduces signals vs unfiltered", () => {
    const candles = trendingCandles(300);
    const noRegime = { trendHtfStRegimeGate: false };
    const open = buildTrendHtfStSignalSeries(candles, {
      maxEntryRangeAtr: 0,
      minHtfSep: 0,
      minAdx: 0,
      regimeCfg: noRegime,
    });
    const filtered = buildTrendHtfStSignalSeries(candles, {
      maxEntryRangeAtr: 2,
      minHtfSep: 0,
      minAdx: 0,
      regimeCfg: noRegime,
    });
    assert.ok(filtered.filter(Boolean).length <= open.filter(Boolean).length);
  });
});
