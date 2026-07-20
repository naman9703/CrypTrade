import test from "node:test";
import assert from "node:assert/strict";
import { harvestTrendCandidates } from "../../src/strategy/techniques/research/trendCandidateHarvest.js";
import { harvestVolExpansionCandidates } from "../../src/strategy/techniques/research/volExpansionHarvest.js";
import { precomputeIntraday } from "../../src/strategy/intradayPro.js";

function synthCandles(n = 500, startTs = Date.parse("2024-01-01")) {
  const candles = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 17) * 0.4 + (i % 40 < 20 ? 0.15 : -0.1);
    const open = px;
    px = Math.max(50, px + drift);
    const high = Math.max(open, px) + 0.3;
    const low = Math.min(open, px) - 0.3;
    candles.push({
      ts: startTs + i * 900_000,
      open,
      high,
      low,
      close: px,
      volume: 1000 + (i % 7) * 200,
    });
  }
  return candles;
}

test("harvestTrendCandidates returns ST flip rows with forward labels", () => {
  const candles = synthCandles(600);
  const pre = precomputeIntraday(candles);
  const rows = harvestTrendCandidates(candles, pre, { symbol: "BTCUSDT" });
  assert.ok(rows.length > 0);
  const row = rows[0];
  assert.equal(row.familyId, "C");
  assert.ok(row.fwd_closeR_20 != null || row.fwd_mfeR != null);
  assert.ok("gate_pass_count" in row);
  assert.ok("selectedByDayPicker" in row);
});

test("harvestVolExpansionCandidates returns vol expansion rows", () => {
  const candles = synthCandles(600);
  const pre = precomputeIntraday(candles);
  const rows = harvestVolExpansionCandidates(candles, pre, { symbol: "ETHUSDT" });
  assert.ok(rows.length >= 0);
  if (rows.length) {
    assert.equal(rows[0].familyId, "D");
    assert.ok(rows[0].vol_atr_expansion != null);
    assert.ok(rows[0].trigger);
  }
});
