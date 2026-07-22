import test from "node:test";
import assert from "node:assert/strict";
import {
  fillVolumeProfileFreqDefaults,
  isVolumeProfileFreqPlaybook,
  VOLUME_PROFILE_FREQ_ETH_15M,
  VOLUME_PROFILE_FREQ_PORTFOLIO_15M,
} from "./volumeProfileOptimized.js";

test("fillVolumeProfileFreqDefaults — no-op without FREQ playbook", () => {
  const cfg = {
    manualStrategy: "VOLUME_PROFILE",
    symbol: "BNBUSDT",
    vpTierAOnly: true,
    vpAllowedSetups: ["vah_breakout"],
  };
  const out = fillVolumeProfileFreqDefaults(cfg);
  assert.deepEqual(out.vpAllowedSetups, ["vah_breakout"]);
});

test("isVolumeProfileFreqPlaybook — fingerprint without vpPlaybook", () => {
  assert.equal(
    isVolumeProfileFreqPlaybook({
      vpTierAOnly: false,
      vpRegimeImmunity: false,
      vpMinAdx: 0,
    }),
    true,
  );
  assert.equal(isVolumeProfileFreqPlaybook({ vpTierAOnly: true, vpMinAdx: 24 }), false);
});

test("fillVolumeProfileFreqDefaults — overwrites ETH portfolio snapshot on BNB leg", () => {
  const shared = {
    ...VOLUME_PROFILE_FREQ_PORTFOLIO_15M,
    symbol: "BNBUSDT",
  };
  const out = fillVolumeProfileFreqDefaults(shared);
  assert.equal(out.vpPlaybook, "FREQ");
  assert.deepEqual(out.vpAllowedSetups, ["val_breakdown"]);
  assert.equal(out.vpRequireHtfAlign, true);
  assert.equal(out.vpMinHtfSepPct, 0.0025);
  assert.equal(out.vpValSellBlockFlatPrior60, true);
  assert.equal(out.vpValSellChaseFilter, true);
  assert.equal(out.vpPreparedBlockVacuumValBear, true);
  assert.equal(out.vpNoveltyEnabled, false);
  // Instance / portfolio fields preserved
  assert.deepEqual(out.universeCustomSymbols, ["ETHUSDT", "BNBUSDT", "BTCUSDT"]);
  assert.equal(out.riskPerTrade, 2.5);
});

test("fillVolumeProfileFreqDefaults — legacy ETH-shaped snapshot without vpPlaybook still resolves BTC", () => {
  const legacy = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    symbol: "BTCUSDT",
  };
  delete legacy.vpPlaybook;
  assert.equal(isVolumeProfileFreqPlaybook(legacy), true);
  const out = fillVolumeProfileFreqDefaults(legacy);
  assert.deepEqual(out.vpAllowedSetups, ["lvn_vacuum", "vah_breakout", "val_breakdown", "va_rejection", "naked_poc"]);
  assert.equal(out.vpRequireHtfAlign, true);
  assert.equal(out.vpMinHtfSepPct, 0.005);
  assert.equal(out.vpValSellRequirePrior60dBear, true);
  assert.equal(out.vpSellWeakBearMinHtfSepPct, 0.008);
  assert.equal(out.vpBuyBreakoutMaxPathNonBullOnly, true);
  assert.equal(out.vpPreparedRegimeOnly, true);
  assert.equal(out.vpPreparedBlockVacuumVah, true);
  assert.equal(out.vpPreparedBlockVacuumValBear, true);
  assert.equal(out.vpRejectionSellBlockExtendedDown, true);
  assert.equal(out.vpRejectionExtendedPriorPct, 0);
});

