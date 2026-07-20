/**
 * Institutional-grade LIQ feature research statistics (pure JS, no ML deps).
 * Bucket expectancy is primary; Pearson is supplementary.
 */

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mean(arr) {
  const xs = arr.filter((x) => x != null && Number.isFinite(x));
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

export function std(arr) {
  const xs = arr.filter((x) => x != null && Number.isFinite(x));
  if (xs.length < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

export function pearson(xs, ys, minN = 12) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    const y = ys[i];
    if (x != null && y != null && Number.isFinite(x) && Number.isFinite(y)) pairs.push([x, y]);
  }
  const n = pairs.length;
  if (n < minN) return null;
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let nume = 0;
  let dx = 0;
  let dy = 0;
  for (const [x, y] of pairs) {
    const a = x - mx;
    const b = y - my;
    nume += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? nume / den : null;
}

function rankValues(vals) {
  const indexed = vals.map((v, i) => ({ v, i })).filter((x) => x.v != null);
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(vals.length).fill(null);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avgRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

export function spearman(xs, ys, minN = 12) {
  return pearson(rankValues(xs), rankValues(ys), minN);
}

/** Histogram-based mutual information (nats). */
export function mutualInformation(xs, ys, bins = 8) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] != null && ys[i] != null) pairs.push([xs[i], ys[i]]);
  }
  if (pairs.length < 20) return null;
  const xVals = pairs.map(([x]) => x);
  const yVals = pairs.map(([, y]) => y);
  const xEdges = quantileEdges(xVals, bins);
  const yEdges = quantileEdges(yVals, bins);
  const joint = new Map();
  const px = new Map();
  const py = new Map();
  const n = pairs.length;
  for (const [x, y] of pairs) {
    const bx = binIndex(x, xEdges);
    const by = binIndex(y, yEdges);
    const key = `${bx}|${by}`;
    joint.set(key, (joint.get(key) ?? 0) + 1);
    px.set(bx, (px.get(bx) ?? 0) + 1);
    py.set(by, (py.get(by) ?? 0) + 1);
  }
  let mi = 0;
  for (const [key, cij] of joint) {
    const [bx, by] = key.split("|").map(Number);
    const pij = cij / n;
    const pi = (px.get(bx) ?? 0) / n;
    const pj = (py.get(by) ?? 0) / n;
    if (pij > 0 && pi > 0 && pj > 0) mi += pij * Math.log(pij / (pi * pj));
  }
  return mi;
}

function quantileEdges(vals, bins) {
  const sorted = [...vals].sort((a, b) => a - b);
  const edges = [];
  for (let i = 1; i < bins; i++) {
    const idx = Math.floor((i * sorted.length) / bins);
    edges.push(sorted[Math.min(sorted.length - 1, idx)]);
  }
  return edges;
}

function binIndex(v, edges) {
  let b = 0;
  for (const e of edges) {
    if (v > e) b++;
    else break;
  }
  return b;
}

export function winnerLoserSeparation(xs, wins) {
  const w = [];
  const l = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] == null || wins[i] == null) continue;
    if (wins[i] === 1) w.push(xs[i]);
    else l.push(xs[i]);
  }
  if (w.length < 8 || l.length < 8) return null;
  const mw = mean(w);
  const ml = mean(l);
  const sw = Math.sqrt(w.reduce((s, v) => s + (v - mw) ** 2, 0) / Math.max(1, w.length - 1));
  const sl = Math.sqrt(l.reduce((s, v) => s + (v - ml) ** 2, 0) / Math.max(1, l.length - 1));
  const pooled = Math.sqrt((sw ** 2 + sl ** 2) / 2);
  return { winnerMean: mw, loserMean: ml, cohensD: pooled > 0 ? (mw - ml) / pooled : null };
}

/**
 * Primary analysis: equal-frequency buckets + expectancy curve.
 * @returns {{ buckets: object[], monotonicity: number|null, bestBucket: object|null, spread: number|null }}
 */
