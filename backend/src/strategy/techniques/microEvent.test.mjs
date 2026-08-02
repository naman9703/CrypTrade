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
