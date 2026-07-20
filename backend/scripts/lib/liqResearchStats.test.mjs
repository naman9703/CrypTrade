import test from "node:test";
import assert from "node:assert/strict";
import {
  pearson,
  spearman,
  mutualInformation,
  bucketExpectancy,
  stabilityScore,
  evidenceChecklist,
  analyzeFeature,
} from "../lib/liqResearchStats.js";

function mkRows(n, fn) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(fn(i));
  return out;
}

test("spearman detects monotonic nonlinear relationship pearson misses", () => {
  const xs = Array.from({ length: 50 }, (_, i) => i);
  const ys = xs.map((x) => x * x);
  const p = pearson(xs, ys);
  const s = spearman(xs, ys);
  assert.ok(Math.abs(s) > 0.95);
  assert.ok(Math.abs(p) < Math.abs(s));
});

test("bucketExpectancy captures threshold effect", () => {
  const rows = mkRows(100, (i) => {
    const x = i;
    const y = x < 30 ? -0.8 : x < 60 ? 0.1 : 1.2;
    return { feat: x, rMultiple: y, win: y > 0 ? 1 : 0, symbol: "BTCUSDT", entryYear: 2024 };
  });
  const b = bucketExpectancy(rows, "feat", "rMultiple", 10);
  assert.ok(b);
  assert.ok((b.spread ?? 0) > 0.5);
});

test("analyzeFeature returns evidence checklist", () => {
  const rows = mkRows(80, (i) => ({
    cont_score: i,
    rMultiple: i / 80,
    win: i > 40 ? 1 : 0,
    symbol: i % 2 === 0 ? "BTCUSDT" : "BNBUSDT",
    entryYear: 2023 + (i % 3),
    marketState_regime: "RANGE",
  }));
  const r = analyzeFeature(rows, "cont_score");
  assert.ok(r.bucket);
  assert.ok(r.evidence);
  assert.ok(["USE", "PARTIAL", "REVIEW", "IGNORE"].includes(r.evidence.recommendation));
});

test("stabilityScore counts sign-consistent groups", () => {
  const s = stabilityScore(
    {
      BTC: { spearman: 0.2 },
      BNB: { spearman: 0.15 },
      ETH: { spearman: -0.1 },
    },
    0.18,
  );
  assert.equal(s.consistent, 2);
  assert.ok(s.ratio > 0.5);
});
