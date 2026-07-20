import test from "node:test";
import assert from "node:assert/strict";
import { markDbTimeframe, mergeMicroTrailBars } from "./markPriceIngest.js";

test("markDbTimeframe maps interval to DB key", () => {
  assert.equal(markDbTimeframe("1m"), "1m_mark");
  assert.equal(markDbTimeframe("5m"), "5m_mark");
  assert.equal(markDbTimeframe("15m"), "15m_mark");
});

test("mergeMicroTrailBars uses trade for gaps and mark overrides shared timestamps", () => {
  const trade = [
    { ts: 60_000, open: 100, high: 101, low: 99, close: 100.5, volume: 1 },
    { ts: 120_000, open: 100.5, high: 102, low: 100, close: 101, volume: 1 },
    { ts: 180_000, open: 101, high: 103, low: 100.5, close: 102, volume: 1 },
  ];
  const mark = [{ ts: 120_000, open: 100.6, high: 102.1, low: 100.2, close: 101.2 }];
  const merged = mergeMicroTrailBars(mark, trade);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].kind, "trade");
  assert.equal(merged[1].kind, "mark");
  assert.equal(merged[1].close, 101.2);
  assert.equal(merged[2].kind, "trade");
});

test("mergeMicroTrailBars returns sorted unique timestamps", () => {
  const merged = mergeMicroTrailBars(
    [{ ts: 120_000, open: 1, high: 2, low: 0.5, close: 1.5 }],
    [{ ts: 60_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 0 }],
  );
  assert.deepEqual(
    merged.map((b) => b.ts),
    [60_000, 120_000],
  );
});
