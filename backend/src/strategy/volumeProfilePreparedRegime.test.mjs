import test from "node:test";
import assert from "node:assert/strict";
import { passesVpPreparedRegimeFilter } from "./volumeProfileStrategy.js";

test("prepared regime off by default", () => {
  assert.equal(
    passesVpPreparedRegimeFilter({}, 0, "BUY", "vah_breakout", { distPct: 0.03 }, {}),
    true,
  );
});

test("blocks vacuum VAH when prepared regime on", () => {
  const opts = { vpPreparedRegimeOnly: true };
  assert.equal(
    passesVpPreparedRegimeFilter({}, 0, "BUY", "vah_breakout", { distPct: 0.03 }, opts),
    false,
  );
  assert.equal(
    passesVpPreparedRegimeFilter({}, 0, "BUY", "vah_breakout", { distPct: 0.015 }, opts),
    true,
  );
});

test("blocks vacuum VAL only in bear_trend", () => {
  const opts = { vpPreparedRegimeOnly: true };
  const bearPre = {
    macroAboveEma20d: [false],
    macroEma5dSlope: [0],
    macroPrior20d: [-0.1],
    macroPrior60d: [-0.12],
  };
  const bullPre = {
    macroAboveEma20d: [true],
    macroEma5dSlope: [0.01],
    macroPrior20d: [0.05],
    macroPrior60d: [-0.12],
  };
  assert.equal(
    passesVpPreparedRegimeFilter(bearPre, 0, "SELL", "val_breakdown", { distPct: 0.03 }, opts),
    false,
  );
  assert.equal(
    passesVpPreparedRegimeFilter(bullPre, 0, "SELL", "val_breakdown", { distPct: 0.03 }, opts),
    true,
  );
  assert.equal(
    passesVpPreparedRegimeFilter(bearPre, 0, "SELL", "val_breakdown", { distPct: 0.015 }, opts),
    true,
  );
});

test("allowlist-only blocks non-listed cells", () => {
  const allow = {
    vpPreparedAllowlistOnly: true,
    vpPreparedCellKeys: ["BUY|vah_breakout|bull_trend|structured"],
  };
  const bullPre = {
    macroAboveEma20d: [true],
    macroEma5dSlope: [0.01],
    macroPrior20d: [0.05],
    macroPrior60d: [0.1],
  };
  assert.equal(
    passesVpPreparedRegimeFilter(bullPre, 0, "BUY", "vah_breakout", { distPct: 0.015 }, allow),
    true,
  );
  assert.equal(
    passesVpPreparedRegimeFilter(bullPre, 0, "SELL", "val_breakdown", { distPct: 0.015 }, allow),
    false,
  );
});
