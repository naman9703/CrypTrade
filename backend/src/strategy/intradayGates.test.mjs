import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveIntradayGates,
  resolveIntradayEntryRequirements,
  resolveIntradayMinScore,
  countGatedTechniques,
} from "./intradayGates.js";

test("resolveIntradayGates defaults all on", () => {
  const g = resolveIntradayGates({});
  assert.equal(g.liquidity, true);
  assert.equal(g.htfRegime, true);
  assert.equal(g.institutionalSr, false);
});

test("institutional gate on only when explicit", () => {
  const g = resolveIntradayGates({ intradayGateInstitutionalSr: true });
  assert.equal(g.institutionalSr, true);
});

test("smc ict gate on only when explicit", () => {
  const g = resolveIntradayGates({ intradayGateSmcIct: true });
  assert.equal(g.smcIct, true);
  assert.equal(resolveIntradayGates({}).smcIct, false);
});

test("solo gate test lowers min techniques", () => {
  const g = resolveIntradayGates({
    intradayGateLiquidity: true,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
  });
  const req = resolveIntradayEntryRequirements({ intradaySoloGateTest: true }, g);
  assert.equal(req.minTechniqueCount, 1);
  assert.equal(req.requireFibOrVp, false);
});

test("countGatedTechniques ignores wick", () => {
  const g = resolveIntradayGates({ intradayGateLiquidity: true, intradayGateSession: false });
  assert.equal(countGatedTechniques(["liq_sweep", "wick", "vol"], g), 1);
});

test("resolveIntradayMinScore uses fib min for strict solo fib", () => {
  const g = resolveIntradayGates({
    intradayGateLiquidity: false,
    intradayGateSession: false,
    intradayGateFib: true,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
  });
  const req = resolveIntradayEntryRequirements({}, g);
  assert.equal(resolveIntradayMinScore({ srIntradayMinScore: 9 }, g, req), 10);
  assert.equal(resolveIntradayMinScore({}, g, req), 10);
});

test("resolveIntradayMinScore caps solo liquidity gate", () => {
  const g = resolveIntradayGates({
    intradayGateLiquidity: true,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
  });
  const req = resolveIntradayEntryRequirements({}, g);
  assert.equal(resolveIntradayMinScore({ srIntradayMinScore: 9 }, g, req), 5);
});

test("resolveIntradayMinScore uses SMC min when SMC gate on with legacy gates", () => {
  const g = resolveIntradayGates({
    intradayGateSmcIct: true,
    intradayGateLiquidity: true,
    intradayGateSession: true,
  });
  const req = resolveIntradayEntryRequirements({}, g);
  assert.equal(resolveIntradayMinScore({ intradaySmcMinScore: 7, srIntradayMinScore: 9 }, g, req), 7);
});

test("resolveIntradayMinScore keeps full stack threshold", () => {
  const g = resolveIntradayGates({});
  const req = resolveIntradayEntryRequirements({}, g);
  assert.equal(resolveIntradayMinScore({ srIntradayMinScore: 9 }, g, req), 9);
});
