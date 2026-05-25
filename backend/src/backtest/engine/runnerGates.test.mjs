/**
 * Gate behavior: baseline vs intelligence replay (MIS), market decision (MD), and both.
 * Uses synthetic candles + runSimulation (no DB).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { runSimulation } from "./runner.js";

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeSyntheticCandles({ n, stepMs, seed = 123 }) {
  const rand = mulberry32(seed);
  let p = 42_000;
  const out = [];
  let ts = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const regime = i < n * 0.45 ? 0.00025 : i < n * 0.7 ? -0.00018 : 0.0001;
    const noise = (rand() - 0.5) * 0.002;
    const o = p;
    const c = p * (1 + regime + noise);
    const hi = Math.max(o, c) * (1 + rand() * 0.0006);
    const lo = Math.min(o, c) * (1 - rand() * 0.0006);
    const vol = 100 + rand() * 400;
    out.push({ ts, open: o, high: hi, low: lo, close: c, volume: vol });
    p = c;
    ts += stepMs;
  }
  return out;
}

const CANDLES = makeSyntheticCandles({ n: 1600, stepMs: 60_000, seed: 123 });
const SYMBOL = "BTCUSDT";
const TF = "1m";

function baseCfg(overrides = {}) {
  return {
    marketMode: "FUTURES",
    futuresLeverage: 5,
    supertrendPeriod: 10,
    supertrendMultiplier: 3,
    supertrendWilderAtr: true,
    intelligenceGateEnabled: false,
    supertrendMoveQualityGate: false,
    signalStrengthGatesTrades: false,
    supertrendBreakoutConfirm: false,
    marketDecision: { enabled: false },
    supertrendFuturesFixedSlPct: 0.02,
    supertrendFuturesFixedTpPct: 0,
    riskPerTrade: 1,
    riskPerTradeUnit: "PCT_EQUITY",
    tradeHistoryTakerOpenFeeRate: 0.0005,
    tradeHistoryTakerCloseFeeRate: 0.0005,
    ...overrides,
  };
}

async function sim(cfg, gateMode, gateFn) {
  return runSimulation({
    strategyKey: "SUPERTREND",
    candles: CANDLES,
    cfg,
    costModelOverride: {},
    gateMode,
    gateFn,
    fundingRates: [],
    startingUsdt: 10_000,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: {},
  });
}

/** Always veto — worst case for MIS replay (proves path is wired). */
function gateFnAlwaysVeto() {
  return { intelScore: 5, action: "vetoed", sizeMult: 0 };
}

/** MD config unlikely to ALLOW entries on random synthetic path. */
const MD_STRICT = {
  enabled: true,
  minRegimeConfidence: 99,
  regimeFilterEnabled: true,
  signalQualityEnabled: true,
  scoreThreshold: 100,
};

test("baseline (all gates off, MIS off): produces trades", async () => {
  const r = await sim(baseCfg(), "off", undefined);
  assert.ok(
    r.trades.length >= 1,
    `expected >=1 trade for synthetic path, got ${r.trades.length} (tune seed/n if flaky)`,
  );
});

test("MIS approx + always-veto: fewer trades than baseline; vetoed > 0", async () => {
  const base = await sim(baseCfg(), "off", undefined);
  const gated = await sim(baseCfg(), "approx", gateFnAlwaysVeto);
  assert.ok(
    gated.trades.length < base.trades.length,
    `MIS veto should reduce trades: baseline ${base.trades.length}, gated ${gated.trades.length}`,
  );
  assert.ok(gated.gateReplay.vetoed >= 1, `expected gateReplay.vetoed >= 1, got ${gated.gateReplay.vetoed}`);
});

test("MD enabled (strict): trades <= baseline", async () => {
  const base = await sim(baseCfg(), "off", undefined);
  const md = await sim(baseCfg({ marketDecision: MD_STRICT }), "off", undefined);
  assert.ok(
    md.trades.length <= base.trades.length,
    `strict MD should not increase trades: baseline ${base.trades.length}, md ${md.trades.length}`,
  );
});

test("MIS veto + MD strict both: trades <= baseline and <= MIS-only", async () => {
  const base = await sim(baseCfg(), "off", undefined);
  const misOnly = await sim(baseCfg(), "approx", gateFnAlwaysVeto);
  const both = await sim(baseCfg({ marketDecision: MD_STRICT }), "approx", gateFnAlwaysVeto);
  assert.ok(both.trades.length <= base.trades.length, `both vs baseline`);
  assert.ok(both.trades.length <= misOnly.trades.length, `both vs mis-only: ${both.trades.length} <= ${misOnly.trades.length}`);
});

test("MIS approx + pass-through gateFn: same trade count as MIS off", async () => {
  const off = await sim(baseCfg(), "off", undefined);
  const pass = await sim(baseCfg(), "approx", () => ({ intelScore: 80, action: "pass", sizeMult: 1 }));
  assert.equal(
    pass.trades.length,
    off.trades.length,
    `pass-through intel should match baseline trades: off=${off.trades.length} pass=${pass.trades.length}`,
  );
});