export function bucketExpectancy(rows, feature, outcome = "rMultiple", nBuckets = 10) {
  const pairs = rows
    .map((r) => ({
      x: num(r[feature]),
      y: num(r[outcome]),
      win: num(r.win),
    }))
    .filter((p) => p.x != null);
  if (pairs.length < nBuckets * 3) return null;
  pairs.sort((a, b) => a.x - b.x);
  const n = pairs.length;
  const buckets = [];
  for (let b = 0; b < nBuckets; b++) {
    const lo = Math.floor((b * n) / nBuckets);
    const hi = Math.floor(((b + 1) * n) / nBuckets);
    const slice = pairs.slice(lo, hi);
    if (!slice.length) continue;
    const ys = slice.map((p) => p.y).filter((y) => y != null);
    const wins = slice.filter((p) => p.win === 1);
    buckets.push({
      bucket: b + 1,
      n: slice.length,
      featureMin: slice[0].x,
      featureMax: slice[slice.length - 1].x,
      featureMid: (slice[0].x + slice[slice.length - 1].x) / 2,
      avgR: mean(ys),
      winPct: slice.length ? (wins.length / slice.length) * 100 : 0,
    });
  }
  const mids = buckets.map((b) => b.featureMid);
  const avgRs = buckets.map((b) => b.avgR ?? 0);
  const monotonicity = buckets.length >= 4 ? spearman(mids, avgRs, 4) : null;
  const sorted = [...buckets].sort((a, b) => (b.avgR ?? -99) - (a.avgR ?? -99));
  const spread = sorted.length >= 2 ? (sorted[0].avgR ?? 0) - (sorted[sorted.length - 1].avgR ?? 0) : null;
  return {
    buckets,
    monotonicity,
    bestBucket: sorted[0] ?? null,
    worstBucket: sorted[sorted.length - 1] ?? null,
    spread,
  };
}

/** Permutation importance proxy (drop in |spearman| + MI when shuffled). */
export function permutationImportance(rows, feature, outcome = "rMultiple", shuffles = 12) {
  const xs = rows.map((r) => num(r[feature]));
  const ys = rows.map((r) => num(r[outcome]));
  const base =
    Math.abs(spearman(xs, ys) ?? 0) +
    Math.abs(pearson(xs, ys) ?? 0) * 0.5 +
    (mutualInformation(xs, ys) ?? 0);
  if (base <= 0) return { importance: 0, baseline: base };
  let drop = 0;
  for (let s = 0; s < shuffles; s++) {
    const shuffled = [...xs];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const perm =
      Math.abs(spearman(shuffled, ys) ?? 0) +
      Math.abs(pearson(shuffled, ys) ?? 0) * 0.5 +
      (mutualInformation(shuffled, ys) ?? 0);
    drop += Math.max(0, base - perm);
  }
  return { importance: drop / shuffles, baseline: base };
}

/** Simple depth-1 stump ensemble importance (mean |split gain|). */
export function stumpImportance(rows, feature, outcome = "rMultiple", stumps = 20) {
  const pairs = rows
    .map((r) => ({ x: num(r[feature]), y: num(r[outcome]) }))
    .filter((p) => p.x != null && p.y != null);
  if (pairs.length < 30) return null;
  const ys = pairs.map((p) => p.y);
  const baseVar = variance(ys);
  if (baseVar <= 0) return 0;
  let gain = 0;
  for (let t = 0; t < stumps; t++) {
    const idx = Math.floor(Math.random() * pairs.length);
    const thr = pairs[idx].x;
    const left = pairs.filter((p) => p.x <= thr).map((p) => p.y);
    const right = pairs.filter((p) => p.x > thr).map((p) => p.y);
    if (left.length < 5 || right.length < 5) continue;
    const g =
      baseVar -
      (left.length / pairs.length) * variance(left) -
      (right.length / pairs.length) * variance(right);
    gain += Math.max(0, g);
  }
  return gain / stumps;
}

function variance(arr) {
  const m = mean(arr);
  return arr.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, arr.length - 1);
}

