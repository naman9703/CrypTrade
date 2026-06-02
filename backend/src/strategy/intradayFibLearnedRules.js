/**
 * Fib-gate-only learned vetoes — block loss clusters discovered in autopsy.
 */

/** @typedef {{ id: string, test: (ctx: object) => boolean, note?: string }} FibVetoRule */

/**
 * Curated vetoes from Jan–May 2026 BNB 15m loss autopsy (blocks loss clusters, keeps golden setups).
 * Default for live/backtest unless `intradayFibCustomVetoRules` overrides.
 */
export const FIB_PRODUCTION_VETO_RULES = [
  {
    id: "fib_mid_in_golden_zone",
    note: "0.5 tag while price is in golden pocket — top loss pattern (26/28 losses)",
    test: (c) => c.fibMid === true && (c.fibRetrace ?? 0) > 0.55,
  },
  {
    id: "fib_weak_wick",
    note: "No rejection quality at fib",
    test: (c) => (c.wick ?? 0) < 0.4,
  },
  {
    id: "fib_chop_exhausted",
    note: "Chop + dead volume + opposing flow (triple filter — avoids blocking high-vol chop wins)",
    test: (c) =>
      c.macroMode === "CHOP_SEASON" &&
      (c.volRatio ?? 1) < 0.75 &&
      c.cvdAligned === false,
  },
];

/** Full research list — used by autopsy discovery only. */
export const FIB_VETO_RULES = [
  {
    id: "fib_chop_season",
    note: "Macro chop — fib pullbacks fail",
    test: (c) => c.macroMode === "CHOP_SEASON",
  },
  {
    id: "fib_htf_sep_low",
    note: "Flat 1h trend — false pullbacks",
    test: (c) => (c.htfSep ?? 0) < 0.00065,
  },
  {
    id: "fib_adx_weak",
    note: "No trend strength",
    test: (c) => !Number.isFinite(c.adx) || c.adx < 24,
  },
  {
    id: "fib_range_compress",
    note: "Compressed bar — stop runs",
    test: (c) => (c.rangeAtr ?? 0) < 0.95,
  },
  {
    id: "fib_vol_dead",
    note: "No volume participation",
    test: (c) => (c.volRatio ?? 1) < 0.88,
  },
  {
    id: "fib_stale_swing",
    note: "Pullback too late after impulse",
    test: (c) => (c.barsSinceSwing ?? 0) > 22,
  },
  {
    id: "fib_shallow_retrace",
    note: "Shallow pullback — not golden pocket",
    test: (c) => (c.fibRetrace ?? 0) < 0.55,
  },
  {
    id: "fib_deep_retrace",
    note: "Trend break — deeper than golden zone",
    test: (c) => (c.fibRetrace ?? 0) > 0.7,
  },
  {
    id: "fib_not_golden",
    note: "Only 0.618 has production WR",
    test: (c) => c.fibGolden !== true,
  },
  {
    id: "fib_long_rsi_high",
    note: "Long into local overbought",
    test: (c) => c.side === "BUY" && (c.rsi ?? 50) > 56,
  },
  {
    id: "fib_short_rsi_low",
    note: "Short into local oversold",
    test: (c) => c.side === "SELL" && (c.rsi ?? 50) < 44,
  },
  {
    id: "fib_weak_wick",
    note: "No rejection quality at fib",
    test: (c) => (c.wick ?? 0) < 0.42,
  },
  {
    id: "fib_chop_struct",
    note: "Structural chop zone",
    test: (c) => c.structuralRisk === "CHOP_ZONE",
  },
  {
    id: "fib_htf_cross",
    note: "Recent EMA cross whipsaw",
    test: (c) => (c.regimeFlags ?? []).includes("HTF_EMA_CROSS_RECENT"),
  },
  {
    id: "fib_against_cvd",
    note: "Order flow opposes fib direction",
    test: (c) => c.cvdAligned === false,
  },
  {
    id: "fib_small_leg",
    note: "Impulse leg too small vs ATR",
    test: (c) => (c.legRangeAtr ?? 99) < 2.2,
  },
];

/**
 * @param {object} ctx
 * @param {object} [opts]
 */
export function applyFibVetoes(ctx, opts = {}) {
  if (opts.intradayFibLearnedRulesEnabled === false) return { allow: true };
  const useResearch = opts.intradayFibUseResearchVetoes === true;
  const rules =
    opts.intradayFibCustomVetoRules ??
    (useResearch ? FIB_VETO_RULES : FIB_PRODUCTION_VETO_RULES);
  for (const rule of rules) {
    try {
      if (rule.test(ctx)) return { allow: false, vetoId: rule.id };
    } catch {
      /* skip */
    }
  }
  return { allow: true };
}

/**
 * Greedy search from labeled fib trade rows.
 * @param {Array<{ ctx: object, bucket: string }>} rows
 */
export function discoverFibVetoRules(rows, opts = {}) {
  const losses = rows.filter((r) =>
    ["LOSS", "INSTANT_LOSS", "GAVE_BACK", "NO_RUN"].includes(r.bucket),
  );
  const wins = rows.filter((r) => r.bucket === "WIN" || r.bucket === "BIG_WIN");
  if (!losses.length) return [];

  const candidates = FIB_VETO_RULES.map((r) => ({ id: `disc_${r.id}`, test: r.test }));

  const selected = [];
  let remaining = [...losses];
  const maxRules = Number(opts.maxRules ?? 12);

  for (let round = 0; round < maxRules; round++) {
    let best = null;
    for (const cand of candidates) {
      if (selected.some((s) => s.id === cand.id)) continue;
      const lossHit = remaining.filter((r) => cand.test(r.ctx)).length;
      const winBlock = wins.filter((r) => cand.test(r.ctx)).length;
      const score = lossHit * 4 - winBlock * 10;
      if (!best || score > best.score) best = { ...cand, score, lossHit, winBlock };
    }
    if (!best || best.score <= 0) break;
    selected.push({
      id: best.id,
      test: best.test,
      note: `autopsy L${best.lossHit} W-${best.winBlock}`,
    });
    remaining = remaining.filter((r) => !best.test(r.ctx));
    if (remaining.length === 0) break;
  }
  return selected;
}
