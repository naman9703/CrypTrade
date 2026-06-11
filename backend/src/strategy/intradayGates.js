/**
 * Per-technique gates for SR_INTRADAY / INTRADAY_PRO (Indicators → Intraday gates).
 * All default true so legacy configs behave unchanged.
 */

/** Default min composite score when cfg omits `srIntradayMinScore` (matches INTRADAY_PRO preset). */
export const INTRADAY_DEFAULT_MIN_SCORE = 8;
/** Cap when exactly one intraday gate is enabled (solo isolation / backtest). */
export const INTRADAY_SOLO_GATE_DEFAULT_MIN_SCORE = 5;

export const INTRADAY_GATE_KEYS = [
  "intradayGateLiquidity",
  "intradayGateSession",
  "intradayGateFib",
  "intradayGateVp",
  "intradayGateOrderFlow",
  "intradayGateHtfRegime",
  "intradayGateInstitutionalSr",
  "intradayGateSmcIct",
];

/** @typedef {{ liquidity: boolean, session: boolean, fib: boolean, vp: boolean, orderFlow: boolean, htfRegime: boolean, institutionalSr: boolean, smcIct: boolean }} IntradayGates */

/** SMC/ICT gate on — engine runs evaluateSmcIctSetup exclusively (not composite RSI stack). */
export function isSmcIctEngineActive(cfg = {}) {
  return cfg.intradayGateSmcIct === true || cfg.intradaySmcIctMode === true;
}

/**
 * When SMC is enabled, disable competing intraday gates so backtest/live use the ICT path.
 * Saved snapshots may still list legacy gates ON from defaults; the engine must not honor them.
 * @param {object} [cfg]
 */
export function applySmcEngineExclusivity(cfg = {}) {
  if (!isSmcIctEngineActive(cfg)) return cfg;
  return {
    ...cfg,
    intradayGateLiquidity: false,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
    intradayGateInstitutionalSr: false,
    intradaySrAPlusMode: false,
    intradayGateSmcIct: true,
    intradaySmcIctMode: true,
  };
}

/** @param {object} [cfg] @returns {IntradayGates} */
export function resolveIntradayGates(cfg = {}) {
  const on = (k) => cfg[k] !== false;
  return {
    liquidity: on("intradayGateLiquidity"),
    session: on("intradayGateSession"),
    fib: on("intradayGateFib"),
    vp: on("intradayGateVp"),
    orderFlow: on("intradayGateOrderFlow"),
    htfRegime: on("intradayGateHtfRegime"),
    /** New gate — must default off so legacy SR_INTRADAY configs are unchanged. */
    institutionalSr: cfg.intradayGateInstitutionalSr === true || cfg.intradaySrAPlusMode === true,
    smcIct: cfg.intradayGateSmcIct === true || cfg.intradaySmcIctMode === true,
  };
}

/** @param {IntradayGates} gates */
export function countEnabledIntradayGates(gates) {
  return Object.values(gates).filter(Boolean).length;
}

/**
 * Dynamic entry requirements from which gates are on.
 * @param {object} opts
 * @param {IntradayGates} gates
 */
export function resolveIntradayEntryRequirements(opts, gates) {
  const smcEngine = gates.smcIct === true;
  const enabled = countEnabledIntradayGates(gates);
  const soloGateTest = opts.intradaySoloGateTest === true || enabled === 1 || smcEngine;

  let minTechniqueCount = Number(opts.minTechniqueCount ?? opts.intradayMinTechniqueCount ?? 3);
  if (soloGateTest) minTechniqueCount = 1;
  else if (enabled <= 2) minTechniqueCount = Math.min(minTechniqueCount, 2);
  else if (enabled <= 3) minTechniqueCount = Math.min(minTechniqueCount, 2);

  const requireSessionReclaim =
    gates.session &&
    (soloGateTest && enabled === 1
      ? true
      : opts.intradayRequireSessionReclaim !== false && opts.requireSessionReclaim !== false);

  let requireFibOrVp = false;
  if (soloGateTest && enabled === 1) {
    if (gates.fib) requireFibOrVp = true;
    else if (gates.vp) requireFibOrVp = true;
  } else if (gates.fib || gates.vp) {
    requireFibOrVp = opts.intradayRequireFibOrVp !== false && opts.requireFibOrVp !== false;
  }

  const requireLiqOrSession =
    (gates.liquidity || gates.session) && opts.intradayRequireLiqOrSession === true;

  return {
    minTechniqueCount,
    requireSessionReclaim,
    requireFibOrVp,
    requireLiqOrSession,
    soloGateTest,
    enabledGateCount: enabled,
  };
}

