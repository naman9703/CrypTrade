import test from "node:test";
import assert from "node:assert/strict";
import {
  detectLiqSpike,
  scoreMicroEventConfluence,
  evaluateMicroEventFromSnapshot,
  optsFromMicroEventCfg,
} from "./microEvent.js";
import { MICRO_EVENT_ACTIVATION_PATCH } from "../presets/microEventOptimized.js";

test("MICRO_EVENT activation enables two-way futures for shorts", () => {
  assert.equal(MICRO_EVENT_ACTIVATION_PATCH.supertrendFuturesTwoWay, true);
});

const baseSnapshot = {
  symbol: "BTCUSDT",
  tsMs: Date.now(),
  liqLongUsd: 80_000,
  liqShortUsd: 10_000,
  liqTotalUsd: 90_000,
  liqDom: "longs",
  liqZLike: 2.5,
  oiDeltaPct1m: -0.5,
  oiDeltaPct5m: -1.0,
  bookImbalance: 0.35,
  bidWallUsd: 80_000,
  askWallUsd: 200_000,
  aggressiveBuyUsd60s: 5000,
  aggressiveSellUsd60s: 25_000,
  cvdSlope60s: -8000,
  fundingZ: -1.5,
  crowdedSide: "short_crowded",
  calendarActive: false,
  calendarEvents: [],
  lastPrice: 100_000,
};

test("liq spike continuation → SELL on longs liq", () => {
  const opts = optsFromMicroEventCfg({ microEventDirectionMode: "continuation" });
  const hit = detectLiqSpike(baseSnapshot, opts);
  assert.equal(hit?.side, "SELL");
});

test("confluence requires liq + confirm layers", () => {
  const opts = optsFromMicroEventCfg({});
  const liq = detectLiqSpike(baseSnapshot, opts);
  const conf = scoreMicroEventConfluence([liq], baseSnapshot, opts);
  assert.equal(conf.pass, false);
  assert.equal(conf.failedGate, "confirm_layers");
});

test("full snapshot passes with stacked detectors", () => {
  const cfg = {
    microEventDirectionMode: "continuation",
    microEventMinConfirmLayers: 2,
    microEventMinConfluenceScore: 30,
  };
  const ev = evaluateMicroEventFromSnapshot(baseSnapshot, cfg, 100_000);
  assert.ok(ev.action === "SELL" || ev.action === "BUY");
  assert.ok(ev.confluenceScore >= 30);
  assert.ok(ev.liqBrackets?.maxHoldSec > 0);
});

test("minConfirmLayers 0 allows liq-only when score passes", () => {
  const cfg = {
    microEventDirectionMode: "continuation",
    microEventMinConfirmLayers: 0,
    microEventMinConfluenceScore: 20,
    microEventOiGateEnabled: false,
    microEventBookGateEnabled: false,
    microEventCvdGateEnabled: false,
    microEventFundingGateEnabled: false,
    microEventMacroGateEnabled: false,
  };
  const thin = {
    ...baseSnapshot,
    oiDeltaPct1m: null,
    oiDeltaPct5m: null,
    bookImbalance: null,
    aggressiveBuyUsd60s: 0,
    aggressiveSellUsd60s: 0,
    cvdSlope60s: 0,
    fundingZ: null,
  };
  const opts = optsFromMicroEventCfg(cfg);
  assert.equal(opts.minConfirmLayers, 0);
  const ev = evaluateMicroEventFromSnapshot(thin, cfg, 100_000);
  assert.equal(ev.action, "SELL");
});

test("brackets SL uses liq extreme beyond entry for continuation SELL", () => {
  const cfg = {
    microEventDirectionMode: "continuation",
    microEventMinConfirmLayers: 2,
    microEventMinConfluenceScore: 30,
    microEventSlBufferPct: 0.001,
  };
  const snap = { ...baseSnapshot, liqExtremePrice: 101_000, lastPrice: 100_000 };
  const ev = evaluateMicroEventFromSnapshot(snap, cfg, 100_000);
  assert.equal(ev.action, "SELL");
  const slPct = ev.liqBrackets?.slPct;
  assert.ok(slPct != null && slPct > 0.01, `expected SL wider than tiny buffer, got ${slPct}`);
});

test("requireDisplacement skips when signal bar closes against trade", () => {
  const cfg = {
    microEventDirectionMode: "continuation",
    microEventMinConfirmLayers: 0,
    microEventMinConfluenceScore: 10,
    microEventRequireDisplacement: true,
    microEventMinDisplacementPct: 0.05,
    microEventOiGateEnabled: false,
    microEventBookGateEnabled: false,
    microEventCvdGateEnabled: false,
    microEventFundingGateEnabled: false,
    microEventMacroGateEnabled: false,
  };
  const against = {
    ...baseSnapshot,
    barOpen: 100_000,
    barClose: 100_200,
    lastPrice: 100_200,
    oiDeltaPct1m: null,
    oiDeltaPct5m: null,
    bookImbalance: null,
    aggressiveBuyUsd60s: 0,
    aggressiveSellUsd60s: 0,
    cvdSlope60s: 0,
    fundingZ: null,
  };
  const skip = evaluateMicroEventFromSnapshot(against, cfg, 100_200);
  assert.equal(skip.action, null);
  assert.equal(skip.audit?.failedGate, "displacement");

  const withMove = { ...against, barOpen: 100_200, barClose: 99_900, lastPrice: 99_900 };
  const pass = evaluateMicroEventFromSnapshot(withMove, cfg, 99_900);
  assert.equal(pass.action, "SELL");
});

test("fresh cascade rejects when prior 1m max bar already hit liqMin", () => {
  const opts = optsFromMicroEventCfg({
    microEventCascadeFreshEnabled: true,
    microEventLiqMinUsd: 2_000_000,
  });
  const snap = {
    ...baseSnapshot,
    liqTotalUsd: 3_000_000,
    liqQuietPriorMaxBarUsd: 2_500_000,
  };
  assert.equal(detectLiqSpike(snap, opts), null);
  const fresh = detectLiqSpike({ ...snap, liqQuietPriorMaxBarUsd: 100_000 }, opts);
  assert.equal(fresh?.side, "SELL");
});
