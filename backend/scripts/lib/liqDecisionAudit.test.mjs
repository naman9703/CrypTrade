import test from "node:test";
import assert from "node:assert/strict";
import { runDecisionAudit, auditDecisionDay } from "./liqDecisionAudit.js";

const base = {
  symbol: "BTCUSDT",
  dayId: 100,
  side: "BUY",
  outcome: "fwd_closeR_20",
};

test("auditDecisionDay detects rejected-better-than-picked", () => {
  const group = {
    ...base,
    n: 3,
    all: [
      { candidateKey: "a", selectedByDayPicker: 1, weightedQuality: 90, fwd_closeR_20: 0.2, entryTs: 1000 },
      { candidateKey: "b", selectedByDayPicker: 0, weightedQuality: 70, fwd_closeR_20: 1.1, entryTs: 2000 },
      { candidateKey: "c", selectedByDayPicker: 0, weightedQuality: 60, fwd_closeR_20: -0.3, entryTs: 3000 },
    ],
    picked: [{ candidateKey: "a", selectedByDayPicker: 1, weightedQuality: 90, fwd_closeR_20: 0.2, entryTs: 1000 }],
    rejected: [
      { candidateKey: "b", selectedByDayPicker: 0, weightedQuality: 70, fwd_closeR_20: 1.1, entryTs: 2000 },
      { candidateKey: "c", selectedByDayPicker: 0, weightedQuality: 60, fwd_closeR_20: -0.3, entryTs: 3000 },
    ],
  };
  const a = auditDecisionDay(group);
  assert.equal(a.rejectedBetter, true);
  assert.ok(a.oracleGap > 0.8);
  assert.equal(a.pickerMatchedScore, true);
  assert.equal(a.pickerMatchedOracle, false);
});

test("runDecisionAudit summary shows picker underperformance", () => {
  const rows = [
    { symbol: "BTCUSDT", dayId: 1, side: "BUY", selectedByDayPicker: 1, weightedQuality: 80, fwd_closeR_20: 0.1, entryTs: 1 },
    { symbol: "BTCUSDT", dayId: 1, side: "BUY", selectedByDayPicker: 0, weightedQuality: 60, fwd_closeR_20: 0.9, entryTs: 2 },
    { symbol: "BTCUSDT", dayId: 2, side: "SELL", selectedByDayPicker: 1, weightedQuality: 70, fwd_closeR_20: -0.2, entryTs: 3 },
    { symbol: "BTCUSDT", dayId: 2, side: "SELL", selectedByDayPicker: 0, weightedQuality: 50, fwd_closeR_20: 0.5, entryTs: 4 },
  ];
  const r = runDecisionAudit(rows);
  assert.ok(r.summary.pickedMinusRejected < 0);
  assert.ok(r.diagnosis.some((d) => d.includes("picker_negative")));
});
