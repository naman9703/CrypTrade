/**
 * Learn a suggested min composite signal strength (0–100) from resolved list outcomes (True/False)
 * vs SS at each flip, matching the chart “efficiency” verdict rules.
 */

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/** Wilson score lower bound for binomial proportion (stabilizes small n). */
function wilsonLower(positives, n, z = 1.96) {
  if (n <= 0) return 0;
  const p = positives / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, center - margin);
}

/**
 * @param {Array<{ strength?: number|null }>} rowsOldestFirst — same order as verdicts
 * @param {(boolean|"open"|null)[]} verdicts — from computeSupertrendSignalVerdictsBackend
 * @param {number|null|undefined} priorThreshold — last persisted value (0–100)
 * @param {object} [opts]
 * @returns {{ threshold: number, meta: object }}
 */
export function learnSmartSignalStrengthThreshold(rowsOldestFirst, verdicts, priorThreshold, opts = {}) {
  const minResolved = Math.max(3, Math.floor(Number(opts.minResolved ?? process.env.SMART_SS_MIN_RESOLVED ?? 8)));
  const minAtT = Math.max(2, Math.floor(Number(opts.minAtThreshold ?? process.env.SMART_SS_MIN_AT_T ?? 5)));
  const targetP = clamp(Number(opts.targetPrecision ?? process.env.SMART_SS_TARGET_PRECISION ?? 0.58), 0.35, 0.95);
  const wilsonFloor = clamp(Number(opts.wilsonFloor ?? process.env.SMART_SS_WILSON_FLOOR ?? 0.45), 0.2, 0.9);
  const blendAfterN = Math.max(10, Math.floor(Number(opts.blendAfterN ?? 30)));

  const rows = Array.isArray(rowsOldestFirst) ? rowsOldestFirst : [];
  const ver = Array.isArray(verdicts) ? verdicts : [];

  const resolved = [];
  for (let i = 0; i < rows.length && i < ver.length; i++) {
    const v = ver[i];
    if (v !== true && v !== false) continue;
    const ss = rows[i]?.strength;
    if (ss == null || !Number.isFinite(Number(ss))) continue;
    resolved.push({ ss: clamp(Math.round(Number(ss)), 0, 100), good: v === true });
  }

  const prior =
    priorThreshold != null && Number.isFinite(Number(priorThreshold))
      ? clamp(Math.round(Number(priorThreshold)), 0, 100)
      : null;

  if (resolved.length < minResolved) {
    const th = prior != null ? prior : 65;
    return {
      threshold: th,
      meta: {
        reason: "insufficient_resolved",
        nResolved: resolved.length,
        minResolved,
        priorOnly: true,
        blended: false,
      },
    };
  }

  let bestT = null;
  let bestPrec = 0;
  let bestN = 0;
  let bestWl = 0;

  for (let T = 100; T >= 0; T--) {
    const subset = resolved.filter((r) => r.ss >= T);
    const n = subset.length;
    if (n < minAtT) continue;
    const pos = subset.filter((r) => r.good).length;
    const prec = pos / n;
    const wl = wilsonLower(pos, n);
    if (prec >= targetP && wl >= wilsonFloor) {
      bestT = T;
      bestPrec = prec;
      bestN = n;
      bestWl = wl;
      break;
    }
  }

  if (bestT == null) {
    let bestScore = -1;
    for (let T = 100; T >= 0; T--) {
      const subset = resolved.filter((r) => r.ss >= T);
      const n = subset.length;
      if (n < minAtT) continue;
      const pos = subset.filter((r) => r.good).length;
      const prec = pos / n;
      const score = prec * Math.sqrt(n);
      if (score > bestScore) {
        bestScore = score;
        bestT = T;
        bestPrec = prec;
        bestN = n;
        bestWl = wilsonLower(pos, n);
      }
    }
  }

  let learned = bestT;
  if (learned == null) {
    learned = prior != null ? prior : 65;
  } else {
    learned = clamp(learned, 0, 100);
  }

  const w = Math.min(1, resolved.length / blendAfterN);
  const basePrior = prior != null ? prior : learned;
  const blended = clamp(Math.round(w * learned + (1 - w) * basePrior), 0, 100);

  return {
    threshold: blended,
    meta: {
      reason: "ok",
      nResolved: resolved.length,
      nAtThreshold: bestN,
      precisionAtThreshold: bestPrec,
      wilsonLower: bestWl,
      learnedRaw: bestT != null ? clamp(bestT, 0, 100) : null,
      priorUsed: basePrior,
      blendWeight: w,
      blended: true,
    },
  };
}
