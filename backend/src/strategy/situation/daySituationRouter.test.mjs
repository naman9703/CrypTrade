import { test } from "node:test";
import assert from "node:assert/strict";
import { precomputeIntraday } from "../intradayPro.js";
import { classifySituation } from "./situationEngine.js";
import { DaySituationTracker, resolveActiveSituations } from "./daySituationRouter.js";
import { SITUATIONS as S } from "./situationConstants.js";

function mkCandle(ts, o, h, l, c, v = 1000) {
  return { ts, open: o, high: h, low: l, close: c, volume: v };
}

const ROUTE_TABLE = {
  routes: {
    [S.BREAKDOWN_BEAR]: ["exhaustion_long"],
    [S.RANGE_ABOVE_PDL]: ["lh_fade_short"],
    [S.SQUEEZE]: ["lh_fade_long"],
    [S.RANGE_BELOW_PDH]: ["retest_short"],
  },
};

test("resolveActiveSituations includes range routes while price holds above PDL", () => {
  const base = Date.parse("2026-06-01T00:00:00Z");
  const candles = [];
  for (let i = 0; i < 80; i++) {
    candles.push(mkCandle(base + i * 900_000, 700, 705, 698, 702));
  }
  const pre = precomputeIntraday(candles);
  pre.prevDayLow[79] = 690;
  pre.htfDown[79] = true;

  const tracker = new DaySituationTracker();
  tracker.ensureDay("2026-06-01");
  tracker.update(S.RANGE_ABOVE_PDL, 79, candles, pre);

  const barInfo = classifySituation(candles, 79, pre);
  const active = resolveActiveSituations(candles, 79, pre, barInfo.situation, tracker, ROUTE_TABLE);
  assert.ok(active.includes(S.RANGE_ABOVE_PDL));
  assert.ok(!active.includes(S.BREAKDOWN_BEAR));
});

test("phase lock switches to breakdown after structure confirms", () => {
  const base = Date.parse("2026-06-03T00:00:00Z");
  const candles = [];
  for (let i = 0; i < 120; i++) {
    const pdl = 640;
    const close = i >= 100 ? pdl - 5 - (i - 100) * 0.5 : 650;
    candles.push(mkCandle(base + i * 900_000, close, close + 2, close - 2, close));
  }
  const pre = precomputeIntraday(candles);
  pre.htfDown[119] = true;
  pre.prevDayLow[119] = 640;

  const tracker = new DaySituationTracker();
  tracker.ensureDay("2026-06-03");
  tracker.update(S.BREAKDOWN_BEAR, 119, candles, pre);

  const active = resolveActiveSituations(candles, 119, pre, S.BREAKDOWN_BEAR, tracker, ROUTE_TABLE);
  assert.deepEqual(active, [S.BREAKDOWN_BEAR]);
  assert.ok(!active.includes(S.RANGE_ABOVE_PDL));
});

test("DaySituationTracker resets on new day", () => {
  const tracker = new DaySituationTracker();
  tracker.ensureDay("2026-06-01");
  tracker.update(S.RANGE_ABOVE_PDL, 10, [], {});
  tracker.ensureDay("2026-06-02");
  assert.equal(tracker.sawRangeAbovePdl, false);
});
