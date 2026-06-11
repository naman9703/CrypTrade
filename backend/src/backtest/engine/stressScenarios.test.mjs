import test from "node:test";
import assert from "node:assert/strict";
import {
  injectFlashCrash,
  injectSustainedBear,
  injectExchangeGap,
  liquidityCrunchCostModel,
  REAL_CRASH_WINDOWS,
  SYNTHETIC_SCENARIOS,
} from "./stressScenarios.js";

const TF_MS = 15 * 60 * 1000;

/** Deterministic synthetic uptrend series. */
function makeCandles(n = 500, startPx = 100) {
  const out = [];
  let px = startPx;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 7) * 0.4 + 0.05;
    const open = px;
    const close = px + drift;
    out.push({
      ts: 1_700_000_000_000 + i * TF_MS,
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
      volume: 1000 + (i % 10) * 50,
    });
    px = close;
  }
  return out;
}

function assertCandleIntegrity(candles) {
  for (const c of candles) {
    assert.ok(Number.isFinite(c.open) && c.open > 0, "open finite/positive");
    assert.ok(Number.isFinite(c.close) && c.close > 0, "close finite/positive");
    assert.ok(c.high >= Math.max(c.open, c.close) - 1e-9, "high >= max(open,close)");
    assert.ok(c.low <= Math.min(c.open, c.close) + 1e-9, "low <= min(open,close)");
    assert.ok(Number.isFinite(c.ts), "ts finite");
  }
}

test("injectFlashCrash: deterministic, preserves length, drops dropPct", () => {
  const base = makeCandles(500);
  const a = injectFlashCrash(base, { dropPct: 15, recoveryBars: 16, recoveryPct: 60 });
  const b = injectFlashCrash(base, { dropPct: 15, recoveryBars: 16, recoveryPct: 60 });
  assert.deepEqual(a, b, "deterministic");
  assert.equal(a.length, base.length, "same bar count");
  assertCandleIntegrity(a);

  // Crash bar exists: some bar's low is ~15% below the prior close.
  const minRatio = Math.min(...a.map((c, i) => (i > 0 ? c.low / a[i - 1].close : 1)));
  assert.ok(minRatio <= 0.86, `expected a ~15% single-bar drop, worst ratio ${minRatio.toFixed(3)}`);

  // Input untouched.
  assert.equal(base[Math.floor(base.length / 2)].volume, 1000 + ((Math.floor(base.length / 2)) % 10) * 50);
});

test("injectFlashCrash: short series returned unchanged", () => {
  const base = makeCandles(10);
  const out = injectFlashCrash(base);
  assert.equal(out.length, 10);
  assert.deepEqual(out, base);
});

test("injectSustainedBear: glides down ~dropPct with elevated volume", () => {
  const base = makeCandles(800);
  const out = injectSustainedBear(base, { dropPct: 30, bars: 200, volMult: 1.8 });
  assert.equal(out.length, base.length);
  assertCandleIntegrity(out);

  const at = Math.round(800 / 3);
  const startPx = base[at - 1].close;
  const endPx = out[at + 199].close;
  const drop = (1 - endPx / startPx) * 100;
  assert.ok(Math.abs(drop - 30) < 1, `expected ~30% decline, got ${drop.toFixed(1)}%`);
  assert.ok(out[at + 50].volume > base[at + 50].volume, "volume elevated during bear leg");
});

test("injectExchangeGap: removes bars and gaps the reopen", () => {
  const base = makeCandles(500);
  const out = injectExchangeGap(base, { gapBars: 24, reopenGapPct: -8 });
  assert.equal(out.length, base.length - 24, "gap bars removed");
  assertCandleIntegrity(out);

  const at = Math.round(500 / 2);
  const preClose = out[at - 1].close;
  const reopen = out[at].open;
  const gapPct = (reopen / preClose - 1) * 100;
  assert.ok(Math.abs(gapPct - -8) < 0.5, `expected -8% reopen gap, got ${gapPct.toFixed(2)}%`);
});

test("liquidityCrunchCostModel: multiplies slippage, forces taker", () => {
  const out = liquidityCrunchCostModel({ slippagePct: 0.0005, takerOpenFeeRate: 0.0005 }, { slippageMult: 8 });
  assert.equal(out.slippagePct, 0.004);
  assert.equal(out.useMakerEntries, false);
  assert.equal(out.useMakerExits, false);
  assert.equal(out.takerOpenFeeRate, 0.0005, "fees untouched");
});

test("registries are well-formed", () => {
  assert.ok(REAL_CRASH_WINDOWS.length >= 3);
  for (const w of REAL_CRASH_WINDOWS) {
    assert.ok(Date.parse(w.from) < Date.parse(w.to), `${w.id} window ordered`);
  }
  assert.ok(SYNTHETIC_SCENARIOS.length >= 5);
  for (const s of SYNTHETIC_SCENARIOS) {
    assert.ok(s.kind === "candles" ? typeof s.apply === "function" : typeof s.applyCost === "function");
  }
});

test("synthetic catalogue transforms keep candle integrity", () => {
  const base = makeCandles(600);
  for (const s of SYNTHETIC_SCENARIOS) {
    if (s.kind !== "candles") continue;
    const out = s.apply(base);
    assert.ok(out.length > 0, `${s.id} produced candles`);
    assertCandleIntegrity(out);
  }
});