export function correlationByGroup(rows, feature, outcome, groupKey) {
  const groups = new Map();
  for (const r of rows) {
    const g = String(r[groupKey] ?? "?");
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const out = {};
  for (const [g, subset] of groups) {
    if (subset.length < 15) continue;
    const xs = subset.map((r) => num(r[feature]));
    const ys = subset.map((r) => num(r[outcome]));
    out[g] = {
      n: subset.length,
      spearman: spearman(xs, ys),
      pearson: pearson(xs, ys),
      avgR: mean(ys),
    };
  }
  return out;
}

/** Stability = fraction of groups where spearman has same sign as global. */
export function stabilityScore(groupCorrs, globalSpearman) {
  const entries = Object.values(groupCorrs).filter((g) => g.spearman != null);
  if (!entries.length || globalSpearman == null) return null;
  const sign = Math.sign(globalSpearman);
  const same = entries.filter((g) => Math.sign(g.spearman) === sign && Math.abs(g.spearman) >= 0.05);
  return {
    tested: entries.length,
    consistent: same.length,
    ratio: same.length / entries.length,
    avgAbsSpearman: mean(entries.map((g) => Math.abs(g.spearman))),
  };
}

export function yearlyDrift(rows, feature, outcome = "rMultiple") {
  const byYear = new Map();
  for (const r of rows) {
    const y = r.entryYear ?? (r.entryTs ? new Date(Number(r.entryTs)).getUTCFullYear() : null);
    if (!y) continue;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(r);
  }
  const out = {};
  for (const [year, subset] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    const b = bucketExpectancy(subset, feature, outcome, 5);
    const xs = subset.map((r) => num(r[feature]));
    const ys = subset.map((r) => num(r[outcome]));
    out[year] = {
      n: subset.length,
      spearman: spearman(xs, ys),
      avgR: mean(ys),
      monotonicity: b?.monotonicity ?? null,
      bucketSpread: b?.spread ?? null,
    };
  }
  const spears = Object.values(out).map((v) => v.spearman).filter((v) => v != null);
  const signFlips =
    spears.length >= 2
      ? spears.slice(1).filter((s, i) => Math.sign(s) !== Math.sign(spears[i])).length
      : 0;
  return { byYear: out, signFlips, stable: signFlips <= 1 };
}

export function interactionGrid(rows, featA, featB, outcome = "rMultiple", bins = 4) {
  const pairs = rows
    .map((r) => ({ a: num(r[featA]), b: num(r[featB]), y: num(r[outcome]) }))
    .filter((p) => p.a != null && p.b != null && p.y != null);
  if (pairs.length < bins * bins * 3) return null;
  const aEdges = quantileEdges(pairs.map((p) => p.a), bins);
  const bEdges = quantileEdges(pairs.map((p) => p.b), bins);
  const cells = [];
  for (let ia = 0; ia <= bins; ia++) {
    for (let ib = 0; ib <= bins; ib++) {
      const cell = pairs.filter((p) => binIndex(p.a, aEdges) === ia && binIndex(p.b, bEdges) === ib);
      if (cell.length < 5) continue;
      cells.push({
        aBin: ia + 1,
        bBin: ib + 1,
        n: cell.length,
        avgR: mean(cell.map((p) => p.y)),
      });
    }
  }
  const marginalA = bucketExpectancy(rows, featA, outcome, bins);
  const marginalB = bucketExpectancy(rows, featB, outcome, bins);
  const best = [...cells].sort((x, y) => (y.avgR ?? -99) - (x.avgR ?? -99))[0];
  const base = mean(pairs.map((p) => p.y));
  const lift = best && base != null ? (best.avgR ?? 0) - base : null;
  return { cells, bestCell: best, lift, marginalA: marginalA?.spread, marginalB: marginalB?.spread };
}

export function categoricalInteraction(rows, catA, catB, outcome = "rMultiple") {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r[catA] ?? "?"}|${r[catB] ?? "?"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(num(r[outcome]));
  }
  const cells = [...groups.entries()]
    .map(([key, ys]) => {
      const [a, b] = key.split("|");
      const valid = ys.filter((y) => y != null);
      return { a, b, n: valid.length, avgR: mean(valid) };
    })
    .filter((c) => c.n >= 8)
    .sort((x, y) => (y.avgR ?? -99) - (x.avgR ?? -99));
  const base = mean(rows.map((r) => num(r[outcome])).filter((y) => y != null));
  return { cells: cells.slice(0, 20), best: cells[0] ?? null, lift: cells[0] && base != null ? cells[0].avgR - base : null };
}

