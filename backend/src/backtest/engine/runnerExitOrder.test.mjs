import test from "node:test";
import assert from "node:assert/strict";
import { liquidationPrice } from "./costModel.js";

/** Mirror runner intra-bar priority: SL before liq when both are touched. */
function resolveExit({ isLong, bar, sl, liqPx }) {
  const hitSL = isLong ? bar.low <= sl : bar.high >= sl;
  const hitLiq = isLong ? bar.low <= liqPx : bar.high >= liqPx;
  if (hitSL) return { exitReason: "sl", exitPrice: sl };
  if (hitLiq) return { exitReason: "liq", exitPrice: liqPx };
  return null;
}

test("SHORT: SL wins when bar high crosses both SL and liq", () => {
  const entry = 67_131;
  const sl = entry * 1.008;
  const liqPx = liquidationPrice({ side: "SELL", entryFill: entry, leverage: 50 });
  assert.ok(liqPx > sl, "liq should be farther from entry than SL");
  const bar = { high: 68_326, low: 66_996, open: 67_072, close: 68_248 };
  const ex = resolveExit({ isLong: false, bar, sl, liqPx });
  assert.equal(ex.exitReason, "sl");
});

test("LONG: SL wins when bar low crosses both SL and liq", () => {
  const entry = 100_000;
  const sl = entry * 0.992;
  const liqPx = liquidationPrice({ side: "BUY", entryFill: entry, leverage: 50 });
  assert.ok(liqPx < sl, "liq should be below SL for long");
  const bar = { high: 100_100, low: liqPx - 10, open: 99_900, close: 99_800 };
  const ex = resolveExit({ isLong: true, bar, sl, liqPx });
  assert.equal(ex.exitReason, "sl");
});
