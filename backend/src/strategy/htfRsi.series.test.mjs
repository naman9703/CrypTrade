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

test("buildHtfRsiSignalSeries matches signal() on every bar", () => {
  const candles = synth(200);
  const series = buildHtfRsiSignalSeries(candles, "15m");
  let mismatches = 0;
  for (let i = 80; i < candles.length; i++) {
    const direct = signal({ candles: candles.slice(0, i + 1), timeframe: "15m" });
    const fast = series[i];
    const dAct = direct.action === "HOLD" ? null : direct.action;
    const fAct = fast?.action ?? null;
    if (dAct !== fAct) mismatches++;
  }
  assert.equal(mismatches, 0);
});
