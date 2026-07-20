import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeSignalBrainCfgRaw,
  sanitizeBacktestConfigSnapshot,
  mergeMissingSignalBrainBot,
  isRuntimePollutionKey,
} from "./strategySignalBrain.js";

test("sanitizeSignalBrainCfgRaw strips live runtime pollution", () => {
  const raw = sanitizeSignalBrainCfgRaw({
    v: 1,
    bot: {
      manualStrategy: "SUPERTREND_ELITE",
      eliteStRequireHtf4hAlign: true,
      eliteStRequireHtf1hEmaAlign: true,
      supertrendPeriod: 10,
      feed: { ok: true, symbol: "BNBUSDT" },
      account: { equity: 15000 },
      lastDecision: { action: "HOLD" },
      symbol: "BTCUSDT",
      timeframe: "1h",
    },
  });
  const b = raw.bot;
  assert.equal(b.manualStrategy, "SUPERTREND_ELITE");
  assert.equal(b.eliteStRequireHtf4hAlign, true);
  assert.equal(b.feed, undefined);
  assert.equal(b.account, undefined);
  assert.equal(b.lastDecision, undefined);
  assert.equal(b.symbol, undefined);
});

test("mergeMissingSignalBrainBot fills absent keys from live engine payload", () => {
  const client = {
    manualStrategy: "SUPERTREND_ELITE",
    supertrendPeriod: 10,
  };
  const engine = {
    manualStrategy: "SUPERTREND_ELITE",
    eliteStRequireHtf4hAlign: true,
    eliteStRequireHtf1hEmaAlign: true,
    eliteStMinAdx: 0,
  };
  mergeMissingSignalBrainBot(client, engine);
  assert.equal(client.eliteStRequireHtf4hAlign, true);
  assert.equal(client.eliteStRequireHtf1hEmaAlign, true);
  assert.equal(client.eliteStMinAdx, 0);
});

test("sanitizeSignalBrainCfgRaw preserves explicit false gate values", () => {
  const raw = sanitizeSignalBrainCfgRaw(
    {
      v: 1,
      bot: {
        manualStrategy: "SUPERTREND_ELITE",
        eliteStRequireHtf4hAlign: false,
        eliteStRequireHtf1hEmaAlign: false,
      },
    },
    {
      fillFrom: {
        bot: {
          eliteStRequireHtf4hAlign: true,
          eliteStRequireHtf1hEmaAlign: true,
        },
      },
    },
  );
  assert.equal(raw.bot.eliteStRequireHtf4hAlign, false);
  assert.equal(raw.bot.eliteStRequireHtf1hEmaAlign, false);
});

test("sanitizeBacktestConfigSnapshot keeps instance + backtest meta, drops runtime", () => {
  const snap = sanitizeBacktestConfigSnapshot({
    v: 1,
    bot: {
      manualStrategy: "SUPERTREND_ELITE",
      eliteStRequireHtf4hAlign: true,
      symbol: "BTCUSDT",
      timeframe: "1h",
      marketMode: "FUTURES",
      riskPerTrade: 5,
      backtestPositionSizing: "RISK_AT_SL",
      _engineVersion: "test-engine",
      feed: { ok: true },
      account: { equity: 1 },
      intradaySmcMaxHoldBars: 48,
    },
  });
  const b = snap.bot;
  assert.equal(b.symbol, "BTCUSDT");
  assert.equal(b.backtestPositionSizing, "RISK_AT_SL");
  assert.equal(b._engineVersion, "test-engine");
  assert.equal(b.eliteStRequireHtf4hAlign, true);
  assert.equal(b.feed, undefined);
  assert.equal(b.intradaySmcMaxHoldBars, undefined);
});

test("sanitizeSignalBrainCfgRaw strips cross-strategy pollution on Elite save", () => {
  const raw = sanitizeSignalBrainCfgRaw({
    v: 1,
    bot: {
      manualStrategy: "SUPERTREND_ELITE",
      eliteStHtf1hSepMode: "ADX",
      intradayGateSmcIct: true,
      intradaySmcMaxHoldBars: 48,
    },
  });
  assert.equal(raw.bot.intradayGateSmcIct, undefined);
  assert.equal(raw.bot.intradaySmcMaxHoldBars, undefined);
  assert.equal(raw.bot.eliteStHtf1hSepMode, "ADX");
  assert.ok(raw.byStrategy?.SUPERTREND_ELITE);
  assert.equal(raw.byStrategy.SUPERTREND_ELITE.intradayGateSmcIct, undefined);
});

test("isRuntimePollutionKey identifies WS-only fields", () => {
  assert.equal(isRuntimePollutionKey("feed"), true);
  assert.equal(isRuntimePollutionKey("eliteStMinAdx"), false);
});
