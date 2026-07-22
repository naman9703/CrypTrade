import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  passesVpBuyBreakoutTightBullFilter,
  passesVpBuyBreakoutBullVacuumFilter,
  passesVpValSellMacroFilter,
} from "./volumeProfileStrategy.js";
import { detectVolumeProfileSetup } from "./techniques/volumeProfile.js";

describe("vpBuyBreakoutBlockBullTight", () => {
  const bullPre = {
    macroPrior60d: [0.12],
    macroPrior20d: [0.04],
    macroAboveEma20d: [true],
    macroEma5dSlope: [0.01],
  };
  const chopPre = {
    macroPrior60d: [0.02],
    macroPrior20d: [0.01],
    macroAboveEma20d: [true],
    macroEma5dSlope: [0.001],
  };
  const opts = { vpBuyBreakoutBlockBullTight: true, vpVacuumPathPct: 0.02 };

  it("blocks BUY vah_breakout in bull_trend with tight path", () => {
    assert.equal(
      passesVpBuyBreakoutTightBullFilter(bullPre, 0, "BUY", "vah_breakout", { distPct: 0.005 }, opts),
      false,
    );
  });

  it("allows structured/vacuum path in bull_trend", () => {
    assert.equal(
      passesVpBuyBreakoutTightBullFilter(bullPre, 0, "BUY", "vah_breakout", { distPct: 0.015 }, opts),
      true,
    );
  });

  it("allows tight path outside bull_trend", () => {
    assert.equal(
      passesVpBuyBreakoutTightBullFilter(chopPre, 0, "BUY", "vah_breakout", { distPct: 0.005 }, opts),
      true,
    );
  });

  it("no-op when flag off", () => {
    assert.equal(
      passesVpBuyBreakoutTightBullFilter(bullPre, 0, "BUY", "vah_breakout", { distPct: 0.005 }, {}),
      true,
    );
  });
});

describe("vpBuyBreakoutBlockBullVacuum", () => {
  const bullPre = {
    macroPrior60d: [0.12],
    macroPrior20d: [0.04],
    macroAboveEma20d: [true],
    macroEma5dSlope: [0.01],
  };
  const weakBearPre = {
    macroPrior60d: [-0.03],
    macroPrior20d: [-0.01],
    macroAboveEma20d: [false],
    macroEma5dSlope: [-0.001],
  };
  const opts = { vpBuyBreakoutBlockBullVacuum: true, vpVacuumPathPct: 0.02 };

  it("blocks BUY vah_breakout in bull_trend with vacuum path", () => {
    assert.equal(
      passesVpBuyBreakoutBullVacuumFilter(bullPre, 0, "BUY", "vah_breakout", { distPct: 0.03 }, opts),
      false,
    );
  });

  it("allows structured path in bull_trend", () => {
    assert.equal(
      passesVpBuyBreakoutBullVacuumFilter(bullPre, 0, "BUY", "vah_breakout", { distPct: 0.015 }, opts),
      true,
    );
  });

  it("allows vacuum path in weak_bear", () => {
    assert.equal(
      passesVpBuyBreakoutBullVacuumFilter(weakBearPre, 0, "BUY", "vah_breakout", { distPct: 0.03 }, opts),
      true,
    );
  });
});

describe("vpValSellBlockWeakBearVacuumHighPrior60", () => {
  const highResidual = {
    macroPrior60d: [0.55],
    macroPrior20d: [-0.04],
    macroAboveEma20d: [false],
    macroEma5dSlope: [-0.001],
  };
  const lowResidual = {
    macroPrior60d: [0.12],
    macroPrior20d: [-0.04],
    macroAboveEma20d: [false],
    macroEma5dSlope: [-0.001],
  };
  const opts = {
    vpValSellBlockWeakBearVacuumHighPrior60: true,
    vpValSellWeakBearVacPrior60Pct: 0.4,
    vpVacuumPathPct: 0.02,
    path: { distPct: 0.03 },
  };

  it("blocks weak_bear vacuum VAL with prior60 > 40%", () => {
    assert.equal(passesVpValSellMacroFilter(highResidual, 0, "SELL", "val_breakdown", opts), false);
  });

  it("allows weak_bear vacuum VAL with prior60 <= 40%", () => {
    assert.equal(passesVpValSellMacroFilter(lowResidual, 0, "SELL", "val_breakdown", opts), true);
  });
});

