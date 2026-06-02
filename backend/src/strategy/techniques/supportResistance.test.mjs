import test from "node:test";
import assert from "node:assert/strict";
import {
  buildZone,
  priceInZone,
  listHtfZones,
  passesHtfTrend,
  utcWeekId,
} from "./supportResistance.js";

test("buildZone — band around level", () => {
  const z = buildZone(100, "daily", "support", "pdl", 0.01);
  assert.ok(z);
  assert.equal(z.level, 100);
  assert.ok(z.bandLow < 100 && z.bandHigh > 100);
  assert.ok(priceInZone(100, z));
  assert.ok(priceInZone(99.5, z));
});

test("listHtfZones — long gets PDL and PWL", () => {
  const pre = {
    prevDayHigh: [105],
    prevDayLow: [95],
    prevWeekHigh: [110],
    prevWeekLow: [90],
    atrSeries: [1],
  };
  const zones = listHtfZones(pre, 0, "BUY", {});
  assert.equal(zones.length, 2);
  assert.equal(zones[0].tag, "pdl");
  assert.equal(zones[1].tag, "pwl");
});

test("passesHtfTrend — requires hourly bias", () => {
  const pre = { htfUp: [true], htfDown: [false], htfSep: [0.001] };
  assert.equal(passesHtfTrend("BUY", pre, 0, {}), true);
  assert.equal(passesHtfTrend("SELL", pre, 0, {}), false);
});

test("utcWeekId — stable buckets", () => {
  const t = Date.parse("2026-01-15T12:00:00Z");
  assert.equal(utcWeekId(t), utcWeekId(t + 86_400_000));
});
