/**
 * Discover market behaviors via candidate feature clustering.
 * Clusters are data-driven; manual taxonomy is for interpretation only.
 */
import { mean, num } from "./liqResearchStats.js";

const CLUSTER_FEATURES = [
  "cont_score",
  "sweep_velocityAtr",
  "level_importance",
  "marketState_adx",
  "scoreV2_total",
];

const BEHAVIOR_LABELS = {
  high_cont_low_adx: "Post-sweep continuation (range)",
  high_cont_high_adx: "Trend acceleration / continuation",
  low_cont_high_velocity: "Liquidity removal / sweep",
  low_score_high_mae: "Breakout failure / reversal",
  high_adx_high_velocity: "Volatility expansion",
  default: "Unclassified cluster",
};

function extractVector(row, features) {
  return features.map((f) => num(row[f]) ?? 0);
}

function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

function normalizeMatrix(vectors) {
  const dims = vectors[0]?.length ?? 0;
  const mins = new Array(dims).fill(Infinity);
  const maxs = new Array(dims).fill(-Infinity);
  for (const v of vectors) {
    for (let d = 0; d < dims; d++) {
      mins[d] = Math.min(mins[d], v[d]);
      maxs[d] = Math.max(maxs[d], v[d]);
    }
  }
  return vectors.map((v) =>
    v.map((x, d) => {
      const range = maxs[d] - mins[d];
      return range > 0 ? (x - mins[d]) / range : 0;
    }),
  );
}

/** Simple k-means (no external deps). */
function kMeans(vectors, k, maxIter = 50) {
  const n = vectors.length;
  if (n < k) return { assignments: vectors.map(() => 0), centroids: [vectors[0]] };

  const step = Math.floor(n / k);
  let centroids = Array.from({ length: k }, (_, i) => [...vectors[Math.min(i * step, n - 1)]]);
  let assignments = new Array(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const d = euclidean(vectors[i], centroids[c]);
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        changed = true;
      }
    }
    if (!changed) break;

    for (let c = 0; c < k; c++) {
      const members = vectors.filter((_, i) => assignments[i] === c);
      if (!members.length) continue;
      centroids[c] = centroids[c].map((_, d) => mean(members.map((m) => m[d])));
    }
  }

  return { assignments, centroids };
}

function interpretCluster(centroid, features) {
  const map = Object.fromEntries(features.map((f, i) => [f, centroid[i]]));
  if (map.cont_score > 0.6 && map.marketState_adx < 0.4) return BEHAVIOR_LABELS.high_cont_low_adx;
  if (map.cont_score > 0.6 && map.marketState_adx >= 0.4) return BEHAVIOR_LABELS.high_cont_high_adx;
  if (map.cont_score < 0.4 && map.sweep_velocityAtr > 0.5) return BEHAVIOR_LABELS.low_cont_high_velocity;
  if (map.scoreV2_total < 0.4 && map.level_importance > 0.5) return BEHAVIOR_LABELS.low_score_high_mae;
  if (map.marketState_adx > 0.6 && map.sweep_velocityAtr > 0.5) return BEHAVIOR_LABELS.high_adx_high_velocity;
  return BEHAVIOR_LABELS.default;
}

/**
 * Cluster candidates and summarize outcome distributions per cluster.
 */
export function discoverBehaviorClusters(rows, k = 6, outcome = "fwd_closeR_20") {
  const valid = rows.filter((r) => CLUSTER_FEATURES.every((f) => num(r[f]) != null));
  if (valid.length < k * 10) return { sufficient: false, n: valid.length };

  const raw = valid.map((r) => extractVector(r, CLUSTER_FEATURES));
  const normalized = normalizeMatrix(raw);
  const { assignments, centroids } = kMeans(normalized, k);

  const clusters = [];
  for (let c = 0; c < k; c++) {
    const members = valid.filter((_, i) => assignments[i] === c);
    if (!members.length) continue;
    const outcomes = members.map((m) => num(m[outcome])).filter((v) => v != null);
    clusters.push({
      clusterId: c,
      n: members.length,
      suggestedBehavior: interpretCluster(centroids[c], CLUSTER_FEATURES),
      centroid: Object.fromEntries(CLUSTER_FEATURES.map((f, i) => [f, Number(centroids[c][i].toFixed(3))])),
      avgOutcome: mean(outcomes),
      pHit1R: mean(members.map((m) => num(m.hit1R_flag))),
      pSlFirst: mean(members.map((m) => num(m.firstHit_sl))),
      symbols: [...new Set(members.map((m) => m.symbol))],
    });
  }

  clusters.sort((a, b) => b.n - a.n);

  return {
    sufficient: true,
    n: valid.length,
    k,
    features: CLUSTER_FEATURES,
    clusters,
    note: "Discovered clusters — map to manual taxonomy for interpretation, not validation",
  };
}
