/**
 * Multi-timeframe bias for SMC/ICT (4H + 1H from chart candles).
 */

import {
  buildHtfStructureBiasSeries,
  structureBiasAllowsSide,
  htfBiasDisagreement,
} from "./htfStructureBias.js";

const H4_MS = 4 * 60 * 60 * 1000;
const MIN_BUCKETS = 50;

function emaStep(prev, k, val) {
  return prev == null ? val : prev + k * (val - prev);
}

/**
 * 4H trend bias (EMA21 vs EMA50) computed with a *running* aggregation so the
 * value at bar `i` only uses data up to and including bar `i`. The currently
 * forming 4H candle is folded in provisionally via its close-so-far, while only
 * completed 4H closes are committed to the EMA state — this removes the lookahead
 * that a one-shot full-series aggregation would introduce.
 *
 * @param {object[]} candles
 * @param {object} [pre] precomputeIntraday result (1h EMA bias)
 */
export function buildHtfBiasSeries(candles, pre = null, opts = {}) {
  const n = candles?.length ?? 0;
  const h4Up = new Array(n).fill(false);
  const h4Down = new Array(n).fill(false);
  const h4Sep = new Array(n).fill(0);
  if (!n) {
    return {
      h4Up,
      h4Down,
      h4Sep,
      h1Up: pre?.htfUp ?? h4Up,
      h1Down: pre?.htfDown ?? h4Down,
      h1Sep: pre?.htfSep ?? h4Sep,
      h4StructureUp: new Array(0),
      h4StructureDown: new Array(0),
      h4StructureState: new Array(0),
      h4StructureNeutral: new Array(0),
    };
  }

  const k21 = 2 / (21 + 1);
  const k50 = 2 / (50 + 1);

  let committedEma21 = null;
  let committedEma50 = null;
  let committed = 0;
  let curBucket = null;
  let curClose = null;

  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const bucket = Math.floor(c.ts / H4_MS) * H4_MS;

    if (curBucket == null) {
      curBucket = bucket;
    } else if (bucket !== curBucket) {
      // Previous 4H candle is now closed — commit its final close to the EMA state.
      committedEma21 = emaStep(committedEma21, k21, curClose);
      committedEma50 = emaStep(committedEma50, k50, curClose);
      committed += 1;
      curBucket = bucket;
    }
    curClose = c.close;

    if (committed < MIN_BUCKETS || committedEma21 == null || committedEma50 == null) continue;

    // Provisional EMA including the forming bucket's close-so-far (known at bar i).
    const e21 = emaStep(committedEma21, k21, curClose);
    const e50 = emaStep(committedEma50, k50, curClose);
    if (!Number.isFinite(e21) || !Number.isFinite(e50) || e50 === 0) continue;
    const sep = Math.abs(e21 - e50) / Math.abs(e50);
    h4Sep[i] = sep;
    if (sep >= 0.0003) {
      h4Up[i] = e21 > e50;
      h4Down[i] = e21 < e50;
    }
  }

  const structure = buildHtfStructureBiasSeries(candles, opts);

  return {
    h4Up,
    h4Down,
    h4Sep,
    h1Up: pre?.htfUp ?? h4Up,
    h1Down: pre?.htfDown ?? h4Down,
    h1Sep: pre?.htfSep ?? h4Sep,
    ...structure,
  };
}

function emaBiasAllowsSide(side, smcHtf, idx, strict, minSep) {
  if (side === "BUY") {
    if (strict === "4h" || strict === "both") {
      if (smcHtf.h4Down[idx] && smcHtf.h4Sep[idx] >= minSep) return false;
    }
    if (strict === "1h" || strict === "both") {
      if (smcHtf.h1Down[idx] && smcHtf.h1Sep[idx] >= minSep) return false;
    }
    if (strict === "either") {
      const ok4 = smcHtf.h4Up[idx] || smcHtf.h4Sep[idx] < minSep;
      const ok1 = smcHtf.h1Up[idx] || smcHtf.h1Sep[idx] < minSep;
      return ok4 || ok1;
    }
    return true;
  }

  if (strict === "4h" || strict === "both") {
    if (smcHtf.h4Up[idx] && smcHtf.h4Sep[idx] >= minSep) return false;
  }
  if (strict === "1h" || strict === "both") {
    if (smcHtf.h1Up[idx] && smcHtf.h1Sep[idx] >= minSep) return false;
  }
  if (strict === "either") {
    const ok4 = smcHtf.h4Down[idx] || smcHtf.h4Sep[idx] < minSep;
    const ok1 = smcHtf.h1Down[idx] || smcHtf.h1Sep[idx] < minSep;
    return ok4 || ok1;
  }
  return true;
}

/** HTF bias metadata for smcMeta / funnel diagnostics. */
export function getSmcHtfBiasMeta(pre, idx, opts = {}) {
  const smcHtf = pre._smcHtf || null;
  const mode = String(opts.intradaySmcHtfBiasMode ?? "parallel").toLowerCase();
  if (!smcHtf) {
    return {
      htfBiasMode: mode,
      htfEmaDir: pre.htfUp?.[idx] ? "up" : pre.htfDown?.[idx] ? "down" : "flat",
      htfStructureDir: null,
      htfStructureState: null,
      htfBiasDisagreement: false,
    };
  }
  const emaDir = smcHtf.h4Up[idx] ? "up" : smcHtf.h4Down[idx] ? "down" : "flat";
  const stState = smcHtf.h4StructureState?.[idx] ?? "UNKNOWN";
  const stDir =
    smcHtf.h4StructureUp?.[idx] ? "up" : smcHtf.h4StructureDown?.[idx] ? "down" : "flat";
  return {
    htfBiasMode: mode,
    htfEmaDir: emaDir,
    htfStructureDir: stDir,
    htfStructureState: stState,
    htfBiasDisagreement: htfBiasDisagreement(smcHtf, idx),
  };
}

/**
 * @param {'BUY'|'SELL'} side
 * @param {object} pre
 * @param {number} idx
 * @param {object} [opts]
 */
export function passesSmcHtfBias(side, pre, idx, opts = {}) {
  const strict = String(opts.intradaySmcHtfStrictness ?? "both").toLowerCase();
  const mode = String(opts.intradaySmcHtfBiasMode ?? "parallel").toLowerCase();
  const smcHtf = pre._smcHtf || null;
  if (!smcHtf) {
    if (opts.intradaySmcRequireHtfBias === false) return true;
    if (side === "BUY") return !pre.htfDown?.[idx];
    return !pre.htfUp?.[idx];
  }

  const minSep = Number(opts.intradaySmcMinHtfSep ?? 0.0004);
  const emaOk = emaBiasAllowsSide(side, smcHtf, idx, strict, minSep);
  const structureOk = structureBiasAllowsSide(side, smcHtf, idx);

  if (mode === "ema") return emaOk;
  if (mode === "structure") return structureOk;
  // parallel — block only when both disagree with trade side
  if (emaOk || structureOk) return true;
  return false;
}

/** Attach SMC HTF series to precompute blob (call from intradayPro if needed). */
export function attachSmcHtfToPre(candles, pre, opts = {}) {
  pre._smcHtf = buildHtfBiasSeries(candles, pre, opts);
  return pre;
}
