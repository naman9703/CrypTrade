import test from "node:test";
import assert from "node:assert/strict";
import { resolveTrailingOpts, advanceTrailForBar } from "./trailingSim.js";
import { resolveCostModel } from "./costModel.js";

const FUTURES_CFG = {
  marketMode: "FUTURES",
  futuresLeverage: 20,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  trailBufferRate: 0.0015,
  trailPostT02SpacingFrac: 0.001,
  trailPostT02MaxExtraTiers: 150,
  supertrendUseFeeBreakeven: true,
  supertrendUseAdvancedTrail: true,
  trailT01LockSlippageFrac: 0.0002,
  /** Match live default fee envelope so the round-trip = 0.0010 (0.10%). */
  tradeHistoryTakerOpenFeeRate: 0.0005,
  tradeHistoryTakerCloseFeeRate: 0.0005,
};

function bar(open, high, low, close) {
  return { ts: 1, open, high, low, close };
}

test("tiered Supertrend trail advances LONG through T01 → T02 → post-T02 lock", () => {
  const cm = resolveCostModel(FUTURES_CFG);
  const opts = resolveTrailingOpts(FUTURES_CFG, cm, null);
  const entry = 100;
  const pos = {
    side: "BUY",
    entryFill: entry,
    sl: entry * (1 - 0.003),
    tp: entry * (1 + 0.1),
    trailStep: 0,
    extremePx: entry,
    trailTierLabel: null,
  };

  /** T01 activation = entry × (1 + buf) = 100.15 → SL = 100 × (1 + slip 0.02%) = 100.02 */
  const r1 = advanceTrailForBar({
    pos,
    bar: bar(100, 100.2, 99.95, 100.15),
    stBar: null,
    opts,
    mode: "SUPERTREND",
    leverage: cm.leverage,
  });
  assert.equal(r1.advanced, true, "T01 should trigger when high crosses entry+buffer");
  assert.equal(r1.trailStep, 1);
  assert.ok(r1.proposedSl > pos.entryFill * (1 - 0.003), "trail SL must move above initial fixed SL");
  pos.sl = r1.proposedSl;

  /** T02 activation = entry × (1 + feeBe + buf). feeBe ≈ 0.001, buf = 0.0015 → 100.25. */
  const r2 = advanceTrailForBar({
    pos,
    bar: bar(100.15, 100.3, 100.1, 100.27),
    stBar: null,
    opts,
    mode: "SUPERTREND",
    leverage: cm.leverage,
  });
  assert.equal(r2.advanced, true);
  assert.equal(r2.trailStep, 2, "T02 reached after fee+buffer threshold");
  assert.equal(
    Math.round(r2.proposedSl * 1e4) / 1e4,
    Math.round(entry * (1 + opts.feeBeLockRate) * 1e4) / 1e4,
    "T02 lock = entry × (1 + feeBe)",
  );
  pos.sl = r2.proposedSl;

  /** Post-T02 rung 1 (step 3): activation = T02_lock × (1 + buf), lock = T02_lock + spacing×entry. */
  const r3 = advanceTrailForBar({
    pos,
    bar: bar(100.27, 100.4, 100.2, 100.35),
    stBar: null,
    opts,
    mode: "SUPERTREND",
    leverage: cm.leverage,
  });
  assert.equal(r3.advanced, true, "post-T02 rung should engage when high passes T02_lock × (1+buf)");
  assert.ok(r3.trailStep >= 3);
  assert.ok(r3.proposedSl > entry * (1 + opts.feeBeLockRate), "post-T02 lock must sit above T02 floor");
});

test("trail SL never loosens (LONG) and tier never regresses", () => {
  const cm = resolveCostModel(FUTURES_CFG);
  const opts = resolveTrailingOpts(FUTURES_CFG, cm, null);
  const pos = {
    side: "BUY",
    entryFill: 100,
    sl: 100 * (1 + opts.feeBeLockRate),
    tp: 0,
    trailStep: 2,
    extremePx: 100.3,
    trailTierLabel: "T02",
  };
  /** Bar where price retraces — favorable extreme is below the previous HWM. */
  const r = advanceTrailForBar({
    pos,
    bar: bar(100.3, 100.31, 100.05, 100.1),
    stBar: null,
    opts,
    mode: "SUPERTREND",
    leverage: cm.leverage,
  });
  assert.equal(r.advanced, false, "no advancement when HWM did not exceed next activation");
  assert.equal(pos.sl, 100 * (1 + opts.feeBeLockRate), "SL unchanged");
  assert.equal(pos.trailStep, 2, "step did not regress");
});