describe("vpValSellBlockFlatPrior60", () => {
  const flatPre = { macroPrior60d: [0.02], macroPrior20d: [0.01] };
  const bearPre = { macroPrior60d: [-0.08], macroPrior20d: [-0.03] };
  const opts = { vpValSellBlockFlatPrior60: true };

  it("blocks VAL short when prior60 is flat", () => {
    assert.equal(passesVpValSellMacroFilter(flatPre, 0, "SELL", "val_breakdown", opts), false);
  });

  it("allows VAL short when prior60 is bearish", () => {
    assert.equal(passesVpValSellMacroFilter(bearPre, 0, "SELL", "val_breakdown", opts), true);
  });
});

describe("vpValSellChaseFilter", () => {
  const chasePre = { macroPrior5d: [0.07], macroPrior60d: [-0.08] };
  const calmPre = { macroPrior5d: [0.02], macroPrior60d: [-0.08] };
  const opts = { vpValSellChaseFilter: true, vpValSellChaseMaxPrior5dPct: 0.05 };

  it("blocks VAL short after sharp 5d rally", () => {
    assert.equal(passesVpValSellMacroFilter(chasePre, 0, "SELL", "val_breakdown", opts), false);
  });

  it("allows VAL short when prior5d is calm", () => {
    assert.equal(passesVpValSellMacroFilter(calmPre, 0, "SELL", "val_breakdown", opts), true);
  });
});

describe("vpValSellBlockReliefBounce", () => {
  const reliefPre = { macroPrior5d: [-0.05], macroPrior20d: [-0.25], macroPrior60d: [-0.3] };
  const alignedPre = { macroPrior5d: [-0.22], macroPrior20d: [-0.25], macroPrior60d: [-0.3] };
  const opts = { vpValSellBlockReliefBounce: true, vpValSellReliefBounceMaxPct: 0.15 };

  it("blocks VAL short when 5d has relieved hard vs 20d", () => {
    assert.equal(passesVpValSellMacroFilter(reliefPre, 0, "SELL", "val_breakdown", opts), false);
  });

  it("allows VAL short when 5d still tracks 20d dump", () => {
    assert.equal(passesVpValSellMacroFilter(alignedPre, 0, "SELL", "val_breakdown", opts), true);
  });

  it("does not touch va_rejection", () => {
    assert.equal(passesVpValSellMacroFilter(reliefPre, 0, "SELL", "va_rejection", opts), true);
  });
});

describe("vpBuyRejectionMinBody", () => {
  const vp = {
    vah: 108,
    val: 96,
    poc: 102,
    hi: 112,
    lo: 88,
    hvn: [{ price: 105, volume: 100 }],
    lvn: [],
    lvnZones: [],
  };

  function makeCandles({ bodyFrac, closeStr = 0.7 }) {
    const candles = Array.from({ length: 20 }, (_, i) => ({
      ts: i * 900_000,
      open: 100,
      high: 102,
      low: 98,
      close: 100,
      volume: 1000,
    }));
    const low = 90;
    const high = 102;
    const range = high - low;
    const close = low + range * closeStr;
    const open = close - bodyFrac * range;
    candles[19] = {
      ts: 19 * 900_000,
      open,
      high,
      low,
      close,
      volume: 5000,
    };
    return candles;
  }

  const baseOpts = {
    vpAllowedSetups: ["va_rejection"],
    vpRejectionMinVolRatio: 0.5,
    vpRejectionSpikePct: 0.05,
    vpRejectionMinWickRatio: 0.15,
  };

  it("accepts BUY rej with body >= minBody", () => {
    const hit = detectVolumeProfileSetup(makeCandles({ bodyFrac: 0.35 }), 19, "BUY", vp, {
      ...baseOpts,
      vpBuyRejectionMinBody: 0.2,
    });
    assert.equal(hit?.setup, "va_rejection");
  });

  it("rejects BUY rej with wick-only body < minBody", () => {
    const hit = detectVolumeProfileSetup(makeCandles({ bodyFrac: 0.08 }), 19, "BUY", vp, {
      ...baseOpts,
      vpBuyRejectionMinBody: 0.2,
    });
    assert.equal(hit, null);
  });
});
