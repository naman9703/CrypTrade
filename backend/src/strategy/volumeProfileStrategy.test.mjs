import test from "node:test";
import assert from "node:assert/strict";
import {
  selectVolumeProfilePicks,
  evaluateVolumeProfileBar,
  precomputeVolumeProfile,
} from "./volumeProfileStrategy.js";

function makeCandles(n, base = 100) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = base + Math.sin(i / 12) * 3 + (i % 40) * 0.02;
    out.push({
      ts: 1_700_000_000_000 + i * 900_000,
      open: close - 0.2,
      high: close + 0.8,
      low: close - 0.8,
      close,
      volume: 5000 + (i % 7) * 800,
    });
  }
  return out;
}

test("selectVolumeProfilePicks returns series length match", () => {
  const candles = makeCandles(900);
  const { series, pickedCount } = selectVolumeProfilePicks(candles, {
    vpLookbackBars: 192,
    requireVpSetup: false,
    vpRequireHtfAlign: false,
    vpMinScore: 5,
  });
  assert.equal(series.length, candles.length);
  assert.ok(pickedCount >= 0);
});

test("evaluateVolumeProfileBar null during warmup", () => {
  const candles = makeCandles(100);
  const sig = evaluateVolumeProfileBar(candles, 50, { vpLookbackBars: 192, requireVpSetup: false });
  assert.equal(sig, null);
});
