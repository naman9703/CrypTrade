import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVolumeProfile,
  valueAreaFromNodes,
  detectVolumeProfileSetup,
  volumeProfileBrackets,
  pathToNextHvn,
  inLvnZone,
  applyVolumeProfileGates,
  resolveVolumeProfileGateMode,
  fullBarClearsVaLevel,
  priorTrendMovePct,
  passesVpRegimeImmunity,
} from "./volumeProfile.js";

function makeCandles(n, base = 100, vol = 1000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const close = base + Math.sin(i / 8) * 2;
    out.push({
      ts: i * 900_000,
      open: close - 0.1,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: vol * (0.8 + (i % 5) * 0.1),
    });
  }
  return out;
}

test("buildVolumeProfile returns POC/VAH/VAL and nodes", () => {
  const candles = makeCandles(120);
  const vp = buildVolumeProfile(candles, candles.length - 1, { lookback: 96, bins: 40 });
  assert.ok(vp);
  assert.ok(vp.poc > 0);
  assert.ok(vp.vah >= vp.poc);
  assert.ok(vp.val <= vp.poc);
  assert.ok(vp.hvn.length >= 1);
});

test("volumeProfileBrackets computes RR from HVN targets", () => {
  const candles = makeCandles(120);
  const vp = buildVolumeProfile(candles, candles.length - 1);
  const price = candles.at(-1).close;
  const br = volumeProfileBrackets(price, "BUY", vp, { minRR: 0.5 });
  assert.ok(br.slPct > 0);
  assert.ok(br.tpPct > 0);
  assert.ok(br.rr > 0);
});

test("detectVolumeProfileSetup finds vah_breakout on volume spike", () => {
  const candles = makeCandles(120);
  const i = candles.length - 1;
  const vp = buildVolumeProfile(candles, i, { lookback: 96 });
  candles[i - 1] = { ...candles[i - 1], close: vp.vah * 0.998, open: vp.vah * 0.997 };
  candles[i] = {
    ...candles[i],
    open: vp.vah * 0.999,
    close: vp.vah * 1.006,
    high: vp.vah * 1.008,
    low: vp.vah * 0.998,
    volume: 50000,
  };
  for (let j = i - 20; j < i; j++) candles[j].volume = 5000;
  const setup = detectVolumeProfileSetup(candles, i, "BUY", vp, {
    vpBreakoutMinVolRatio: 1.2,
    vpBreakoutMinPathPct: 0.004,
    vpMinCloseBeyondPct: 0.001,
    vpMinBreakoutCloseStrength: 0.5,
  });
  assert.equal(setup?.setup, "vah_breakout");
});

test("fullBarClearsVaLevel rejects wick-only breakout", () => {
  const vp = { vah: 100, val: 90 };
  const wickOnly = { open: 99, close: 101, high: 102, low: 99.5, volume: 1, ts: 0 };
  assert.equal(fullBarClearsVaLevel(wickOnly, "BUY", vp, 0.0025), false);
  const clean = { open: 100.5, close: 101, high: 101.5, low: 100.4, volume: 1, ts: 0 };
  assert.equal(fullBarClearsVaLevel(clean, "BUY", vp, 0.0025), true);
});

test("passesVpRegimeImmunity blocks late chase breakdown but allows wick breakout", () => {
  const vp = { vah: 100, val: 90, hvn: [{ price: 105, volume: 1 }], lvnZones: [] };
  const bar = { open: 89.5, close: 88.5, high: 90, low: 88, volume: 1, ts: 0 };
  const candles = Array.from({ length: 20 }, (_, i) => ({
    ts: i * 900_000,
    open: 100 - i * 0.8,
    high: 100 - i * 0.7,
    low: 99 - i * 0.8,
    close: 99 - i * 0.8,
    volume: 1000,
  }));
  candles[19] = bar;
  const pre = {
    htfSep: Array(20).fill(0.005),
    htfUp: Array(20).fill(false),
    htfDown: Array(20).fill(true),
  };
  const opts = { vpRegimeImmunity: true, vpMaxPriorTrendPct: 0.012 };
  assert.equal(
    passesVpRegimeImmunity(candles, 19, "SELL", "val_breakdown", vp, pre, { distPct: 0.02 }, opts),
    false,
  );
  const flat = Array.from({ length: 20 }, (_, i) => ({
    ts: i * 900_000,
    open: 100.4,
    high: 100.6,
    low: 100.2,
    close: 100.5,
    volume: 1000,
  }));
  flat[19] = { open: 100.6, close: 101.2, high: 101.8, low: 100, volume: 1, ts: 19 * 900_000 };
  const preUp = {
    htfSep: Array(20).fill(0.0036),
    htfUp: Array(20).fill(true),
    htfDown: Array(20).fill(false),
  };
  assert.equal(
    passesVpRegimeImmunity(flat, 19, "BUY", "vah_breakout", vp, preUp, { distPct: 0.025 }, opts),
    true,
  );
});

test("priorTrendMovePct measures signed drift", () => {
  const candles = makeCandles(30, 100);
  candles[29].close = 110;
  assert.ok(priorTrendMovePct(candles, 29, 16) > 0);
});

test("value area expands contiguously from POC", () => {
  const nodes = [
    { price: 98, volume: 10 },
    { price: 99, volume: 20 },
    { price: 100, volume: 100 },
    { price: 101, volume: 30 },
    { price: 102, volume: 15 },
  ];
  const totalVol = nodes.reduce((s, n) => s + n.volume, 0);
  const va = valueAreaFromNodes(nodes, totalVol, 0.7);
  assert.equal(va.poc, 100);
  assert.equal(va.val, 100);
  assert.equal(va.vah, 101);
});

test("strict gates block long at VAH", () => {
  const candles = makeCandles(100);
  const vp = buildVolumeProfile(candles, candles.length - 1);
  const i = candles.length - 1;
  candles[i].close = vp.vah;
  const gates = applyVolumeProfileGates(candles, i, "BUY", vp, {
    volumeProfileEnabled: true,
    volumeProfileGatesEnabled: true,
    vpCeilingTolPct: 0.005,
  });
  assert.equal(gates.allow, false);
  assert.equal(resolveVolumeProfileGateMode({ volumeProfileGatesEnabled: true }), "strict");
});

test("soft gates allow trade at POC", () => {
  const candles = makeCandles(20);
  const i = candles.length - 1;
  const vp = {
    poc: 100,
    vah: 103,
    val: 97,
    hvn: [{ price: 97, volume: 1 }, { price: 103, volume: 1 }],
    lvnZones: [],
    hi: 105,
    lo: 95,
  };
  candles[i].close = 100;
  const gates = applyVolumeProfileGates(candles, i, "BUY", vp, {
    volumeProfileEnabled: true,
    volumeProfileSoftGates: true,
    vpMinRR: 0.5,
    vpMinRunPct: 0.001,
  });
  assert.equal(gates.gateMode, "soft");
  assert.equal(gates.allow, true);
});

test("pathToNextHvn returns distance above price", () => {
  const candles = makeCandles(100);
  const vp = buildVolumeProfile(candles, candles.length - 1);
  const path = pathToNextHvn(candles.at(-1).close, "BUY", vp);
  assert.ok(path);
  assert.ok(path.distPct >= 0);
});

test("inLvnZone detects price inside merged LVN", () => {
  const vp = {
    lvnZones: [{ low: 99, high: 101 }],
  };
  assert.ok(inLvnZone(100, vp.lvnZones));
  assert.equal(inLvnZone(105, vp.lvnZones), null);
});
