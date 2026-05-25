import test from "node:test";
import assert from "node:assert/strict";
import { signal, buildHtfRsiSignalSeries } from "./htfRsi.js";

function synth(n, start = 600) {
  const candles = [];
  for (let i = 0; i < n; i++) {
    const c = start + Math.sin(i / 7) * 8 + i * 0.02;
    candles.push({
      ts: 1_700_000_000_000 + i * 900_000,
      open: c - 0.5,
      high: c + 1,
      low: c - 1,
      close: c,
      volume: 1000 + i,
    });
  }
  return candles;
}

test("buildHtfRsiSignalSeries matches signal() on last bar", () => {
  const candles = synth(200);
  const series = buildHtfRsiSignalSeries(candles, "15m");
  const last = candles.length - 1;
  const direct = signal({ candles: candles.slice(0, last + 1), timeframe: "15m" });
  const fast = series[last];
  if (direct.action === "HOLD") {
    assert.equal(fast, null);
  } else {
    assert.equal(fast?.action, direct.action);
  }
});
