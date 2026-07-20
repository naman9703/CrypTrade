import assert from "node:assert/strict";
import test from "node:test";
import { applyVpVacuumRetestRouting } from "./volumeProfileStrategy.js";

function bar(ts, o, h, l, c) {
  return { ts, open: o, high: h, low: l, close: c, volume: 1000 };
}

test("vacuum retest: suppresses immediate far-path breakout and fills on VAH reclaim", () => {
  const vah = 100;
  // idx10: breakout candle (close above VAH), idx12: retest touch + reclaim
  const candles = [];
  for (let i = 0; i < 20; i++) {
    candles.push(bar(i * 900_000, 99, 101, 98, 99.5));
  }
  candles[10] = bar(10 * 900_000, 100.1, 103, 100.0, 102.5); // break
  candles[12] = bar(12 * 900_000, 100.2, 101.5, 99.9, 100.8); // retest + close above

  const sig = {
    action: "BUY",
    reason: "vp_vah_breakout",
    setup: "vah_breakout",
    vpSetup: "vah_breakout",
    score: 12,
    tier: "A",
    path: { distPct: 0.035, kind: "hvn" },
    vacuumLevel: vah,
    vpBrackets: { slPct: 0.012, tpPct: 0.03, rr: 2.5 },
  };
  const candidates = [
    { idx: 10, day: 0, score: 12, tier: "A", sig },
  ];

  const out = applyVpVacuumRetestRouting(candles, candidates, {
    vpVacuumEntryMode: "retest",
    vpVacuumPathPct: 0.02,
    vpVacuumRetestBars: 8,
    vpVacuumRetestMaxTpPct: 0.015,
  });

  assert.equal(out.some((c) => c.idx === 10), false, "immediate vacuum entry suppressed");
  const fill = out.find((c) => c.idx === 12);
  assert.ok(fill, "retest fill present");
  assert.equal(fill.sig.vacuumEntry, "retest");
  assert.ok(fill.sig.vpBrackets.tpPct <= 0.015, "TP capped on retest");
});

test("structured path (<2%) still enters immediately", () => {
  const candles = [];
  for (let i = 0; i < 15; i++) candles.push(bar(i * 900_000, 100, 101, 99, 100.5));
  candles[8] = bar(8 * 900_000, 100.2, 102, 100.1, 101.8);
  const sig = {
    action: "BUY",
    reason: "vp_vah_breakout",
    setup: "vah_breakout",
    score: 12,
    tier: "A",
    path: { distPct: 0.015, kind: "hvn" },
    vacuumLevel: 100,
    vpBrackets: { slPct: 0.012, tpPct: 0.02, rr: 1.6 },
  };
  const out = applyVpVacuumRetestRouting(
    candles,
    [{ idx: 8, day: 0, score: 12, tier: "A", sig }],
    { vpVacuumEntryMode: "retest", vpVacuumPathPct: 0.02 },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].idx, 8);
  assert.equal(out[0].sig.vacuumEntry, undefined);
});
