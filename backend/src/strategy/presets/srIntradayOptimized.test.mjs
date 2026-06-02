import test from "node:test";
import assert from "node:assert/strict";
import {
  fillSmcSoloPresetDefaults,
  INTRADAY_PRO_ICT_15M,
  INTRADAY_PRO_ICT_FULL_15M,
  INTRADAY_PRO_ICT_RESEARCH_15M,
  materializeIntradayEngineCfgSync,
} from "./srIntradayOptimized.js";
import { materializeIntradayPanelOnCfg } from "../intradayPanelKeys.js";
import {
  applyInstanceOperationalToBot,
  stripInstanceFieldsFromCfgRaw,
} from "../../lib/strategyInstanceSplit.js";

test("fillSmcSoloPresetDefaults preserves explicit sweep-profile overrides", () => {
  const cfg = fillSmcSoloPresetDefaults({
    intradayGateSmcIct: true,
    intradaySmcIctProfile: "sweep",
    intradaySmcPickMode: "per_signal",
    intradaySmcRequireMss: true,
    intradaySmcRequireRetrace: true,
    intradaySmcRequireChoch: true,
  });
  assert.equal(cfg.intradaySmcRequireMss, true);
  assert.equal(cfg.intradaySmcRequireRetrace, true);
  assert.equal(cfg.intradaySmcRequireChoch, true);
});

test("fillSmcSoloPresetDefaults still fills undefined keys from ICT preset", () => {
  const cfg = fillSmcSoloPresetDefaults({
    intradayGateSmcIct: true,
    intradaySmcIctProfile: "sweep",
    intradayGateLiquidity: false,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
    intradayGateInstitutionalSr: false,
  });
  assert.equal(cfg.intradaySmcMinScore, INTRADAY_PRO_ICT_15M.intradaySmcMinScore);
  assert.equal(cfg.intradaySmcRequireMss, INTRADAY_PRO_ICT_15M.intradaySmcRequireMss);
});

test("materializeIntradayPanelFromBot preserves explicit HTF bias mode and CHoCH off", () => {
  const engine = materializeIntradayPanelOnCfg(
    fillSmcSoloPresetDefaults({
      intradayGateSmcIct: true,
      intradaySmcIctProfile: "sweep",
      intradaySmcHtfBiasMode: "ema",
      intradaySmcRequireChoch: false,
      intradaySmcHtfStrictness: "either",
    }),
  );
  assert.equal(engine.intradaySmcHtfBiasMode, "ema");
  assert.equal(engine.intradaySmcRequireChoch, false);
  assert.equal(engine.intradaySmcHtfStrictness, "either");
});

test("fillSmcSoloPresetDefaults isolates SMC when legacy gates default on", () => {
  const cfg = fillSmcSoloPresetDefaults({
    intradayGateSmcIct: true,
    intradayGateLiquidity: true,
    intradayGateSession: true,
    intradayGateFib: true,
    intradayGateVp: true,
    intradayGateOrderFlow: true,
    intradayGateHtfRegime: true,
  });
  assert.equal(cfg.intradayGateSmcIct, true);
  assert.equal(cfg.intradayGateLiquidity, false);
  assert.equal(cfg.intradayGateSession, false);
  assert.equal(cfg.intradaySmcMinScore, INTRADAY_PRO_ICT_15M.intradaySmcMinScore);
});

test("materializeIntradayPanelFromBot — full profile defaults premium/discount without explicit key", () => {
  const engine = materializeIntradayPanelOnCfg({
    intradayGateSmcIct: true,
    intradaySmcIctProfile: "full",
  });
  assert.equal(engine.intradaySmcRequirePremiumDiscount, true);
  assert.equal(engine.intradaySmcPremiumDiscountOte, false);
  assert.equal(engine.intradaySmcDealingRangeLookback, 48);
});