export function incrementalValue(rows, feature, controlFeature, outcome = "rMultiple") {
  const ys = rows.map((r) => num(r[outcome]));
  const xs = rows.map((r) => num(r[feature]));
  const cs = rows.map((r) => num(r[controlFeature]));
  const miAlone = mutualInformation(xs, ys);
  const residuals = [];
  const cPairs = [];
  for (let i = 0; i < rows.length; i++) {
    if (ys[i] != null && cs[i] != null) cPairs.push([cs[i], ys[i]]);
  }
  const cCorr = pearson(cPairs.map((p) => p[0]), cPairs.map((p) => p[1])) ?? 0;
  for (let i = 0; i < rows.length; i++) {
    if (ys[i] == null || cs[i] == null) {
      residuals.push(null);
      continue;
    }
    residuals.push(ys[i] - cCorr * cs[i]);
  }
  const miResidual = mutualInformation(xs, residuals);
  return {
    miAlone,
    miAfterControl: miResidual,
    incremental: (miResidual ?? 0) - Math.max(0, (miAlone ?? 0) - (miResidual ?? 0)),
    addsInformation: (miResidual ?? 0) >= (miAlone ?? 0) * 0.7,
  };
}

export function evidenceChecklist(report) {
  const mono = Math.abs(report.bucket?.monotonicity ?? 0);
  const spread = Math.abs(report.bucket?.spread ?? 0);
  const coin = report.coinStability?.ratio ?? 0;
  const regime = report.regimeStability?.ratio ?? 0;
  const drift = report.drift?.stable ?? false;
  const perm = report.permutation?.importance ?? 0;
  const incr = report.incremental?.addsInformation ?? false;

  const checks = {
    predictiveStrength: spread >= 0.15 || mono >= 0.25 || (report.mutualInfo ?? 0) >= 0.02,
    monotonicity: mono >= 0.35 && spread >= 0.1,
    coinStability: coin >= 0.6 && (report.coinStability?.tested ?? 0) >= 2,
    regimeStability: regime >= 0.5 || (report.regimeStability?.tested ?? 0) < 2,
    driftStable: drift || (report.drift?.signFlips ?? 99) <= 1,
    incrementalValue: incr || perm >= 0.02,
  };
  const passed = Object.values(checks).filter(Boolean).length;
  let recommendation = "IGNORE";
  if (checks.predictiveStrength && checks.monotonicity && checks.coinStability) recommendation = "USE";
  else if (checks.predictiveStrength && (checks.monotonicity || checks.coinStability)) recommendation = "PARTIAL";
  else if (passed >= 3) recommendation = "REVIEW";

  return { checks, passed, total: Object.keys(checks).length, recommendation };
}

export function analyzeFeature(rows, feature, opts = {}) {
  const outcome = opts.outcome ?? "rMultiple";
  const xs = rows.map((r) => num(r[feature]));
  const ys = rows.map((r) => num(r[outcome]));
  const wins = rows.map((r) => num(r.win));

  const bucket = bucketExpectancy(rows, feature, outcome, opts.buckets ?? 10);
  const coinCorrs = correlationByGroup(rows, feature, outcome, "symbol");
  const regimeCorrs = correlationByGroup(rows, feature, outcome, "marketState_regime");
  const globalSpearman = spearman(xs, ys);

  const report = {
    feature,
    n: rows.filter((r) => num(r[feature]) != null).length,
    pearson: pearson(xs, ys),
    spearman: globalSpearman,
    mutualInfo: mutualInformation(xs, ys),
    separation: winnerLoserSeparation(xs, wins),
    bucket,
    permutation: permutationImportance(rows, feature, outcome),
    stumpGain: stumpImportance(rows, feature, outcome),
    coinStability: stabilityScore(coinCorrs, globalSpearman),
    coinCorrelations: coinCorrs,
    regimeStability: stabilityScore(regimeCorrs, globalSpearman),
    regimeCorrelations: regimeCorrs,
    drift: yearlyDrift(rows, feature, outcome),
  };

  if (opts.controlFeature) {
    report.incremental = incrementalValue(rows, feature, opts.controlFeature, outcome);
  }

  report.evidence = evidenceChecklist(report);
  return report;
}

