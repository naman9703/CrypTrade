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
  isPriceNearVpStructure,
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
  const vp = buildVolumeProfile(candles, candles.length - 1, { mode: "rolling", lookback: 96, bins: 40 });
  assert.ok(vp);
  assert.ok(vp.poc > 0);
  assert.ok(vp.vah >= vp.poc);
  assert.ok(vp.val <= vp.poc);
  assert.ok(vp.hvn.length >= 1);
  assert.equal(vp.mode, "rolling");
});

test("session_utc developing profile stays inside UTC day", () => {
  const day0 = Date.parse("2026-03-10T00:00:00.000Z");
  const candles = [];
  for (let i = 0; i < 96 + 40; i++) {
    const ts = day0 - 96 * 900_000 + i * 900_000;
    const close = 100 + Math.sin(i / 8) * 2;
    candles.push({
      ts,
      open: close - 0.1,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1000 + (i % 7) * 50,
    });
  }
  const i = candles.length - 1;
  const vp = buildVolumeProfile(candles, i, { mode: "session_utc", bins: 40 });
  assert.ok(vp);
  assert.equal(vp.mode, "session_utc");
  assert.ok(vp.sessionStartMs > 0);
  assert.ok(vp.barCount <= 96);
  assert.ok(vp.priorSession?.poc > 0);
  assert.equal(typeof vp.nakedPocActive, "boolean");
});

test("composite_utc spans multiple UTC days", () => {
  const day0 = Date.parse("2026-03-10T00:00:00.000Z");
  const candles = [];
  for (let i = 0; i < 96 * 6; i++) {
    const ts = day0 - 96 * 5 * 900_000 + i * 900_000;
    const close = 100 + Math.sin(i / 10) * 3;
    candles.push({
      ts,
      open: close - 0.2,
      high: close + 0.6,
      low: close - 0.6,
      close,
      volume: 800 + (i % 11) * 40,
    });
  }
  const i = candles.length - 1;
  const vp = buildVolumeProfile(candles, i, { mode: "composite_utc", vpCompositeDays: 5, bins: 40 });
  assert.ok(vp);
  assert.equal(vp.mode, "composite_utc");
  assert.ok(vp.barCount > 96);
  assert.ok(vp.barCount <= 96 * 5 + 2);
  assert.ok(vp.poc > 0 && vp.vah >= vp.poc && vp.val <= vp.poc);
});

test("integer bins produce contiguous node prices", () => {
  const candles = makeCandles(80);
  const vp = buildVolumeProfile(candles, candles.length - 1, { mode: "rolling", lookback: 64, bins: 20 });
  assert.ok(vp.nodes.length >= 2);
  for (let i = 1; i < vp.nodes.length; i++) {
    assert.ok(vp.nodes[i].price > vp.nodes[i - 1].price);
  }
});

test("volumeProfileBrackets computes RR from HVN targets", () => {
  const candles = makeCandles(120);
  const vp = buildVolumeProfile(candles, candles.length - 1, { mode: "rolling", lookback: 96 });
  const price = candles.at(-1).close;
  const br = volumeProfileBrackets(price, "BUY", vp, { minRR: 0.5 });
  assert.ok(br.slPct > 0);
  assert.ok(br.tpPct > 0);
  assert.ok(br.rr > 0);
});

