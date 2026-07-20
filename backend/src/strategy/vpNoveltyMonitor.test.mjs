import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyVpPath,
  classifyVpMacro,
  buildVpConditionCellKey,
  describeVpConditionCell,
} from "./vpConditionCell.js";
import {
  createVpNoveltyMonitor,
  recordVpCellOutcome,
  decideVpNovelty,
  resetVpCell,
} from "./vpNoveltyMonitor.js";
import { evaluateInstitutionalRiskOverlay } from "../risk/institutionalRiskOverlay.js";

test("prepared regime — ETH blockCellKeys denies weak_bear vacuum VAL", async () => {
  const { passesVpPreparedRegimeFilter } = await import("./volumeProfileStrategy.js");
  const pre = {
    macroAboveEma20d: [false],
    macroEma5dSlope: [0],
    macroPrior20d: [-0.02],
    macroPrior60d: [-0.03], // weak_bear (not deep enough for bear_trend)
  };
  const opts = {
    vpPreparedBlockCellKeys: ["SELL|val_breakdown|weak_bear|vacuum"],
    vpPreparedBlockVacuumVah: false,
    vpPreparedBlockVacuumValBear: false,
  };
  assert.equal(
    passesVpPreparedRegimeFilter(pre, 0, "SELL", "val_breakdown", { distPct: 0.03 }, opts),
    false,
  );
  // Prepared ETH edge cell must stay open (bear vacuum VAL not on deny list)
  const preBear = {
    macroAboveEma20d: [false],
    macroEma5dSlope: [0],
    macroPrior20d: [-0.1],
    macroPrior60d: [-0.12],
  };
  assert.equal(
    passesVpPreparedRegimeFilter(preBear, 0, "SELL", "val_breakdown", { distPct: 0.03 }, opts),
    true,
  );
});

test("path/macro labels", () => {
  assert.equal(classifyVpPath(0.03), "vacuum");
  assert.equal(classifyVpPath(0.015), "structured");
  assert.equal(classifyVpPath(0.005), "tight");
  assert.equal(classifyVpMacro(-0.12, false), "bear_trend");
  assert.equal(classifyVpMacro(0.08, true), "bull_trend");
  assert.equal(buildVpConditionCellKey("buy", "vah_breakout", "bull_trend", "vacuum"), "BUY|vah_breakout|bull_trend|vacuum");
});

test("describe cell from pre", () => {
  const pre = {
    macroAboveEma20d: [false],
    macroEma5dSlope: [0],
    macroPrior20d: [-0.1],
    macroPrior60d: [-0.12],
  };
  const cell = describeVpConditionCell(pre, 0, "SELL", "val_breakdown", { distPct: 0.03 }, {});
  assert.equal(cell.macro, "bear_trend");
  assert.equal(cell.path, "vacuum");
  assert.equal(cell.key, "SELL|val_breakdown|bear_trend|vacuum");
});

test("novelty kill-switch disables after rolling bleed", () => {
  const mon = createVpNoveltyMonitor({
    minOutcomes: 5,
    rollingWindow: 10,
    minExpectancyR: -0.05,
    minWinRate: 0.35,
    preparedCells: ["BUY|va_rejection|bull_trend|structured"],
  });
  const key = "BUY|va_rejection|bull_trend|structured";
  assert.equal(decideVpNovelty(mon, key).allow, true);
  for (let i = 0; i < 6; i++) recordVpCellOutcome(mon, key, -0.5);
  const d = decideVpNovelty(mon, key);
  assert.equal(d.allow, false);
  assert.equal(d.classification, "disabled");
  resetVpCell(mon, key);
  assert.equal(decideVpNovelty(mon, key).allow, true);
});

test("allowlist abstains unknown cells", () => {
  const mon = createVpNoveltyMonitor({
    allowlistOnly: true,
    preparedCells: ["BUY|va_rejection|bull_trend|structured"],
  });
  assert.equal(decideVpNovelty(mon, "BUY|va_rejection|bull_trend|structured").allow, true);
  assert.equal(decideVpNovelty(mon, "BUY|vah_breakout|bull_trend|vacuum").allow, false);
});

test("unknown size_down policy", () => {
  const mon = createVpNoveltyMonitor({
    unknownPolicy: "size_down",
    unknownSizeMult: 0.5,
    preparedCells: ["A"],
  });
  const d = decideVpNovelty(mon, "UNKNOWN");
  assert.equal(d.allow, true);
  assert.equal(d.sizeMult, 0.5);
  assert.equal(d.classification, "unknown");
});

test("institutional risk overlay kill switch", () => {
  const r = evaluateInstitutionalRiskOverlay({
    equity: 80,
    peakEquity: 100,
    weekStartEquity: 100,
    cfg: { riskKillSwitchDdPct: 15 },
  });
  assert.equal(r.blocked, "killSwitch");
});

test("institutional risk overlay consecutive losses", () => {
  const trades = [
    { netPnl: -1, exitTs: Date.UTC(2026, 0, 1, 12) },
    { netPnl: -1, exitTs: Date.UTC(2026, 0, 1, 14) },
    { netPnl: -1, exitTs: Date.UTC(2026, 0, 1, 16) },
  ];
  const day = Math.floor(Date.UTC(2026, 0, 1, 18) / 86_400_000) * 86_400_000;
  const r = evaluateInstitutionalRiskOverlay({
    equity: 100,
    peakEquity: 100,
    weekStartEquity: 100,
    barDayMs: day,
    trades,
    cfg: { riskConsecutiveLossLimit: 3 },
  });
  assert.equal(r.blocked, "consecCooldown");
});
