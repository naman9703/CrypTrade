import test from "node:test";
import assert from "node:assert/strict";
import { inSmcKillzone, utcHourFromTs } from "./sessionKillzones.js";

function tsAtUtcHour(h, day = 1) {
  return Date.UTC(2026, 0, day, h, 30, 0);
}

test("LONDON_NY passes during London window", () => {
  assert.equal(inSmcKillzone(tsAtUtcHour(8), { intradaySmcKillzoneMode: "LONDON_NY" }), true);
});

test("LONDON_NY passes during NY window", () => {
  assert.equal(inSmcKillzone(tsAtUtcHour(13), { intradaySmcKillzoneMode: "LONDON_NY" }), true);
});

test("LONDON_NY rejects outside London and NY", () => {
  assert.equal(inSmcKillzone(tsAtUtcHour(5), { intradaySmcKillzoneMode: "LONDON_NY" }), false);
  assert.equal(inSmcKillzone(tsAtUtcHour(18), { intradaySmcKillzoneMode: "LONDON_NY" }), false);
});

test("LONDON_NY boundary: 10 UTC excluded, 12 UTC included", () => {
  assert.equal(inSmcKillzone(tsAtUtcHour(10), { intradaySmcKillzoneMode: "LONDON_NY" }), false);
  assert.equal(inSmcKillzone(tsAtUtcHour(12), { intradaySmcKillzoneMode: "LONDON_NY" }), true);
});

test("ALL always passes", () => {
  assert.equal(inSmcKillzone(tsAtUtcHour(3), { intradaySmcKillzoneMode: "ALL" }), true);
});

test("default mode is LONDON_NY when unset", () => {
  assert.equal(inSmcKillzone(tsAtUtcHour(8), {}), true);
  assert.equal(inSmcKillzone(tsAtUtcHour(5), {}), false);
});

test("utcHourFromTs", () => {
  assert.equal(utcHourFromTs(tsAtUtcHour(14)), 14);
});