test("SHORT side mirrors LONG semantics (T01 → T02)", () => {
  const cm = resolveCostModel(FUTURES_CFG);
  const opts = resolveTrailingOpts(FUTURES_CFG, cm, null);
  const entry = 100;
  const pos = {
    side: "SELL",
    entryFill: entry,
    sl: entry * (1 + 0.003),
    tp: 0,
    trailStep: 0,
    extremePx: entry,
    trailTierLabel: null,
  };

  /** T01 for SHORT: low must drop below entry × (1 − buf) = 99.85. */
  const r1 = advanceTrailForBar({
    pos,
    bar: bar(100, 100.05, 99.8, 99.85),
    stBar: null,
    opts,
    mode: "SUPERTREND",
    leverage: cm.leverage,
  });
  assert.equal(r1.advanced, true);
  assert.equal(r1.trailStep, 1);
  assert.ok(r1.proposedSl < entry * (1 + 0.003), "SHORT trail SL tightens downward (above entry)");
});

test("resolveTrailingOpts respects futuresTrailingSt* bot keys over legacy defaults", () => {
  const cfg = {
    ...FUTURES_CFG,
    futuresTrailingStFeeBreakeven: false,
    futuresTrailingStAdvanced: true,
    /** Legacy keys left true — must not override explicit bot toggles. */
    supertrendUseFeeBreakeven: true,
    supertrendUseAdvancedTrail: true,
  };
  const opts = resolveTrailingOpts(cfg, resolveCostModel(cfg), null);
  assert.equal(opts.useFeeBeTrail, false);
  assert.equal(opts.useAdvTrail, true);
  assert.equal(opts.tieredStMode, false, "T01/T02 tiered path requires both toggles on");
});

test("advanced-only trail does not use tiered T01/T02 locks", () => {
  const cfg = {
    ...FUTURES_CFG,
    futuresTrailingStFeeBreakeven: false,
    futuresTrailingStAdvanced: true,
  };
  const cm = resolveCostModel(cfg);
  const opts = resolveTrailingOpts(cfg, cm, null);
  assert.equal(opts.tieredStMode, false);
  const entry = 100;
  const pos = {
    side: "BUY",
    entryFill: entry,
    sl: entry * (1 - 0.003),
    tp: 0,
    trailStep: 0,
    extremePx: entry,
    trailTierLabel: null,
  };
  const stBar = { line: 99.5, trend: 1, ready: true };
  const r = advanceTrailForBar({
    pos,
    bar: bar(100, 101, 99.5, 100.5),
    stBar,
    opts,
    mode: "SUPERTREND",
    leverage: cm.leverage,
  });
  if (r.advanced && r.tierLabel) {
    assert.notEqual(r.tierLabel, "T01", "fee-BE off must not emit T01 tier label");
    assert.notEqual(r.tierLabel, "T02", "fee-BE off must not emit T02 tier label");
  }
});

test("FEE_LADDER mode advances using extra scalping pcts", () => {
  const cfg = { ...FUTURES_CFG, futuresTrailingStopMode: "FEE_LADDER", extraScalpingPcts: [0.5] };
  const cm = resolveCostModel(cfg);
  const opts = resolveTrailingOpts(cfg, cm, null);
  const pos = {
    side: "BUY",
    entryFill: 100,
    sl: 100 * (1 - 0.01),
    tp: 0,
    trailStep: 0,
    extremePx: 100,
    trailTierLabel: null,
  };
  const r = advanceTrailForBar({
    pos,
    bar: bar(100, 100.6, 99.9, 100.5),
    stBar: null,
    opts,
    mode: "FEE_LADDER",
    leverage: cm.leverage,
  });
  assert.equal(r.advanced, true);
  assert.ok(r.trailStep >= 1, "fee-BE lock advances");
});