test("materializeIntradayPanelFromBot — full profile defaults strict ICT stack", () => {
  const engine = materializeIntradayPanelOnCfg({
    ...INTRADAY_PRO_ICT_FULL_15M,
    intradayGateSmcIct: true,
  });
  assert.equal(engine.intradaySmcIctProfile, "full");
  assert.equal(engine.intradaySmcRequireChoch, true);
  assert.equal(engine.intradaySmcRequireMss, true);
  assert.equal(engine.intradaySmcRequireRetrace, true);
  assert.equal(engine.intradaySmcRequirePremiumDiscount, true);
  assert.equal(engine.intradaySmcKillzoneMode, "LONDON_NY");
});

test("materializeIntradayPanelFromBot — sweep profile does not default CHoCH on", () => {
  const engine = materializeIntradayPanelOnCfg({
    intradayGateSmcIct: true,
    intradaySmcIctProfile: "sweep",
  });
  assert.equal(engine.intradaySmcRequireChoch, false);
  assert.equal(engine.intradaySmcRequireMss, false);
  assert.equal(engine.intradaySmcRequireRetrace, false);
});

test("materializeIntradayPanelFromBot isolates SMC engine from legacy gate defaults", () => {
  const engine = materializeIntradayPanelOnCfg({
    intradayGateSmcIct: true,
    intradaySmcIctProfile: "sweep",
    intradaySmcHtfBiasMode: "ema",
    intradaySmcRequireChoch: false,
    intradayGateLiquidity: true,
    intradayGateSession: true,
    intradayGateFib: true,
  });
  assert.equal(engine.intradayGateLiquidity, false);
  assert.equal(engine.intradaySmcHtfBiasMode, "ema");
  assert.equal(engine.intradaySmcRequireChoch, false);
});

test("backtest worker materialization keeps saved MSS/retrace flags", () => {
  const snap = {
    intradayGateSmcIct: true,
    intradaySmcIctProfile: "sweep",
    intradaySmcPickMode: "per_signal",
    intradaySmcRequireMss: true,
    intradaySmcRequireRetrace: true,
  };
  const engine = materializeIntradayPanelOnCfg(fillSmcSoloPresetDefaults({ ...snap }));
  assert.equal(engine.intradaySmcRequireMss, true);
  assert.equal(engine.intradaySmcRequireRetrace, true);
});

test("fillSmcSoloPresetDefaults does not inject preset riskPerTrade", () => {
  const cfg = fillSmcSoloPresetDefaults({
    intradayGateSmcIct: true,
    intradaySmcIctProfile: "sweep",
  });
  assert.equal(cfg.riskPerTrade, undefined);
  assert.equal(cfg.riskPerTradeUnit, undefined);
});

test("frozen research SMC keys survive panel materialization for backtest", () => {
  const snap = {
    ...INTRADAY_PRO_ICT_RESEARCH_15M,
    intradayGateSmcIct: true,
  };
  const engine = materializeIntradayEngineCfgSync(snap, materializeIntradayPanelOnCfg);
  assert.equal(engine.intradaySmcFvgEntryMode, "midpoint");
  assert.equal(engine.intradaySmcTp2Mode, "internal");
  assert.equal(engine.intradaySmcRequireChoch, true);
  assert.equal(engine.intradaySmcMinRr, 1.5);
});

test("materializeIntradayEngineCfgSync preserves instance risk after SMC preset fill", () => {
  let cfg = {
    intradayGateSmcIct: true,
    intradaySmcIctProfile: "sweep",
    intradaySmcMinRr: 3,
    manualStrategy: "SR_INTRADAY",
  };
  cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
  assert.equal(cfg.riskPerTrade, undefined);
  applyInstanceOperationalToBot(cfg, { inst_risk_per_trade: 10, inst_risk_unit: "PCT" });
  assert.equal(cfg.riskPerTrade, 10);
  assert.equal(cfg.riskPerTradeUnit, "PCT");
  assert.equal(cfg.intradaySmcMinRr, 3);
});
