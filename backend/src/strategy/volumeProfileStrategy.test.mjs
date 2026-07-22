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

test("FREQ preset yields more candidates than Tier-A on same candles", async () => {
  const { VOLUME_PROFILE_15M, VOLUME_PROFILE_FREQ_15M, resolveVolumeProfileFreqPreset } = await import(
    "./presets/volumeProfileOptimized.js",
  );
  const candles = makeCandles(1200);
  const tierA = selectVolumeProfilePicks(candles, { ...VOLUME_PROFILE_15M, vpRequireHtfAlign: false });
  const freq = selectVolumeProfilePicks(candles, VOLUME_PROFILE_FREQ_15M);
  assert.ok(freq.candidateCount >= tierA.candidateCount);
  assert.equal(VOLUME_PROFILE_FREQ_15M.vpMaxTradesPerDay, 2);
  assert.equal(VOLUME_PROFILE_FREQ_15M.vpTierAOnly, false);
  assert.equal(VOLUME_PROFILE_FREQ_15M.vpRequireHtfAlign, true);
  assert.equal(resolveVolumeProfileFreqPreset("ETHUSDT").vpAllowedSetups.includes("val_breakdown"), true);
  assert.equal(resolveVolumeProfileFreqPreset("BTCUSDT").vpAllowedSetups.includes("vah_breakout"), true);
  assert.equal(resolveVolumeProfileFreqPreset("BNBUSDT").vpAllowedSetups.includes("val_breakdown"), true);
  assert.equal(resolveVolumeProfileFreqPreset("SOLUSDT").vpAllowedSetups.includes("va_rejection"), true);
});
