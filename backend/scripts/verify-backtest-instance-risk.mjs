#!/usr/bin/env node
/**
 * Verify instance backtest snapshot: SMC materialization must not inject preset 2.5% risk;
 * instance operational (10%) must survive strip → merge → materialize → reapply.
 *
 * Usage: node backend/scripts/verify-backtest-instance-risk.mjs
 */
import assert from "node:assert/strict";
import {
  stripInstanceFieldsFromCfgRaw,
  mergeInstanceIntoCfgRaw,
  applyInstanceOperationalToConfigSnapshot,
  uiOperationalPatchToInstColumns,
} from "../src/lib/strategyInstanceSplit.js";
import { materializeIntradayEngineCfgSync } from "../src/strategy/presets/srIntradayOptimized.js";
import { materializeIntradayPanelOnCfg } from "../src/strategy/intradayPanelKeys.js";

const strategyCfgRaw = {
  v: 1,
  bot: {
    manualStrategy: "SR_INTRADAY",
    strategyMode: "MANUAL",
    intradayGateSmcIct: true,
    intradaySmcIctProfile: "sweep",
    intradaySmcMinRr: 2,
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
  },
};

const instanceOp = uiOperationalPatchToInstColumns({
  riskPerTrade: 10,
  riskUnit: "PCT",
  marketMode: "FUTURES",
});

const base = stripInstanceFieldsFromCfgRaw(JSON.parse(JSON.stringify(strategyCfgRaw)));
assert.equal(base.bot.riskPerTrade, undefined, "strip removes legacy strategy risk");

const merged = mergeInstanceIntoCfgRaw(base, instanceOp);
assert.equal(merged.bot.riskPerTrade, 10, "merge applies instance risk");

let snap = JSON.parse(JSON.stringify(merged));
const engine = materializeIntradayEngineCfgSync(snap.bot, materializeIntradayPanelOnCfg);
snap = { v: 1, bot: engine };
applyInstanceOperationalToConfigSnapshot(snap, instanceOp);

assert.equal(snap.bot.riskPerTrade, 10, "after materialize + reapply risk is 10");
assert.notEqual(snap.bot.riskPerTrade, 2.5, "must not revert to ICT preset 2.5");
assert.equal(snap.bot.intradaySmcMinRr, 2, "SMC min R:R from saved strategy preserved");

console.log("OK instance backtest config parity:");
console.log("  riskPerTrade:", snap.bot.riskPerTrade);
console.log("  intradaySmcMinRr:", snap.bot.intradaySmcMinRr);
console.log("  intradayGateSmcIct:", snap.bot.intradayGateSmcIct);