test("fillVolumeProfileFreqDefaults — preserves user trailing / risk overrides", () => {
  const out = fillVolumeProfileFreqDefaults({
    ...VOLUME_PROFILE_FREQ_PORTFOLIO_15M,
    symbol: "BNBUSDT",
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    backtestTrailMicroTf: "5m",
    riskPerTrade: 3,
    futuresLeverage: 15,
    supertrendFuturesFixedSlPct: 0.01,
  });
  assert.equal(out.trailingStopLossAuto, true);
  assert.equal(out.futuresTrailingStopMode, "SUPERTREND");
  assert.equal(out.backtestTrailMicroTf, "5m");
  assert.equal(out.riskPerTrade, 3);
  assert.equal(out.futuresLeverage, 15);
  assert.equal(out.supertrendFuturesFixedSlPct, 0.01);
  assert.deepEqual(out.vpAllowedSetups, ["val_breakdown"]);
});

test("fillVolumeProfileFreqDefaults — injects locked chop MFE trail when bot omitted it", () => {
  const staleBot = {
    manualStrategy: "VOLUME_PROFILE",
    symbol: "ETHUSDT",
    vpPlaybook: "FREQ",
    vpTierAOnly: false,
    vpRegimeImmunity: false,
    vpMinAdx: 0,
    // chop keys intentionally missing (UI snapshot gap)
  };
  const out = fillVolumeProfileFreqDefaults(staleBot);
  assert.equal(out.backtestChopMfeTrail, true);
  assert.equal(out.backtestChopMfeTrailSides, "SELL");
  assert.equal(out.backtestChopMfeTrailActivatePct, 0.01);
  assert.equal(out.backtestChopMfeTrailGivebackFrac, 0.35);
  assert.equal(out.vpBuyChaseFilter, true);
  assert.equal(out.vpBuyBreakoutMaxPathPct, 0.02);
  assert.equal(out.vpBuyVacuumMaxPrior5dPct, 0.01);
  assert.equal(out.vpValSellBlockBull60Dump, true);
  assert.equal(out.vpValSellBlockBull60NonVac, true);
  assert.equal(out.vpValSellBlockBull60Extending, true);
  assert.equal(out.vpValSellBull60ExtendRatio, 0.6);
  assert.equal(out.vpBuyRejectionMinBody, 0.2);
  assert.equal(out.vpBuyBreakoutBlockBullVacuum, true);
  assert.equal(out.vpValSellBlockWeakBearVacuumHighPrior60, true);
  assert.equal(out.vpValSellWeakBearVacPrior60Pct, 0.15);
  assert.equal(out.volTargetSizing, true);
  assert.equal(out.vpNoveltyEnabled, false);
  assert.equal(out.vpValSellRequirePrior60dBear, undefined);
  assert.equal(out.vpPreparedAllowlistOnly, undefined);
});

test("fillVolumeProfileFreqDefaults — resolves SOL VAL+rej wick40 / HTF0.20 lock", () => {
  const out = fillVolumeProfileFreqDefaults({
    ...VOLUME_PROFILE_FREQ_PORTFOLIO_15M,
    symbol: "SOLUSDT",
  });
  assert.equal(out.vpPlaybook, "FREQ");
  assert.deepEqual(out.vpAllowedSetups, ["val_breakdown", "va_rejection"]);
  assert.equal(out.vpRequireHtfAlign, true);
  assert.equal(out.vpMinHtfSepPct, 0.002);
  assert.equal(out.vpValSellRequirePrior60dBear, true);
  assert.equal(out.vpValSellPrior60dBearPct, -0.05);
  assert.equal(out.vpRejectionSellBlockExtendedDown, true);
  assert.equal(out.vpRejectionExtendedPriorPct, 0.05);
  assert.equal(out.vpRejectionMinWickRatio, 0.4);
  assert.equal(out.vpNoveltyEnabled, false);
});

test("volumeProfilePadFromMs — at least 60d for macroPrior60d", async () => {
  const { volumeProfilePadFromMs, volumeProfileHistoryBars } = await import("./volumeProfileOptimized.js");
  const from = Date.parse("2025-06-01T00:00:00.000Z");
  const pad = volumeProfilePadFromMs(from, "15m", { vpLookbackBars: 384 });
  const days = (from - pad) / 864e5;
  assert.ok(days >= 60, `expected >=60d pad, got ${days}`);
  assert.equal(volumeProfileHistoryBars("15m", { vpLookbackBars: 384 }), 5760);
});
