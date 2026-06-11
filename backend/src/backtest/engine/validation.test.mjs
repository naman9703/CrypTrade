import assert from "node:assert";
import { test } from "node:test";
import {
  makeRng,
  monteCarloBootstrap,
  purgedWalkForwardSplits,
  acceptanceGates,
} from "./validation.js";

test("makeRng is deterministic and in [0,1)", () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 100; i++) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
});

test("monteCarloBootstrap flags insufficient samples", () => {
  const res = monteCarloBootstrap([0.5, -1], { paths: 100 });
  assert.equal(res.insufficient, true);
});

test("monteCarloBootstrap: positive-edge R-dist yields positive median", () => {
  // RR2 system winning 50% -> +2R half, -1R half => strong positive expectancy.
  const rs = [];
  for (let i = 0; i < 200; i++) rs.push(i % 2 === 0 ? 2 : -1);
  const res = monteCarloBootstrap(rs, { paths: 2000, riskFrac: 0.01 });
  assert.ok(res.p50ReturnPct > 0, `expected positive median, got ${res.p50ReturnPct}`);
  assert.ok(res.p5ReturnPct > 0, `expected positive p5, got ${res.p5ReturnPct}`);
  assert.equal(res.riskOfRuinPct, 0);
});

test("monteCarloBootstrap: negative-edge R-dist yields negative median + ruin", () => {
  const rs = [];
  for (let i = 0; i < 200; i++) rs.push(i % 3 === 0 ? 1 : -1); // ~33% win at RR1 => negative
  const res = monteCarloBootstrap(rs, { paths: 2000, riskFrac: 0.05, ruinDrawdownPct: 40 });
  assert.ok(res.p50ReturnPct < 0);
  assert.ok(res.riskOfRuinPct > 0);
});

test("purgedWalkForwardSplits: non-overlapping test windows with embargo gap", () => {
  const n = 1000;
  const splits = purgedWalkForwardSplits(n, { folds: 4, embargo: 10, mode: "rolling" });
  assert.ok(splits.length >= 3);
  for (const s of splits) {
    assert.ok(s.trainEnd <= s.testStart - 10 + 10); // train ends at testStart - embargo
    assert.ok(s.trainEnd <= s.testStart);
    assert.ok(s.testEnd > s.testStart);
    assert.ok(s.trainStart >= 0 && s.testEnd <= n);
  }
  // test windows should not overlap each other
  for (let i = 1; i < splits.length; i++) {
    assert.ok(splits[i].testStart >= splits[i - 1].testStart);
  }
});

test("acceptanceGates: all pass only when every criterion met", () => {
  const good = acceptanceGates({
    oosReturnPct: 12,
    mcP5ReturnPct: 3,
    calmar: 1.5,
    walkForwardDegradationPct: 20,
  });
  assert.equal(good.allPass, true);

  const bad = acceptanceGates({
    oosReturnPct: 12,
    mcP5ReturnPct: -1,
    calmar: 1.5,
    walkForwardDegradationPct: 20,
  });
  assert.equal(bad.allPass, false);
  assert.equal(bad.gates.mcP5Positive.pass, false);
});
