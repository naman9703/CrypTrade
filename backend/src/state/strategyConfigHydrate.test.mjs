import test from "node:test";
import assert from "node:assert/strict";
import { mergeInstanceIntoCfgRaw, stripInstanceFieldsFromCfgRaw } from "../lib/strategyInstanceSplit.js";

test("stripInstanceFieldsFromCfgRaw preserves elite gates and bracket toggles", () => {
  const raw = {
    v: 1,
    bot: {
      manualStrategy: "SUPERTREND_ELITE",
      eliteStRequireHtf4hAlign: false,
      eliteStRequireHtf1hEmaAlign: false,
      supertrendFuturesUseFixedTp: false,
      supertrendFuturesUseFixedSl: false,
      symbol: "BTCUSDT",
      timeframe: "1h",
    },
  };
  const stripped = stripInstanceFieldsFromCfgRaw(raw);
  const b = stripped.bot;
  assert.equal(b.eliteStRequireHtf4hAlign, false);
  assert.equal(b.eliteStRequireHtf1hEmaAlign, false);
  assert.equal(b.supertrendFuturesUseFixedTp, false);
  assert.equal(b.supertrendFuturesUseFixedSl, false);
  assert.equal(b.symbol, undefined);
  assert.equal(b.timeframe, undefined);
});

test("mergeInstanceIntoCfgRaw overlays instance ops without dropping signal brain", () => {
  const strategy = stripInstanceFieldsFromCfgRaw({
    v: 1,
    bot: {
      manualStrategy: "SUPERTREND_ELITE",
      eliteStRequireHtf4hAlign: false,
      supertrendFuturesUseFixedTp: false,
    },
  });
  const merged = mergeInstanceIntoCfgRaw(strategy, {
    inst_symbol: "BNBUSDT",
    inst_timeframe: "1h",
    inst_market_mode: "FUTURES",
  });
  const b = merged.bot;
  assert.equal(b.symbol, "BNBUSDT");
  assert.equal(b.timeframe, "1h");
  assert.equal(b.marketMode, "FUTURES");
  assert.equal(b.eliteStRequireHtf4hAlign, false);
  assert.equal(b.supertrendFuturesUseFixedTp, false);
});
