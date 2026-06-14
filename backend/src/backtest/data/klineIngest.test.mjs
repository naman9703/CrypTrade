import test from "node:test";
import assert from "node:assert/strict";
import { READ_CANDLES_SLICE_MS } from "./klineIngest.js";

test("READ_CANDLES_SLICE_MS is 90 days", () => {
  assert.equal(READ_CANDLES_SLICE_MS, 90 * 24 * 60 * 60 * 1000);
});
