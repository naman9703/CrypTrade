import test from "node:test";
import assert from "node:assert/strict";
import { flattenLiqFeatures, tradeToFeatureRow, rowsToCsv } from "./flattenFeatures.js";

test("flattenLiqFeatures exposes stable research aliases", () => {
  const flat = flattenLiqFeatures({
    marketState: { regime: "RANGE", daySituation: "breakdown", confidence: 0.7, adx: 18 },
    sessionNarrative: "london_sweep",
    level: { type: "pdl", importance: 0.9, touches: 2 },
    sweep: { sweepVelocityAtr: 0.12, attemptCount: 2, absorptionProxy: 0.3 },
    displacement: { impulseAtr: 1.4, bodyEfficiency: 0.6 },
    continuation: { distanceToOpposingR: 2.1, score: 14, passed: true, expansionState: "expanding" },
    scoreV2: { total: 72, components: { sweepQuality: 18, continuationRoom: 14 } },
    reclaimIdx: 10,
    sweepStartIdx: 5,
    entryBarIdx: 12,
  });
  assert.equal(flat.marketState_regime, "RANGE");
  assert.equal(flat.cont_opposingR, 2.1);
  assert.equal(flat.scoreV2_total, 72);
  assert.equal(flat.sweep_velocityAtr, 0.12);
});

test("tradeToFeatureRow and rowsToCsv round-trip", () => {
  const row = tradeToFeatureRow(
    {
      tradeNumber: 1,
      entryTs: 1000,
      direction: "BUY",
      netPnl: 12,
      equityAtEntry: 1000,
      mfePct: 0.02,
      maePct: -0.01,
      barsHeld: 8,
      exitReason: "tp1_partial",
      liqContext: {
        levelType: "pdl",
        rr: 2.5,
        liqQuality: 0.8,
        features: { scoreV2: { total: 65 } },
      },
    },
    { symbol: "BTCUSDT", window: "OOS", preset: "V1" },
  );
  assert.equal(row.win, 1);
  assert.equal(row.symbol, "BTCUSDT");
  assert.equal(row.scoreV2_total, 65);
  const csv = rowsToCsv([row]);
  assert.ok(csv.includes("BTCUSDT"));
  assert.ok(csv.includes("pdl"));
});
