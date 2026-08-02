import assert from "node:assert/strict";
import test from "node:test";
import { buildMicrostructureSnapshot } from "./microstructureSnapshot.js";
import { recordOpenInterestSample, oiDeltaPctFromHistory } from "./openInterestHistory.js";
import { intelligenceCache } from "../../intelligence/index.js";

test("buildMicrostructureSnapshot reads OI from openInterestCollector .usdt field", () => {
  const sym = "BTCUSDT";
  intelligenceCache.openInterest = {
    [sym]: { usdt: 1_234_567_890, change4hPct: 0.1, change24hPct: -0.2, longShortRatio: 1.05 },
  };
  const snap = buildMicrostructureSnapshot(sym, { nowMs: Date.now() });
  assert.equal(snap.oi, 1_234_567_890);
  assert.ok(snap.oi > 0);
});

test("oiDeltaPctFromHistory needs poll span before reporting delta", () => {
  const sym = "ETHUSDT";
  const t0 = Date.now() - 120_000;
  recordOpenInterestSample(sym, 100_000, t0);
  recordOpenInterestSample(sym, 99_000, Date.now());
  assert.equal(oiDeltaPctFromHistory(sym, 60_000), null);
  recordOpenInterestSample(sym, 98_000, Date.now() - 55_000);
  const d = oiDeltaPctFromHistory(sym, 60_000);
  assert.ok(d != null && d < 0);
});
