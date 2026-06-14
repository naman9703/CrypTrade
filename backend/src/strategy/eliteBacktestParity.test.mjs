import test from "node:test";
import assert from "node:assert/strict";
import { fixedBracketTpEnabled } from "./bracketToggles.js";
import { sanitizeEliteStContamination, prepareEliteRunCfg } from "./supertrendElite.js";

test("saved TP off survives sanitize + bracket toggle (backtest/live parity)", () => {
  const saved = {
    manualStrategy: "SUPERTREND_ELITE",
    trailingStopLossAuto: true,
    supertrendFuturesUseFixedSl: true,
    supertrendFuturesFixedSlPct: 0.002,
    supertrendFuturesUseFixedTp: false,
    supertrendFuturesFixedTpPct: 0.015,
    eliteStAutoCalibrate: false,
  };
  const simCfg = sanitizeEliteStContamination(saved);
  assert.equal(simCfg.supertrendFuturesUseFixedTp, false);
  assert.equal(fixedBracketTpEnabled(simCfg), false);
});

test("auto-calibrate does not re-enable TP when user saved TP off", () => {
  const candles = Array.from({ length: 120 }, (_, i) => ({
    ts: 1_700_000_000_000 + i * 3_600_000,
    open: 100 + i * 0.01,
    high: 101 + i * 0.01,
    low: 99 + i * 0.01,
    close: 100.5 + i * 0.01,
    volume: 1000 + i,
  }));
  const out = prepareEliteRunCfg(
    {
      symbol: "BNBUSDT",
      eliteStAutoCalibrate: true,
      eliteStAutoFullTune: false,
      eliteStAutoBracketMode: "ATR",
      supertrendFuturesUseFixedTp: false,
      supertrendFuturesFixedTpPct: 0,
    },
    "BNBUSDT",
    candles,
  );
  assert.equal(out.supertrendFuturesUseFixedTp, false);
  assert.equal(fixedBracketTpEnabled(out), false);
});