export const CORE_RESEARCH_FEATURES = [
  "cont_score",
  "cont_opposingR",
  "cont_opposingAtr",
  "cont_dailyRangeUsed",
  "cont_remainingAtr",
  "cont_trendMaturity",
  "sweep_velocityAtr",
  "sweep_velocity",
  "sweep_attemptCount",
  "sweep_volSpike",
  "sweep_absorption",
  "sweep_exhaustion",
  "disp_impulseAtr",
  "disp_bodyEfficiency",
  "disp_overlap",
  "disp_momentum",
  "disp_atrExpansion",
  "level_importance",
  "marketState_adx",
  "marketState_confidence",
  "marketState_atrPct",
  "scoreV2_total",
  "scoreV2_continuationRoom",
  "scoreV2_sweepQuality",
  "scoreV2_displacement",
  "scoreV2_htfAlign",
  "scoreV2_levelImportance",
  "scoreV2_sessionNarrative",
  "liqQuality",
  "weightedQuality",
  "rr",
];

export const INTERACTION_PAIRS = [
  ["sweep_velocityAtr", "level_importance"],
  ["cont_opposingR", "level_importance"],
  ["sweep_velocityAtr", "cont_opposingR"],
  ["disp_impulseAtr", "cont_score"],
  ["sweep_absorption", "level_importance"],
  ["marketState_adx", "cont_score"],
];

export const CATEGORICAL_INTERACTIONS = [
  ["level_type", "marketState_regime"],
  ["sessionNarrative", "level_type"],
  ["cont_expansionState", "marketState_regime"],
];

export function buildDashboard(featureReports, interactions = []) {
  return featureReports
    .map((r) => ({
      feature: r.feature,
      importance:
        (r.permutation?.importance ?? 0) * 2 +
        Math.abs(r.bucket?.spread ?? 0) +
        Math.abs(r.spearman ?? 0) * 0.5 +
        (r.mutualInfo ?? 0) * 3,
      spearman: r.spearman,
      mutualInfo: r.mutualInfo,
      monotonicity: r.bucket?.monotonicity,
      bucketSpread: r.bucket?.spread,
      coinStable: r.coinStability?.ratio,
      regimeStable: r.regimeStability?.ratio,
      driftStable: r.drift?.stable,
      recommendation: r.evidence?.recommendation,
      evidencePassed: r.evidence?.passed,
      evidenceTotal: r.evidence?.total,
    }))
    .sort((a, b) => b.importance - a.importance)
    .map((row, i) => ({ rank: i + 1, ...row, topInteractions: interactions.filter((x) => x.features?.includes(row.feature)).slice(0, 2) }));
}

