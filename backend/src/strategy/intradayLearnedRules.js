/**
 * Learned + hand-tuned entry vetoes — block loss clusters, prefer big-move setups.
 * Rules are applied in order; first block wins.
 */

/**
 * @typedef {{ id: string, test: (ctx: object) => boolean, note?: string }} IntradayVetoRule
 */

/** @type {IntradayVetoRule[]} */
export const INTRADAY_VETO_RULES = [
  {
    id: "macro_chop_weak",
    note: "Chop season only when setup lacks session + flow",
    test: (ctx) =>
      ctx.macroMode === "CHOP_SEASON" &&
      (!ctx.hasSession || (ctx.adx ?? 0) < 22 || !ctx.cvdAligned),
  },
  {
    id: "macro_chop_no_sweep",
    note: "Chop + no liquidity sweep",
    test: (ctx) => ctx.macroMode === "CHOP_SEASON" && !ctx.hasLiqSweep && !ctx.hasSession,
  },
  {
    id: "htf_sep_too_low",
    note: "Immature / flat HTF trend",
    test: (ctx) => ctx.htfSep < 0.0005,
  },
  {
    id: "adx_weak",
    note: "No trend strength",
    test: (ctx) => !Number.isFinite(ctx.adx) || ctx.adx < 20,
  },
  {
    id: "range_compression",
    note: "Micro-range bar — fake breakouts",
    test: (ctx) => ctx.rangeAtr < 0.9,
  },
  {
    id: "low_volume",
    note: "No participation",
    test: (ctx) => ctx.volRatio < 0.85,
  },
  {
    id: "session_without_sweep_or_cvd",
    note: "Session alone without flow confirmation",
    test: (ctx) => ctx.hasSession && !ctx.hasLiqSweep && !ctx.cvdAligned,
  },
  {
    id: "fib_only_no_vp",
    note: "Fib touch without value area",
    test: (ctx) => ctx.hasFib && !ctx.hasVp && !ctx.hasLiqSweep,
  },
  {
    id: "regime_chop_zone",
    note: "Structural chop from trendHtfStRegime",
    test: (ctx) => ctx.structuralRisk === "CHOP_ZONE",
  },
  {
    id: "htf_cross_recent",
    note: "EMA cross whipsaw zone",
    test: (ctx) => (ctx.regimeFlags ?? []).includes("HTF_EMA_CROSS_RECENT"),
  },
  {
    id: "sideways_triple",
    note: "Loss-correlated triple flag",
    test: (ctx) =>
      (ctx.regimeFlags ?? []).includes("REGIME_SIDEWAYS") &&
      (ctx.regimeFlags ?? []).includes("HTF_SEP_SHRINKING") &&
      (ctx.adx ?? 0) < 22,
  },
  {
    id: "long_rsi_extended",
    note: "Chase long in overbought",
    test: (ctx) => ctx.side === "BUY" && ctx.rsi > 58,
  },
  {
    id: "short_rsi_extended",
    note: "Chase short in oversold",
    test: (ctx) => ctx.side === "SELL" && ctx.rsi < 42,
  },
  {
    id: "weak_wick",
    note: "No rejection quality",
    test: (ctx) => ctx.wick < 0.28,
  },
];

/** Big-move tier — trail instead of fixed TP */
export function isBigMoveCandidate(ctx, minScore = 10) {
  const lvnVacuum = ctx.vpSetup === "lvn_vacuum";
  return (
    ctx.score >= minScore &&
    (ctx.hasSession || lvnVacuum) &&
    (ctx.hasLiqSweep || ctx.cvdAligned || lvnVacuum) &&
    ctx.htfSep >= 0.0006 &&
    (lvnVacuum ||
      ctx.macroMode === "TREND_SEASON" ||
      (ctx.hasLiqSweep && ctx.cvdAligned && ctx.hasFib && ctx.hasVp))
  );
}

/**
 * @param {object} ctx
 * @param {object} [opts]
 * @returns {{ allow: boolean, vetoId?: string, bigMove?: boolean }}
 */
export function applyIntradayVetoes(ctx, opts = {}) {
  if (opts.intradayLearnedRulesEnabled === false) {
    return {
      allow: true,
      bigMove: isBigMoveCandidate(ctx, Number(opts.intradayBigMoveMinScore ?? 11)),
    };
  }

  const rules = opts.customVetoRules ?? INTRADAY_VETO_RULES;
  for (const rule of rules) {
    try {
      if (rule.test(ctx)) return { allow: false, vetoId: rule.id };
    } catch {
      /* skip bad rule */
    }
  }

  return {
    allow: true,
    bigMove: isBigMoveCandidate(ctx, Number(opts.intradayBigMoveMinScore ?? 11)),
  };
}

/**
 * Greedy rule search from labeled trade rows.
 * @param {Array<{ ctx: object, bucket: string }>} rows
 * @returns {IntradayVetoRule[]}
 */
export function discoverVetoRules(rows, opts = {}) {
  const losses = rows.filter((r) => r.bucket === "LOSS" || r.bucket === "INSTANT_LOSS" || r.bucket === "GAVE_BACK");
  const bigWins = rows.filter((r) => r.bucket === "BIG_WIN");
  if (!losses.length) return [];

  const candidates = [
    { id: "disc_macro_chop", test: (c) => c.macroMode === "CHOP_SEASON" },
    { id: "disc_htf_sep_low", test: (c) => c.htfSep < 0.0006 },
    { id: "disc_adx_lt_22", test: (c) => (c.adx ?? 0) < 22 },
    { id: "disc_range_compress", test: (c) => c.rangeAtr < 1.0 },
    { id: "disc_vol_low", test: (c) => c.volRatio < 0.9 },
    { id: "disc_no_session", test: (c) => !c.hasSession },
    { id: "disc_no_liq", test: (c) => !c.hasLiqSweep },
    { id: "disc_no_cvd", test: (c) => !c.cvdAligned },
    { id: "disc_chop_struct", test: (c) => c.structuralRisk === "CHOP_ZONE" },
    { id: "disc_hour_early", test: (c) => c.hour < 8 },
    { id: "disc_hour_late", test: (c) => c.hour >= 21 },
    { id: "disc_wick_weak", test: (c) => c.wick < 0.3 },
    { id: "disc_fib_no_vp", test: (c) => c.hasFib && !c.hasVp },
  ];

  const selected = [];
  let remaining = [...losses];
  const maxRules = Number(opts.maxRules ?? 8);

  for (let round = 0; round < maxRules; round++) {
    let best = null;
    for (const cand of candidates) {
      if (selected.some((s) => s.id === cand.id)) continue;
      const lossHit = remaining.filter((r) => cand.test(r.ctx)).length;
      const bwBlock = bigWins.filter((r) => cand.test(r.ctx)).length;
      const score = lossHit * 3 - bwBlock * 8;
      if (!best || score > best.score) best = { ...cand, score, lossHit, bwBlock };
    }
    if (!best || best.score <= 0) break;
    selected.push({ id: best.id, test: best.test, note: `autopsy L${best.lossHit} BW-${best.bwBlock}` });
    remaining = remaining.filter((r) => !best.test(r.ctx));
    if (remaining.length < losses.length * 0.15) break;
  }
  return selected;
}
