import assert from "node:assert/strict";
import test from "node:test";
import { buildScalpMrSeries, SCALP_MR_WARMUP } from "./scalpMr.js";

function mkCandles(n, base = 100) {
  const out = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const ts = Date.UTC(2025, 6, 1) + i * 300_000;
    const o = p;
    const c = p + (i % 7 === 0 ? -1.2 : 0.15);
    const h = Math.max(o, c) + 0.4;
    const l = Math.min(o, c) - 0.4;
    p = c;
    out.push({ ts, open: o, high: h, low: l, close: c, volume: 1000 + (i % 5) * 200 });
  }
  return out;
}

test("buildScalpMrSeries returns array aligned to candles", () => {
  const candles = mkCandles(200);
  const { series } = buildScalpMrSeries(candles, { killzoneEnabled: false, maxAdx: 50 });
  assert.equal(series.length, candles.length);
  for (let i = 0; i < SCALP_MR_WARMUP; i++) assert.equal(series[i], null);
});

test("single-TP brackets omit partial when usePartialTp is false", () => {
  const candles = mkCandles(200);
  const { series } = buildScalpMrSeries(candles, {
    killzoneEnabled: false,
    maxAdx: 50,
    usePartialTp: false,
    rsiBuyMax: 99,
    rsiSellMin: 1,
    minVolVsAvg: 0.5,
    minAtrPct: 0,
    maxAtrPct: 99,
    requireConfirmCandle: false,
    minReclaimAtr: 0,
  });
  const sig = series.find(Boolean);
  if (sig?.brackets) {
    assert.equal(sig.brackets.partialTp, false);
    assert.ok(sig.brackets.tpPrice > 0);
  }
});
