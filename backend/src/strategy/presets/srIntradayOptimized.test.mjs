import test from "node:test";
import assert from "node:assert/strict";
import {
  fillSmcSoloPresetDefaults,
  fillLiqSoloPresetDefaults,
  INTRADAY_PRO_ICT_15M,
  INTRADAY_PRO_ICT_FULL_15M,
  INTRADAY_PRO_ICT_RESEARCH_15M,
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_LIQ_15M_V2,
  INTRADAY_PRO_LIQ_15M_RESEARCH,
  INTRADAY_PRO_LIQ_DAILY_15M,
  INTRADAY_PRO_LIQ_ETH_15M,
  INTRADAY_PRO_LIQ_BTC_15M,
  INTRADAY_PRO_LIQ_FREQ_EDGE_BNB_15M,
  INTRADAY_PRO_LIQ_VP_CONFLUENCE_BNB_15M,
  INTRADAY_PRO_LIQ_VP_PROXIMITY_BNB_15M,
  resolveLiqFreqEdgePreset,
  resolveLiqVpConfluencePreset,
  resolveLiqVpProximityPreset,
  materializeIntradayEngineCfgSync,
  repairStaleEthLiqCfg,
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

test("ETH liq materialize drops stale SMC pollution from saved bot", () => {
  const polluted = materializeIntradayEngineCfgSync(
    {
      manualStrategy: "SR_INTRADAY",
      symbol: "ETHUSDT",
      timeframe: "15m",
      intradayGateLiquidity: true,
      intradayGateSession: false,
      intradayGateFib: false,
      intradayGateVp: false,
      intradayGateOrderFlow: false,
      intradayGateHtfRegime: false,
      intradayGateSmcIct: false,
      intradaySmcMinRr: 1.5,
      intradaySrRequireBos: true,
      intradayLiqMaxHoldBars: 0,
      intradayLiqBreakevenAfterPartial: false,
    },
    materializeIntradayPanelOnCfg,
  );
  assert.equal(polluted.intradaySmcMinRr, undefined);
  assert.equal(polluted.intradayLiqMaxHoldBars, INTRADAY_PRO_LIQ_ETH_15M.intradayLiqMaxHoldBars);
  assert.equal(polluted.intradayLiqBreakevenAfterPartial, false);
  assert.equal(polluted.trailOnlyAfterTp2Fill, false);
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

test("fillLiqSoloPresetDefaults — ETH materialize repairs stale hold/BE saves", () => {
  const cfg = materializeIntradayEngineCfgSync({
    symbol: "ETHUSDT",
    timeframe: "15m",
    manualStrategy: "SR_INTRADAY",
    intradayGateLiquidity: true,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
    intradayLiqMaxHoldBars: 0,
    intradayLiqBreakevenAfterPartial: false,
    intradayLiqMinReclaimBodyRatio: 0,
    intradayLiqMinQuality: 0,
    intradaySmcRequireMss: true,
    intradaySrRequireBos: true,
  }, materializeIntradayPanelOnCfg);
  assert.equal(cfg.intradayLiqMaxHoldBars, INTRADAY_PRO_LIQ_ETH_15M.intradayLiqMaxHoldBars);
  assert.equal(cfg.intradayLiqBreakevenAfterPartial, false);
  assert.equal(cfg.intradayLiqRequireHtfAlign, false);
  assert.equal(cfg.intradayLiqVetoCounterTrend, true);
  assert.equal(cfg.intradayLiqMaxTpRr, 3.35);
  assert.equal(cfg.intradayLiqEntryMode, "fade");
  assert.equal(cfg.intradayLiqPdhPdlOnly, INTRADAY_PRO_LIQ_ETH_15M.intradayLiqPdhPdlOnly);
  assert.equal(cfg.intradayLiqAllowTrailOnlyExit, true);
  assert.equal(cfg.trailingStopLossAuto, true);
  assert.equal(cfg.intradayLiqPartialTp, false);
  assert.equal(cfg.intradayLiqMaxFadeDayRangePct, 0.06);
  assert.equal(cfg.intradayLiqRequirePostReclaimDisplacement, false);
  assert.equal(cfg.intradayLiqTrailUseContextScore, true);
  assert.equal(cfg.intradayLiqMinEntryScore, 38);
  assert.equal(cfg.intradayLiqSweepQualityGate, false);
  assert.equal(cfg.intradayLiqReclaimHoldBars, 0);
  assert.equal(cfg.trailOnlyAfterTp2Fill, false);
  assert.notEqual(cfg.intradaySmcRequireMss, true);
  assert.equal(cfg.intradaySrRequireBos, undefined);
});

test("repairStaleEthLiqCfg — keeps trail when intradayLiqAllowTrailOnlyExit", () => {
  const cfg = repairStaleEthLiqCfg(
    {
      symbol: "ETHUSDT",
      manualStrategy: "SR_INTRADAY",
      intradayGateLiquidity: true,
      intradayGateFib: false,
      intradayGateVp: false,
      intradayGateOrderFlow: false,
      intradayGateHtfRegime: false,
      trailingStopLossAuto: true,
      intradayLiqPartialTp: false,
      intradayLiqTp1Enabled: false,
      intradayLiqTp2Enabled: false,
      intradayLiqAllowTrailOnlyExit: true,
    },
    {
      trailingStopLossAuto: true,
      intradayLiqPartialTp: false,
      intradayLiqAllowTrailOnlyExit: true,
    },
  );
  assert.equal(cfg.trailingStopLossAuto, true);
  assert.equal(cfg.intradayLiqPartialTp, false);
});

test("repairStaleEthLiqCfg — restores partial ladder when trail-only without allow flag", () => {
  const cfg = repairStaleEthLiqCfg(
    {
      symbol: "ETHUSDT",
      manualStrategy: "SR_INTRADAY",
      intradayGateLiquidity: true,
      intradayGateFib: false,
      intradayGateVp: false,
      intradayGateOrderFlow: false,
      intradayGateHtfRegime: false,
      trailingStopLossAuto: true,
      intradayLiqPartialTp: false,
      intradayLiqTp1Enabled: false,
      intradayLiqTp2Enabled: false,
      intradayLiqAllowTrailOnlyExit: false,
    },
    {
      trailingStopLossAuto: true,
      intradayLiqPartialTp: false,
      intradayLiqTp1Enabled: false,
      intradayLiqTp2Enabled: false,
      intradayLiqAllowTrailOnlyExit: false,
    },
  );
  assert.equal(cfg.trailingStopLossAuto, false);
  assert.equal(cfg.intradayLiqPartialTp, true);
  assert.equal(cfg.intradayLiqTp1Enabled, true);
  assert.equal(cfg.intradayLiqTp2Enabled, true);
  assert.equal(cfg.intradayLiqVetoCounterTrend, true);
});

test("repairStaleEthLiqCfg — keeps trail when allow flag missing (filled from preset)", () => {
  const cfg = repairStaleEthLiqCfg(
    {
      symbol: "ETHUSDT",
      manualStrategy: "SR_INTRADAY",
      intradayGateLiquidity: true,
      intradayGateFib: false,
      intradayGateVp: false,
      intradayGateOrderFlow: false,
      intradayGateHtfRegime: false,
      trailingStopLossAuto: true,
      intradayLiqPartialTp: false,
      intradayLiqTp1Enabled: false,
      intradayLiqTp2Enabled: false,
    },
    {
      trailingStopLossAuto: true,
      intradayLiqPartialTp: false,
      intradayLiqTp1Enabled: false,
      intradayLiqTp2Enabled: false,
    },
  );
  assert.equal(cfg.intradayLiqAllowTrailOnlyExit, true);
  assert.equal(cfg.trailingStopLossAuto, true);
  assert.equal(cfg.intradayLiqPartialTp, false);
});

test("materializeIntradayEngineCfgSync — ETH LIQ preserves TP1/BE off with TP2 on", () => {
  const cfg = materializeIntradayEngineCfgSync({
    symbol: "ETHUSDT",
    timeframe: "15m",
    manualStrategy: "SR_INTRADAY",
    intradayGateLiquidity: true,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
    intradayLiqTp1Enabled: false,
    intradayLiqPartialTp: false,
    intradayLiqTp2Enabled: true,
    intradayLiqBreakevenAfterPartial: false,
    intradayLiqMaxHoldBars: 0,
  }, materializeIntradayPanelOnCfg);
  assert.equal(cfg.intradayLiqTp1Enabled, false);
  assert.equal(cfg.intradayLiqBreakevenAfterPartial, false);
  assert.equal(cfg.intradayLiqTp2Enabled, true);
  assert.equal(cfg.intradayLiqMaxHoldBars, INTRADAY_PRO_LIQ_ETH_15M.intradayLiqMaxHoldBars);
});

test("materializeIntradayEngineCfgSync — ETH LIQ preserves explicit user overrides", () => {
  const cfg = materializeIntradayEngineCfgSync({
    symbol: "ETHUSDT",
    timeframe: "15m",
    manualStrategy: "SR_INTRADAY",
    intradayGateLiquidity: true,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
    intradayLiqRequireHtfAlign: false,
    intradayLiqMaxTpRr: 3,
    intradayLiqMinReclaimBodyRatio: 0.5,
    intradayLiqMinRr: 2,
    intradayLiqMaxHoldBars: 36,
    intradayLiqBreakevenAfterPartial: true,
    riskPerTrade: 1.5,
  }, materializeIntradayPanelOnCfg);
  assert.equal(cfg.intradayLiqRequireHtfAlign, false);
  assert.equal(cfg.intradayLiqMaxTpRr, 3);
  assert.equal(cfg.intradayLiqMinReclaimBodyRatio, 0.5);
  assert.equal(cfg.intradayLiqMinRr, 2);
  assert.equal(cfg.intradayLiqMaxHoldBars, 36);
  assert.equal(cfg.riskPerTrade, 1.5);
});

test("INTRADAY_PRO_LIQ_15M disables breakdown-day router; LIQ_DAILY and BTC preset enable it", () => {
  assert.equal(INTRADAY_PRO_LIQ_15M.intradayLiqBreakdownDayBias, false);
  assert.equal(INTRADAY_PRO_LIQ_DAILY_15M.intradayLiqBreakdownDayBias, true);
  assert.equal(INTRADAY_PRO_LIQ_BTC_15M.intradayLiqBreakdownDayBias, true);
  assert.equal(INTRADAY_PRO_LIQ_BTC_15M.intradayLiqRequireChoch, false);
  assert.equal(INTRADAY_PRO_LIQ_BTC_15M.symbol, "BTCUSDT");
  const filled = fillLiqSoloPresetDefaults({
    symbol: "BTCUSDT",
    timeframe: "15m",
    intradayGateLiquidity: true,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
  });
  assert.equal(filled.intradayLiqBreakdownDayBias, true);
  assert.equal(filled.intradayLiqRequireChoch, false);
});

test("INTRADAY_PRO_LIQ_FREQ_EDGE disables trend continuation and routes per symbol", () => {
  assert.equal(INTRADAY_PRO_LIQ_FREQ_EDGE_BNB_15M.intradayLiqTrendContinuation, false);
  assert.equal(INTRADAY_PRO_LIQ_FREQ_EDGE_BNB_15M.intradayLiqBreakdownDayBias, false);
  assert.equal(INTRADAY_PRO_LIQ_FREQ_EDGE_BNB_15M.intradayLiqOnePickPerDay, false);
  const ethFilled = fillLiqSoloPresetDefaults({
    symbol: "ETHUSDT",
    timeframe: "15m",
    intradayLiqPlaybook: "FREQ_EDGE",
    intradayGateLiquidity: true,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
  });
  assert.equal(ethFilled.intradayLiqTrendContinuation, false);
  assert.equal(ethFilled.intradayLiqBreakdownDayBias, true);
  assert.equal(resolveLiqFreqEdgePreset("ETHUSDT").symbol, "ETHUSDT");
});

test("INTRADAY_PRO_LIQ_VP_CONFLUENCE requires dual gates and minTechniqueCount 2", () => {
  assert.equal(INTRADAY_PRO_LIQ_VP_CONFLUENCE_BNB_15M.intradayGateLiquidity, true);
  assert.equal(INTRADAY_PRO_LIQ_VP_CONFLUENCE_BNB_15M.intradayGateVp, true);
  assert.equal(INTRADAY_PRO_LIQ_VP_CONFLUENCE_BNB_15M.intradayGateFib, false);
  assert.equal(INTRADAY_PRO_LIQ_VP_CONFLUENCE_BNB_15M.intradayMinTechniqueCount, 2);
  assert.equal(resolveLiqVpConfluencePreset("ETHUSDT").symbol, "ETHUSDT");
});

test("INTRADAY_PRO_LIQ_VP_PROXIMITY keeps LIQ solo fast path with proximity veto", () => {
  assert.equal(INTRADAY_PRO_LIQ_VP_PROXIMITY_BNB_15M.intradayGateVp, false);
  assert.equal(INTRADAY_PRO_LIQ_VP_PROXIMITY_BNB_15M.intradayGateLiquidity, true);
  assert.equal(INTRADAY_PRO_LIQ_VP_PROXIMITY_BNB_15M.intradayLiqVpProximityMaxPct, 0.0015);
  assert.equal(INTRADAY_PRO_LIQ_VP_PROXIMITY_BNB_15M.intradayLiqPlaybook, "LIQ_VP_PROXIMITY");
  assert.equal(resolveLiqVpProximityPreset("ETHUSDT", 0.0025).intradayLiqVpProximityMaxPct, 0.0025);
});

test("INTRADAY_PRO_LIQ_15M_V2 enables context engine flags", () => {
  assert.equal(INTRADAY_PRO_LIQ_15M_V2.intradayLiqMarketStateGate, true);
  assert.equal(INTRADAY_PRO_LIQ_15M_V2.intradayLiqUseEntryScoreV2, true);
  assert.equal(INTRADAY_PRO_LIQ_15M_V2.intradayLiqContinuationGate, true);
  assert.ok(String(INTRADAY_PRO_LIQ_15M_V2.intradayLiqLevels).includes("weekly"));
});

test("INTRADAY_PRO_LIQ_15M_RESEARCH extracts features without binary gates", () => {
  assert.equal(INTRADAY_PRO_LIQ_15M_RESEARCH.intradayLiqMarketStateGate, false);
  assert.equal(INTRADAY_PRO_LIQ_15M_RESEARCH.intradayLiqContinuationGate, false);
  assert.equal(INTRADAY_PRO_LIQ_15M_RESEARCH.intradayLiqSweepQualityGate, false);
  assert.equal(INTRADAY_PRO_LIQ_15M_RESEARCH.intradayLiqUseEntryScoreV2, true);
});