test("detectVolumeProfileSetup finds vah_breakout on volume spike", () => {
  const candles = makeCandles(120);
  const i = candles.length - 1;
  const vp = buildVolumeProfile(candles, i, { mode: "rolling", lookback: 96 });
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

test("session breakout uses prior-session VAH when present", () => {
  const candles = makeCandles(40, 100);
  const i = candles.length - 1;
  const vp = {
    poc: 100,
    vah: 100.5,
    val: 99.5,
    hvn: [{ price: 103, volume: 5 }, { price: 98, volume: 5 }],
    lvnZones: [],
    hi: 105,
    lo: 95,
    priorSession: { poc: 100, vah: 101, val: 99 },
  };
  candles[i - 1] = { ...candles[i - 1], close: 100.8, open: 100.7, high: 100.9, low: 100.6, volume: 1000 };
  candles[i] = {
    ...candles[i],
    open: 100.9,
    close: 101.4,
    high: 101.5,
    low: 100.85,
    volume: 20000,
  };
  for (let j = i - 20; j < i; j++) candles[j].volume = 1000;
  const setup = detectVolumeProfileSetup(candles, i, "BUY", vp, {
    vpBreakoutMinVolRatio: 1.2,
    vpBreakoutMinPathPct: 0.004,
    vpMinCloseBeyondPct: 0.001,
    vpMinBreakoutCloseStrength: 0.5,
    vpMinBreakoutBody: 0.4,
  });
  assert.equal(setup?.setup, "vah_breakout");
  assert.equal(setup?.meta?.levelSrc, "prior_session");
  assert.equal(setup?.meta?.vah, 101);
});

test("naked_poc setup fires at untested prior POC", () => {
  const vp = {
    poc: 100,
    vah: 102,
    val: 98,
    hvn: [{ price: 100, volume: 10 }],
    lvnZones: [],
    hi: 105,
    lo: 95,
    nakedPoc: 101,
    nakedPocActive: true,
    priorSession: { poc: 101, vah: 103, val: 99 },
  };
  const candles = makeCandles(30, 100);
  const i = candles.length - 1;
  candles[i] = {
    ...candles[i],
    open: 100.8,
    high: 101.05,
    low: 100.2,
    close: 100.4,
    volume: 8000,
  };
  for (let j = i - 20; j < i; j++) candles[j].volume = 1000;
  const setup = detectVolumeProfileSetup(candles, i, "BUY", vp, {
    vpMinWickRatio: 0.2,
    vpNakedPocMinVolRatio: 1.0,
  });
  assert.equal(setup?.setup, "naked_poc");
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
  const vp = buildVolumeProfile(candles, candles.length - 1, { mode: "rolling", lookback: 80 });
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
  const vp = buildVolumeProfile(candles, candles.length - 1, { mode: "rolling", lookback: 80 });
  assert.ok(vp);
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

test("isPriceNearVpStructure matches POC/VAH/VAL within tolerance", () => {
  const vp = { poc: 100, vah: 102, val: 98, hvn: [{ price: 101, volume: 10 }] };
  assert.equal(isPriceNearVpStructure(100.1, vp, 0.002), true);
  assert.equal(isPriceNearVpStructure(101.05, vp, 0.001), true);
  assert.equal(isPriceNearVpStructure(95, vp, 0.001), false);
});

test("va_rejection requires wick when configured", () => {
  const candles = makeCandles(40, 100);
  const i = candles.length - 1;
  const vp = {
    poc: 100,
    vah: 102,
    val: 98,
    hvn: [{ price: 100, volume: 10 }],
    lvnZones: [],
    hi: 105,
    lo: 95,
  };
  // Weak pierce: spike beyond VAH but almost no upper wick (close near high)
  candles[i] = {
    ...candles[i],
    open: 102.0,
    high: 102.15,
    low: 101.7,
    close: 101.95,
    volume: 20000,
  };
  for (let j = i - 20; j < i; j++) candles[j].volume = 1000;
  const weak = detectVolumeProfileSetup(candles, i, "SELL", vp, {
    vpRejectionMinVolRatio: 1.0,
    vpRejectionSpikePct: 0.001,
    vpRejectionMinWickRatio: 0.35,
  });
  assert.equal(weak, null);

  // Strong rejection: large upper wick, close into VA
  candles[i] = {
    ...candles[i],
    open: 101.2,
    high: 102.4,
    low: 100.3,
    close: 100.5,
    volume: 20000,
  };
  const strong = detectVolumeProfileSetup(candles, i, "SELL", vp, {
    vpRejectionMinVolRatio: 1.0,
    vpRejectionSpikePct: 0.001,
    vpRejectionMinWickRatio: 0.35,
  });
  assert.equal(strong?.setup, "va_rejection");
});

test("vah_breakout blocked when path exceeds vpBuyBreakoutMaxPathPct", () => {
  const candles = makeCandles(40, 100);
  const i = candles.length - 1;
  const vp = {
    poc: 100,
    vah: 101,
    val: 99,
    // Next HVN far → vacuum path
    hvn: [{ price: 105, volume: 5 }, { price: 98, volume: 5 }],
    lvnZones: [],
    hi: 106,
    lo: 97,
    priorSession: { poc: 100, vah: 101, val: 99 },
  };
  candles[i - 1] = { ...candles[i - 1], close: 100.8, open: 100.7, high: 100.9, low: 100.6, volume: 1000 };
  candles[i] = {
    ...candles[i],
    open: 100.9,
    close: 101.4,
    high: 101.5,
    low: 100.85,
    volume: 20000,
  };
  for (let j = i - 20; j < i; j++) candles[j].volume = 1000;
  const opts = {
    vpBreakoutMinVolRatio: 1.2,
    vpBreakoutMinPathPct: 0.004,
    vpMinCloseBeyondPct: 0.001,
    vpMinBreakoutCloseStrength: 0.5,
    vpMinBreakoutBody: 0.4,
  };
  assert.equal(detectVolumeProfileSetup(candles, i, "BUY", vp, opts)?.setup, "vah_breakout");
  assert.equal(
    detectVolumeProfileSetup(candles, i, "BUY", vp, { ...opts, vpBuyBreakoutMaxPathPct: 0.02 }),
    null,
  );
});

test("vacuum vah_breakout blocked after sharp 5d rally", () => {
  const candles = [];
  for (let j = 0; j < 600; j++) {
    const px = j < 480 ? 100 + j * 0.02 : 109.6 + (j - 480) * 0.05;
    candles.push({
      ts: j * 900_000,
      open: px - 0.1,
      high: px + 0.25,
      low: px - 0.2,
      close: px + 0.08,
      volume: 1000,
    });
  }
  const i = candles.length - 1;
  const vp = {
    poc: candles[i].close * 0.992,
    vah: candles[i].close * 0.996,
    val: candles[i].close * 0.985,
    hvn: [{ price: candles[i].close * 1.03, volume: 5 }, { price: candles[i].close * 0.98, volume: 5 }],
    lvnZones: [],
    hi: candles[i].close * 1.04,
    lo: candles[i].close * 0.96,
    priorSession: {
      poc: candles[i].close * 0.992,
      vah: candles[i].close * 0.996,
      val: candles[i].close * 0.985,
    },
  };
  candles[i - 1] = { ...candles[i - 1], close: vp.vah * 0.999, open: vp.vah * 0.998, high: vp.vah, low: vp.vah * 0.997, volume: 1000 };
  candles[i] = {
    ...candles[i],
    open: vp.vah * 0.999,
    close: vp.vah * 1.004,
    high: vp.vah * 1.005,
    low: vp.vah * 0.998,
    volume: 20000,
  };
  const opts = {
    vpBreakoutMinVolRatio: 1.0,
    vpBreakoutMinPathPct: 0.004,
    vpMinCloseBeyondPct: 0.001,
    vpMinBreakoutCloseStrength: 0.5,
    vpMinBreakoutBody: 0.4,
  };
  assert.equal(detectVolumeProfileSetup(candles, i, "BUY", vp, opts)?.setup, "vah_breakout");
  assert.equal(
    detectVolumeProfileSetup(candles, i, "BUY", vp, { ...opts, vpBuyVacuumMaxPrior5dPct: 0.01, vpVacuumPathPct: 0.02 }),
    null,
  );
});
