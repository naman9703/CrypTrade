/**
 * Trustworthy-validation primitives: Monte Carlo bootstrap on trade R-multiples,
 * purged walk-forward with embargo, and acceptance gates. Pure functions so they
 * can be unit-tested and reused by both the research scripts and the live
 * strategy validation flow.
 *
 * Why: thin edges look great in a single backtest by luck. These tools estimate
 * the *distribution* of outcomes (not the single realised path) and the
 * out-of-sample degradation, which is what actually predicts live behaviour.
 */

/** Mulberry32 — small deterministic PRNG so MC runs are reproducible. */
export function makeRng(seed = 0x9e3779b9) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.floor((p / 100) * sortedAsc.length)));
  return sortedAsc[idx];
}

/**
 * Monte Carlo bootstrap on a sequence of per-trade R-multiples.
 *
 * Each path resamples `rValues` WITH REPLACEMENT to the same length, compounds an
 * equity curve risking `riskFrac` of equity per trade (R × riskFrac × equity),
 * and records final return % and max drawdown %. We report the distribution and
 * the risk-of-ruin (paths whose equity ever drops by `ruinDrawdownPct`).
 *
 * @param {number[]} rValues per-trade R-multiples
 * @param {object} [opts]
 * @returns {{paths:number, p5ReturnPct:number, p50ReturnPct:number, p95ReturnPct:number,
 *   medianMaxDdPct:number, p95MaxDdPct:number, riskOfRuinPct:number, meanReturnPct:number}}
 */
export function monteCarloBootstrap(rValues, opts = {}) {
  const {
    paths = 2000,
    riskFrac = 0.01,
    ruinDrawdownPct = 50,
    seed = 12345,
  } = opts;
  const rs = (rValues || []).filter((r) => Number.isFinite(r));
  if (rs.length < 5) {
    return {
      paths: 0,
      p5ReturnPct: 0,
      p50ReturnPct: 0,
      p95ReturnPct: 0,
      medianMaxDdPct: 0,
      p95MaxDdPct: 0,
      riskOfRuinPct: 0,
      meanReturnPct: 0,
      insufficient: true,
    };
  }
  const rng = makeRng(seed);
  const returns = [];
  const maxDds = [];
  let ruinCount = 0;
  let returnSum = 0;
  for (let p = 0; p < paths; p++) {
    let equity = 1;
    let peak = 1;
    let maxDd = 0;
    let ruined = false;
    for (let i = 0; i < rs.length; i++) {
      const r = rs[Math.floor(rng() * rs.length)];
      equity *= 1 + r * riskFrac;
      if (equity <= 0) {
        equity = 0.0001;
        ruined = true;
      }
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      if (dd > maxDd) maxDd = dd;
      if (dd * 100 >= ruinDrawdownPct) ruined = true;
    }
    const ret = (equity - 1) * 100;
    returns.push(ret);
    returnSum += ret;
    maxDds.push(maxDd * 100);
    if (ruined) ruinCount++;
  }
  const retSorted = [...returns].sort((a, b) => a - b);
  const ddSorted = [...maxDds].sort((a, b) => a - b);
  return {
    paths,
    p5ReturnPct: percentile(retSorted, 5),
    p50ReturnPct: percentile(retSorted, 50),
    p95ReturnPct: percentile(retSorted, 95),
    meanReturnPct: returnSum / paths,
    medianMaxDdPct: percentile(ddSorted, 50),
    p95MaxDdPct: percentile(ddSorted, 95),
    riskOfRuinPct: (ruinCount / paths) * 100,
  };
}

/**
 * Purged walk-forward fold boundaries with an embargo gap between train and test
 * to prevent leakage from overlapping indicator lookbacks.
 *
 * Produces K expanding-or-rolling folds over [0, n). Each fold yields train
 * [trainStart, trainEnd) and test [testStart, testEnd) with an `embargo`-bar gap.
 *
 * @param {number} n number of bars (or trades)
 * @param {object} [opts]
 * @returns {Array<{fold:number, trainStart:number, trainEnd:number, testStart:number, testEnd:number}>}
 */
export function purgedWalkForwardSplits(n, opts = {}) {
  const { folds = 4, embargo = 0, mode = "rolling", minTrain = 0 } = opts;
  if (n <= 0 || folds <= 0) return [];
  const testSize = Math.floor(n / (folds + 1));
  if (testSize <= 0) return [];
  const splits = [];
  for (let k = 0; k < folds; k++) {
    const testStart = testSize * (k + 1);
    const testEnd = k === folds - 1 ? n : testStart + testSize;
    const trainEnd = Math.max(0, testStart - embargo);
    const trainStart = mode === "expanding" ? 0 : Math.max(0, trainEnd - testSize * (k + 1));
    if (trainEnd - trainStart < minTrain) continue;
    if (testEnd <= testStart) continue;
    splits.push({ fold: k, trainStart, trainEnd, testStart, testEnd });
  }
  return splits;
}

/**
 * Acceptance gates — a config is only "real" if all pass.
 * @param {object} args
 * @param {number} args.oosReturnPct out-of-sample (test) net return %
 * @param {number} args.mcP5ReturnPct Monte Carlo 5th-percentile return %
 * @param {number} args.calmar Calmar ratio (CAGR / maxDD)
 * @param {number} args.walkForwardDegradationPct (train - test)/train expectancy, in %
 */
export function acceptanceGates({ oosReturnPct, mcP5ReturnPct, calmar, walkForwardDegradationPct }) {
  const gates = {
    oosPositive: { pass: oosReturnPct > 0, value: oosReturnPct, threshold: "> 0" },
    mcP5Positive: { pass: mcP5ReturnPct > 0, value: mcP5ReturnPct, threshold: "> 0" },
    calmarOver1: { pass: Number(calmar) > 1, value: calmar, threshold: "> 1" },
    wfDegradationOk: {
      pass: walkForwardDegradationPct < 35,
      value: walkForwardDegradationPct,
      threshold: "< 35%",
    },
  };
  const allPass = Object.values(gates).every((g) => g.pass);
  return { allPass, gates };
}
