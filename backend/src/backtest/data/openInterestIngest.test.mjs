import test from "node:test";
import assert from "node:assert/strict";
import { OI_API_RETENTION_MS, resolveOiApiWindow } from "./openInterestIngest.js";

test("OI API retention is 30 days per Binance docs", () => {
  assert.equal(OI_API_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);
});

test("resolveOiApiWindow marks historical research window as API-limited", () => {
  const win = resolveOiApiWindow(Date.parse("2022-01-01"), Date.parse("2026-06-01"));
  assert.equal(win.apiUnavailable, true);
  assert.equal(win.apiLimited, true);
});
