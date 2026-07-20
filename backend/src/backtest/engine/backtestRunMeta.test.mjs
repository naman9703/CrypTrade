import test from "node:test";
import assert from "node:assert/strict";
import { pickBacktestRunMeta, applyBacktestRunMeta } from "./backtestRunMeta.js";
import { materializeIntradayEngineCfgSync } from "../../strategy/presets/srIntradayOptimized.js";

test("pickBacktestRunMeta extracts per-run trail keys", () => {
  const meta = pickBacktestRunMeta({
    trailingStopLossAuto: true,
    backtestTrailMicroTf: "5m",
    backtestTrailActivationOn: "close",
    riskPerTrade: 2,
  });
  assert.equal(meta.backtestTrailMicroTf, "5m");
  assert.equal(meta.backtestTrailActivationOn, "close");
  assert.equal(meta.riskPerTrade, 2);
  assert.equal(meta.trailingStopLossAuto, undefined);
});

test("materializeIntradayEngineCfgSync preserves backtest trail meta", () => {
  const out = materializeIntradayEngineCfgSync({
    manualStrategy: "SR_INTRADAY",
    intradayGateLiquidity: true,
    backtestTrailMicroTf: "5m",
    backtestTrailActivationOn: "close",
    intradayLiqMinRr: 1.5,
  });
  assert.equal(out.backtestTrailMicroTf, "5m");
  assert.equal(out.backtestTrailActivationOn, "close");
  assert.equal(out.intradayLiqMinRr, 1.5);
});

test("applyBacktestRunMeta restores keys stripped by engine materialize", () => {
  let cfg = materializeIntradayEngineCfgSync({
    manualStrategy: "SR_INTRADAY",
    intradayGateLiquidity: true,
    backtestTrailMicroTf: "5m",
  });
  assert.equal(cfg.backtestTrailMicroTf, "5m");
  cfg = { ...cfg };
  delete cfg.backtestTrailMicroTf;
  applyBacktestRunMeta(cfg, { backtestTrailMicroTf: "5m", backtestTrailActivationOn: "close" });
  assert.equal(cfg.backtestTrailMicroTf, "5m");
  assert.equal(cfg.backtestTrailActivationOn, "close");
});
