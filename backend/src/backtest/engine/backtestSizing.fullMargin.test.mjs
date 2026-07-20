import test from "node:test";
import assert from "node:assert/strict";
import { computeEntryQtyDetailed } from "./backtestSizing.js";
import { resolveCostModel } from "./costModel.js";

test("RISK_AT_SL_FULL_MARGIN uses full margin and dynamic leverage for tight stop", () => {
  const cm = resolveCostModel({ marketMode: "FUTURES", futuresLeverage: 12 });
  const equity = 108.94;
  const entry = 3167.47;
  const sl = 3146.85;
  const sizing = computeEntryQtyDetailed({
    equity,
    entryFill: entry,
    sl,
    cfg: { backtestPositionSizing: "RISK_AT_SL_FULL_MARGIN", riskPerTrade: 2, riskPerTradeUnit: "PCT" },
    cm,
    isFutures: true,
  });
  const slDist = Math.abs(entry - sl);
  const dollarRisk = equity * 0.02;
  assert.ok(Math.abs(sizing.marginUsdt - equity) < 0.05, `margin ${sizing.marginUsdt} ≈ equity`);
  assert.ok(sizing.effectiveLeverage > 1 && sizing.effectiveLeverage < 12, `lev ${sizing.effectiveLeverage}`);
  const riskAtSl = sizing.qty * slDist;
  assert.ok(Math.abs(riskAtSl - dollarRisk) < 0.05, `risk ${riskAtSl} ≈ ${dollarRisk}`);
});

test("RISK_AT_SL_FULL_MARGIN matches RISK_AT_SL qty when leverage not capped", () => {
  const cm = resolveCostModel({ marketMode: "FUTURES", futuresLeverage: 12 });
  const equity = 108.94;
  const entry = 3167.47;
  const sl = 3146.85;
  const base = { equity, entryFill: entry, sl, cm, isFutures: true, cfg: { riskPerTrade: 2, riskPerTradeUnit: "PCT" } };
  const fixed = computeEntryQtyDetailed({ ...base, cfg: { ...base.cfg, backtestPositionSizing: "RISK_AT_SL" } });
  const dynamic = computeEntryQtyDetailed({
    ...base,
    cfg: { ...base.cfg, backtestPositionSizing: "RISK_AT_SL_FULL_MARGIN" },
  });
  assert.ok(Math.abs(fixed.qty - dynamic.qty) < 1e-6, `qty ${fixed.qty} vs ${dynamic.qty}`);
});

test("RISK_AT_SL_FULL_MARGIN uses partial margin when stop is very wide", () => {
  const cm = resolveCostModel({ marketMode: "FUTURES", futuresLeverage: 12 });
  const equity = 100;
  const entry = 3000;
  const sl = 2895; // 3.5% stop → L < 1 at 2% risk
  const sizing = computeEntryQtyDetailed({
    equity,
    entryFill: entry,
    sl,
    cfg: { backtestPositionSizing: "RISK_AT_SL_FULL_MARGIN", riskPerTrade: 2, riskPerTradeUnit: "PCT" },
    cm,
    isFutures: true,
  });
  assert.equal(sizing.effectiveLeverage, 1);
  assert.ok(sizing.marginUsdt < equity * 0.99, `partial margin ${sizing.marginUsdt}`);
  const riskAtSl = sizing.qty * Math.abs(entry - sl);
  assert.ok(Math.abs(riskAtSl - 2) < 0.05);
});