export function dashboardToMarkdown(dashboard, meta = {}) {
  const lines = [
    "# LIQ Research Dashboard",
    "",
    `Generated: ${meta.generatedAt ?? new Date().toISOString()}`,
    `Trades: ${meta.totalRows ?? "?"} | Coins: ${meta.coins ?? "?"} | Window: ${meta.window ?? "?"}`,
    "",
    "## Feature Evidence Table",
    "",
    "| Rank | Feature | Importance | Monotonic | Coin Stable | Drift OK | Evidence | Use? |",
    "|------|---------|------------|-----------|-------------|----------|----------|------|",
  ];
  for (const r of dashboard) {
    lines.push(
      `| ${r.rank} | ${r.feature} | ${r.importance.toFixed(3)} | ${fmt(r.monotonicity)} | ${fmtPct(r.coinStable)} | ${r.driftStable ? "✅" : "❌"} | ${r.evidencePassed}/${r.evidenceTotal} | **${r.recommendation}** |`,
    );
  }
  lines.push("", "## Notes", "", "- Bucket spread + monotonicity are primary signals; Pearson/Spearman are supplementary.", "- USE = passes predictive strength + monotonicity + coin stability checklist.", "- PARTIAL = useful in some contexts; do not hard-gate.", "- IGNORE = no measurable edge or unstable across assets/years.", "");
  return lines.join("\n");
}

function fmt(v) {
  return v == null ? "—" : Number(v).toFixed(2);
}
function fmtPct(v) {
  return v == null ? "—" : `${(v * 100).toFixed(0)}%`;
}

/** Bootstrap 95% CI for mean of outcome (uncertainty estimate). */
export function bootstrapMeanCI(values, iterations = 400, alpha = 0.05) {
  const xs = values.filter((v) => v != null && Number.isFinite(v));
  if (xs.length < 20) return null;
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < xs.length; j++) {
      sum += xs[Math.floor(Math.random() * xs.length)];
    }
    means.push(sum / xs.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor((alpha / 2) * means.length)];
  const hi = means[Math.floor((1 - alpha / 2) * means.length) - 1];
  return { mean: mean(xs), ciLow: lo, ciHigh: hi, n: xs.length };
}

/** Permutation test p-value: is observed |spearman| greater than shuffled null? */
export function permutationPValue(rows, feature, outcome = "rMultiple", iterations = 300) {
  const xs = rows.map((r) => num(r[feature]));
  const ys = rows.map((r) => num(r[outcome]));
  const observed = Math.abs(spearman(xs, ys) ?? 0);
  if (!observed) return { pValue: 1, observed: 0 };
  let exceed = 0;
  for (let i = 0; i < iterations; i++) {
    const shuffled = [...ys];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    if (Math.abs(spearman(xs, shuffled) ?? 0) >= observed) exceed++;
  }
  return { pValue: exceed / iterations, observed };
}

/** Walk-forward fold analysis — research window frozen before validation window. */
export function walkForwardFolds(rows, folds) {
  return folds.map((fold) => {
    const train = rows.filter((r) => {
      const y = num(r.entryYear);
      return y != null && y >= fold.trainFrom && y <= fold.trainTo;
    });
    const validate = rows.filter((r) => {
      const y = num(r.entryYear);
      return y != null && y >= fold.validateFrom && y <= fold.validateTo;
    });
    return { ...fold, trainN: train.length, validateN: validate.length, train, validate };
  });
}

export const CANDIDATE_OUTCOMES = [
  "fwd_closeR_5",
  "fwd_closeR_10",
  "fwd_closeR_20",
  "fwd_closeR_50",
  "fwd_mfeR_5",
  "fwd_mfeR_10",
  "fwd_mfeR_20",
  "fwd_mfeR_50",
  "fwd_maeR_10",
  "fwd_maeR_20",
  "mfeR",
  "maeR",
  "hit1R_flag",
  "hit2R_flag",
  "hit3R_flag",
  "firstHit_plus1R",
  "firstHit_sl",
  "probReach1R",
  "endCloseR",
  "opposingLiquidityReached",
  "timeToMfeBars",
];

