/**
 * Shared utilities for research candidate harvest (Families C, D, …).
 */

export function utcDayId(ts) {
  return Math.floor(ts / 86_400_000);
}

/**
 * Simulate production day picker — flag highest-scoring candidate per day/side.
 */
export function markDayPickerSelection(candidates, opts = {}) {
  const scoreKey = opts.dayPickerScoreKey ?? "compositeScore";
  const byDaySide = new Map();
  for (const c of candidates) {
    const k = `${c.dayId}|${c.side}`;
    if (!byDaySide.has(k)) byDaySide.set(k, []);
    byDaySide.get(k).push(c);
  }

  const pickedKeys = new Set();
  for (const list of byDaySide.values()) {
    list.sort((a, b) => Number(b[scoreKey] ?? 0) - Number(a[scoreKey] ?? 0));
    const cap = Number(opts.maxTradesPerSidePerDay ?? 1);
    for (let i = 0; i < Math.min(cap, list.length); i++) {
      pickedKeys.add(list[i].candidateKey);
    }
  }

  return candidates.map((c) => ({
    ...c,
    selectedByDayPicker: pickedKeys.has(c.candidateKey) ? 1 : 0,
    selectionBias: pickedKeys.has(c.candidateKey) ? "picked" : "rejected",
  }));
}

/**
 * Attach L2 features to harvested candidates (entry-time, no look-ahead).
 */
export function attachL2Features(candidates, l2Series, featuresAt) {
  if (!candidates?.length || !l2Series || !featuresAt) return candidates;
  return candidates.map((c) => {
    const ts = Number(c.entryTs);
    if (!Number.isFinite(ts)) return c;
    return { ...c, ...featuresAt(l2Series, ts) };
  });
}

export function slFromAtr(entryPx, side, atr, mult = 1.5) {
  const risk = Math.max(atr * mult, entryPx * 0.003);
  return side === "BUY" ? entryPx - risk : entryPx + risk;
}