/**
 * Min composite score for pick selection. Solo-gate mode must not inherit the full-stack
 * threshold (8–9) or fib/VP-only runs show 0 trades while the gate sweep script works.
 * @param {object} [cfg]
 * @param {IntradayGates} [gates]
 * @param {ReturnType<typeof resolveIntradayEntryRequirements>} [req]
 */
export function resolveIntradayMinScore(cfg = {}, gates, req) {
  const g = gates ?? resolveIntradayGates(cfg);
  const r = req ?? resolveIntradayEntryRequirements(cfg, g);
  const configured = Number(cfg.srIntradayMinScore ?? cfg.intradayMinScore);
  const base =
    Number.isFinite(configured) && configured > 0 ? configured : INTRADAY_DEFAULT_MIN_SCORE;

  if (g.smcIct) {
    const smcMin = Number(cfg.intradaySmcMinScore ?? cfg.intradayLiqMinScore ?? 7);
    return Number.isFinite(smcMin) && smcMin > 0 ? smcMin : 7;
  }

  if (r.soloGateTest && r.enabledGateCount === 1) {
    const fibOnly =
      g.fib && !g.liquidity && !g.session && !g.vp && !g.orderFlow && !g.htfRegime;
    if (fibOnly && cfg.intradayFibStrictMode !== false) {
      const fibMin = Number(cfg.intradayFibMinScore ?? 10);
      return Number.isFinite(fibMin) && fibMin > 0 ? fibMin : 10;
    }
    const liqOnly =
      (g.liquidity || g.session || g.institutionalSr) && !g.fib && !g.vp && !g.orderFlow && !g.htfRegime;
    if (liqOnly && cfg.intradayLiqStrictMode !== false) {
      const liqMin = Number(cfg.intradayLiqMinScore ?? 5);
      return Number.isFinite(liqMin) && liqMin > 0 ? liqMin : INTRADAY_SOLO_GATE_DEFAULT_MIN_SCORE;
    }
    const instOnly =
      g.institutionalSr &&
      (g.liquidity || g.session) &&
      !g.fib &&
      !g.vp &&
      !g.orderFlow;
    if (instOnly && (cfg.intradaySrAPlusMode === true || cfg.intradayGateInstitutionalSr === true)) {
      const liqMin = Number(cfg.intradayLiqMinScore ?? 6);
      return Number.isFinite(liqMin) && liqMin > 0 ? liqMin : 6;
    }
    const soloCap = Number(cfg.intradaySoloGateMinScore ?? INTRADAY_SOLO_GATE_DEFAULT_MIN_SCORE);
    return Math.min(base, Number.isFinite(soloCap) && soloCap > 0 ? soloCap : INTRADAY_SOLO_GATE_DEFAULT_MIN_SCORE);
  }
  if (r.enabledGateCount === 2) {
    const dualCap = Number(cfg.intradayDualGateMinScore ?? 7);
    return Math.min(base, Number.isFinite(dualCap) && dualCap > 0 ? dualCap : 7);
  }
  return base;
}

/** Count scored technique tags that belong to enabled gates (excludes wick/vol base tags). */
export function countGatedTechniques(techniques, gates) {
  let n = 0;
  for (const t of techniques) {
    if (t === "htf" || t === "htf_strong") {
      if (gates.htfRegime) n += 1;
      continue;
    }
    if (t === "liq_sweep") {
      if (gates.liquidity) n += 1;
      continue;
    }
    if (t === "pdl" || t === "pdh" || t === "asian") {
      if (gates.session) n += 1;
      continue;
    }
    if (t.startsWith("fib_")) {
      if (gates.fib) n += 1;
      continue;
    }
    if (t.startsWith("vp") || t.startsWith("vp_")) {
      if (gates.vp) n += 1;
      continue;
    }
    if (t === "cvd_long" || t === "cvd_short") {
      if (gates.orderFlow) n += 1;
      continue;
    }
    if (t.startsWith("of_")) {
      if (gates.orderFlow) n += 1;
      continue;
    }
    if (t === "sr_htf_zone" || t === "sr_bos" || t === "sr_confirm") {
      if (gates.institutionalSr) n += 1;
    }
    if (t.startsWith("smc_")) {
      if (gates.smcIct) n += 1;
    }
  }
  return n;
}