/** Benjamini–Hochberg FDR correction for multiple hypothesis tests. */
export function benjaminiHochberg(tests, fdr = 0.1) {
  const sorted = [...tests]
    .map((t, i) => ({ ...t, originalIndex: i }))
    .filter((t) => t.pValue != null && Number.isFinite(t.pValue))
    .sort((a, b) => a.pValue - b.pValue);
  const m = sorted.length;
  if (!m) return tests.map((t) => ({ ...t, fdrSignificant: false, fdrAdjustedP: null }));

  const adjusted = new Array(m);
  let minAdj = 1;
  for (let i = m - 1; i >= 0; i--) {
    const adj = Math.min(minAdj, (sorted[i].pValue * m) / (i + 1));
    minAdj = adj;
    adjusted[i] = adj;
  }

  const out = tests.map((t) => ({ ...t, fdrSignificant: false, fdrAdjustedP: null }));
  sorted.forEach((t, i) => {
    out[t.originalIndex] = {
      ...out[t.originalIndex],
      fdrAdjustedP: adjusted[i],
      fdrSignificant: adjusted[i] <= fdr,
    };
  });
  return out;
}

/** Per-slice bucket analysis (coin, regime, year). */
export function sliceValidation(rows, feature, outcome, sliceKey) {
  const groups = new Map();
  for (const r of rows) {
    const k = String(r[sliceKey] ?? "?");
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const slices = {};
  for (const [key, subset] of groups) {
    if (subset.length < 25) continue;
    const b = bucketExpectancy(subset, feature, outcome, 6);
    slices[key] = {
      n: subset.length,
      monotonicity: b?.monotonicity,
      spread: b?.spread,
      avgOutcome: mean(subset.map((r) => num(r[outcome])).filter((v) => v != null)),
    };
  }
  const entries = Object.values(slices);
  const positive = entries.filter((s) => (s.spread ?? 0) > 0 && (s.monotonicity ?? 0) > 0);
  return {
    tested: entries.length,
    positive: positive.length,
    ratio: entries.length ? positive.length / entries.length : 0,
    slices,
  };
}

/** Information gain proxy — mutual information as uncertainty reduction score. */
export function informationGain(rows, feature, outcome = "fwd_closeR_20") {
  const mi = mutualInformation(
    rows.map((r) => num(r[feature])),
    rows.map((r) => num(r[outcome])),
  );
  return {
    mutualInfo: mi,
    informationGain: mi,
    researchPoolWorthy: (mi ?? 0) >= 0.01,
    note: "Features with IG ≥ 0.01 may stay in research pool even if not promoted alone",
  };
}

/** Count coins where feature slice shows positive spread + monotonicity. */
export function perCoinPositiveCount(sliceReport) {
  if (!sliceReport?.slices) return 0;
  return Object.values(sliceReport.slices).filter(
    (s) => (s.spread ?? 0) > 0 && (s.monotonicity ?? 0) > 0,
  ).length;
}

export const HOLDOUT_FOLD = { label: "HOLDOUT", from: 2026, to: 2026 };

export function holdoutEvaluate(rows, feature, outcome = "fwd_closeR_20") {
  const hold = rows.filter((r) => num(r.entryYear) === HOLDOUT_FOLD.from);
  if (hold.length < 20) return { n: hold.length, sufficient: false };
  const b = bucketExpectancy(hold, feature, outcome, 6);
  return {
    n: hold.length,
    sufficient: true,
    monotonicity: b?.monotonicity,
    spread: b?.spread,
    avgOutcome: mean(hold.map((r) => num(r[outcome])).filter((v) => v != null)),
  };
}

export function selectionBiasCompare(rows, feature, outcome = "fwd_closeR_20") {
  const all = bucketExpectancy(rows, feature, outcome, 8);
  const picked = bucketExpectancy(rows.filter((r) => num(r.selectedByDayPicker) === 1), feature, outcome, 8);
  const rejected = bucketExpectancy(
    rows.filter((r) => num(r.selectedByDayPicker) === 0),
    feature,
    outcome,
    8,
  );
  return {
    all: { n: rows.length, spread: all?.spread, mono: all?.monotonicity },
    picked: {
      n: rows.filter((r) => num(r.selectedByDayPicker) === 1).length,
      spread: picked?.spread,
      mono: picked?.monotonicity,
    },
    rejected: {
      n: rows.filter((r) => num(r.selectedByDayPicker) === 0).length,
      spread: rejected?.spread,
      mono: rejected?.monotonicity,
    },
  };
}
