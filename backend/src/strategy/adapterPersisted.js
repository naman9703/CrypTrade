/**
 * Shared mutable state for backtest adapters when replayed live bar-by-bar.
 * Backtest runner calls adapters without `ctx.persisted` — closure locals still work.
 * Live bar-close passes `ctx.persisted` so state survives adapter rebuilds each bar.
 */

export function ensurePersisted(ctx) {
  if (ctx && typeof ctx === "object") {
    if (!ctx.persisted || typeof ctx.persisted !== "object") ctx.persisted = Object.create(null);
    return ctx.persisted;
  }
  return null;
}

/** @param {object} ctx @param {object} fallback mutable closure bag */
export function dirStore(ctx, fallback) {
  const p = ensurePersisted(ctx);
  if (p) {
    if (p.lastDir === undefined) p.lastDir = fallback.lastDir ?? 0;
    return p;
  }
  return fallback;
}

/** Day-scoped counters (tradesToday, lastSignalIdx, …). */
export function dayStore(ctx, fallback) {
  const p = ensurePersisted(ctx);
  if (p) {
    if (p.curDay === undefined) p.curDay = fallback.curDay ?? null;
    if (p.tradesToday === undefined) p.tradesToday = fallback.tradesToday ?? 0;
    if (p.lastSignalIdx === undefined) p.lastSignalIdx = fallback.lastSignalIdx ?? -Infinity;
    return p;
  }
  return fallback;
}

/** Pullback / state-machine adapters. */
export function machineStore(ctx, fallback) {
  const p = ensurePersisted(ctx);
  if (p) {
    for (const [k, v] of Object.entries(fallback)) {
      if (p[k] === undefined) p[k] = v;
    }
    return p;
  }
  return fallback;
}
