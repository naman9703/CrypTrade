import { roundTo } from "./math.js";
import { computeSupertrendTrailingSlUpdate, feeRateBreakevenPadded } from "./supertrendTrailingSl.js";

/**
 * Trailing SL for autotrade:
 * 1) Fee breakeven lock (~round-trip taker fee on entry price).
 * 2) First scalping: always fee-equivalent (second fee notch from entry: ±4×feeRate).
 * 3) Up to 3 optional extra locks at user % of entry (each level is entry × (1 ± pct/100)).
 */

export function clampFeeRate(r) {
  const x = Number(r);
  if (!Number.isFinite(x) || x < 0) return 0.0004;
  return Math.min(0.01, Math.max(0, x));
}

/** Approximate stop price that nets ~zero after entry+exit taker fees (same notional). */
export function feeCoverageLockPx({ entryPx, isLong, feeRate }) {
  const E = Number(entryPx);
  const r = clampFeeRate(feeRate);
  if (!Number.isFinite(E) || E <= 0) return null;
  if (isLong) return E * (1 + 2 * r);
  return E * (1 - 2 * r);
}

/**
 * First scalping lock after breakeven: price move from entry equal to another ~round-trip fee
 * (cumulative 4× feeRate from entry; complements the breakeven step at 2× feeRate).
 */
export function firstScalpingFeeEquivLockPx({ entryPx, isLong, feeRate }) {
  const E = Number(entryPx);
  const r = clampFeeRate(feeRate);
  if (!Number.isFinite(E) || E <= 0) return null;
  if (isLong) return E * (1 + 4 * r);
  return E * (1 - 4 * r);
}

/** Lock at `pctOfEntry` percent from entry (e.g. 0.35 → 0.35%). */
export function pctOfEntryLockPx({ entryPx, isLong, pctOfEntry }) {
  const E = Number(entryPx);
  const p = Number(pctOfEntry) / 100;
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(p) || p <= 0) return null;
  if (isLong) return E * (1 + p);
  return E * (1 - p);
}

/**
 * @param {number[]} extraScalpingPctsOfEntry 0–3 values, each % of entry (e.g. 0.5 = 0.5%)
 * @returns {{ kind: string; lockPx: number; pct?: number }[]} sorted for activation (long: ascending by lockPx)
 */
export function buildTrailLockPrices({ entryPx, isLong, feeRate, extraScalpingPctsOfEntry = [] }) {
  const E = Number(entryPx);
  const r = clampFeeRate(feeRate);
  if (!Number.isFinite(E) || E <= 0) return [];

  const extras = (Array.isArray(extraScalpingPctsOfEntry) ? extraScalpingPctsOfEntry : [])
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0)
    .slice(0, 3);

  const out = [];
  const rBe = feeRateBreakevenPadded(r);
  const feePx = feeCoverageLockPx({ entryPx: E, isLong, feeRate: rBe });
  if (feePx != null) out.push({ kind: "fee_breakeven", lockPx: feePx });

  const fsPx = firstScalpingFeeEquivLockPx({ entryPx: E, isLong, feeRate: r });
  if (fsPx != null) {
    const feeEquivPct = 2 * r * 100;
    out.push({ kind: "fee_first_scalp", lockPx: fsPx, feeEquivPct });
  }

  for (const pct of extras) {
    const px = pctOfEntryLockPx({ entryPx: E, isLong, pctOfEntry: pct });
    if (px != null) out.push({ kind: "user_scalp", lockPx: px, pct });
  }

  const eps = E * 1e-10;
  out.sort((a, b) => (isLong ? a.lockPx - b.lockPx : b.lockPx - a.lockPx));
  const dedup = [];
  for (const row of out) {
    const last = dedup[dedup.length - 1];
    if (last && Math.abs(last.lockPx - row.lockPx) <= eps) continue;
    dedup.push(row);
  }
  return dedup.slice(0, 5);
}

/** Max trail index (1–5): breakeven + first fee-scalp + up to 3 user % locks. */
export function maxTrailStepsForConfig(extraScalpingPctsOfEntry) {
  const n = Math.min(
    3,
    (Array.isArray(extraScalpingPctsOfEntry) ? extraScalpingPctsOfEntry : [])
      .map((x) => Number(x))
      .filter((x) => Number.isFinite(x) && x > 0).length,
  );
  return Math.min(5, 2 + n);
}

/**
 * Advance trail state from a new mark / extreme.
 * @returns {{ trailStep: number, extremePx: number, proposedSl: number|null, advanced: boolean }}
 */
export function advanceTrailingStopState({
  entryPx,
  isLong,
  trailStep,
  extremePx,
  markPx,
  feeRate,
  extraScalpingPctsOfEntry,
}) {
  const E = Number(entryPx);
  const mark = Number(markPx);
  if (!Number.isFinite(E) || E <= 0 || !Number.isFinite(mark)) {
    return { trailStep: 0, extremePx: Number(extremePx) || mark, proposedSl: null, advanced: false };
  }
  const ext0 = Number.isFinite(Number(extremePx)) ? Number(extremePx) : mark;
  const hwm = isLong ? Math.max(ext0, mark) : Math.min(ext0, mark);

  const levels = buildTrailLockPrices({
    entryPx: E,
    isLong,
    feeRate,
    extraScalpingPctsOfEntry,
  });
  const n = levels.length;
  if (!n) return { trailStep: Number(trailStep) || 0, extremePx: hwm, proposedSl: null, advanced: false };

  let step = Math.max(0, Math.min(n, Math.floor(Number(trailStep) || 0)));
  let proposedSl = null;
  let advanced = false;

  for (let k = step; k < n; k++) {
    const L = levels[k];
    const crossed = isLong ? hwm >= L.lockPx : hwm <= L.lockPx;
    if (!crossed) break;
    step = k + 1;
    proposedSl = L.lockPx;
    advanced = true;
  }

  return { trailStep: step, extremePx: hwm, proposedSl, advanced };
}

/** Long: SL only moves up; short: only down. */
export function mergeStopWithTrail({ isLong, currentStopPx, trailSlPx }) {
  const cur = Number(currentStopPx);
  const tr = Number(trailSlPx);
  if (!Number.isFinite(tr) || tr <= 0) return Number.isFinite(cur) ? cur : null;
  if (!Number.isFinite(cur) || cur <= 0) return tr;
  if (isLong) return Math.max(cur, tr);
  return Math.min(cur, tr);
}

export function roundStopPx(px, tickSize) {
  const p = Number(px);
  const t = Number(tickSize);
  if (!Number.isFinite(p) || p <= 0) return p;
  if (!Number.isFinite(t) || t <= 0) return roundTo(p, 8);
  const steps = Math.round(p / t);
  return roundTo(steps * t, 12);
}

/**
 * Mutates Binance USD-M in-memory bracket state (local fallback + display targets).
 *
 * **Mode `SUPERTREND` (default):** uses `computeSupertrendTrailingSlUpdate` + `supertrendPx` + activation / liquidation geometry.
 *
 * **Mode `FEE_LADDER`:** discrete locks from `buildTrailLockPrices` (round-trip fee BE, second fee notch, optional %-of-entry);
 * advances when favorable excursion vs `extremePx` crosses each lock (`advanceTrailingStopState`).
 *
 * @param {{
 *   enabled: boolean;
 *   feeRate: number;
 *   mode?: "SUPERTREND" | "FEE_LADDER";
 *   supertrendPx?: number | null;
 *   bufferRate?: number;
 *   maintenanceMarginRate?: number;
 *   minSlDistanceFrac?: number;
 *   extraScalpingPcts?: number[];
 *   maxTrailSteps?: number;
 *   supertrendUseFeeBreakeven?: boolean;
 *   supertrendUseAdvancedTrail?: boolean;
 * }} [opts.trailingOpts]
 * @param {(p: { level: string; msg: string; category?: string; reason?: string; symbol?: string; detail?: object }) => void} [opts.notifyActivity]
 */
export function applyTrailingStopBinanceMemory(opts) {
  const sym = String(opts.symbol || "").toUpperCase();
  const markPx = Number(opts.markPx);
  const trailingOpts = opts.trailingOpts;
  const trailingBySymbol = opts.trailingBySymbol;
  const localBrackets = opts.localBrackets;
  const placedBracketTargets = opts.placedBracketTargets;
  const tickSize = opts.tickSize != null ? Number(opts.tickSize) : null;
  const onTrailingSlAdvance = opts.onTrailingSlAdvance;
  const notifyActivity = typeof opts.notifyActivity === "function" ? opts.notifyActivity : null;

  /** Throttle diagnostic activity per symbol + reason (ms). */
  function trailDiagEmit(tr, reason, minMs) {
    if (!notifyActivity || !tr) return false;
    const now = Date.now();
    const t = tr._trailDiagTs || (tr._trailDiagTs = {});
    const last = t[reason] || 0;
    if (now - last < minMs) return false;
    t[reason] = now;
    return true;
  }

  if (!sym || !Number.isFinite(markPx) || markPx <= 0) return false;
  if (!trailingOpts?.enabled || !trailingBySymbol) return false;

  const tr = trailingBySymbol[sym];
  if (!tr || !tr.entryPrice) return false;

  const isLong = Boolean(tr.isLong);
  const b = localBrackets[sym];
  const tgt = placedBracketTargets?.[sym];
  const prevRaw = b ? b.stopLoss : tgt?.stopLoss;
  const prevSl = Number(prevRaw);
  if (!Number.isFinite(prevSl) || prevSl <= 0) return false;

  const lev = Number(tr.leverage);
  const feeR = clampFeeRate(trailingOpts.feeRate);
  const feeBe = feeRateBreakevenPadded(trailingOpts.feeRate);
  const buf = Number.isFinite(Number(trailingOpts.bufferRate)) ? Number(trailingOpts.bufferRate) : 0.0005;
  const mm = Number.isFinite(Number(trailingOpts.maintenanceMarginRate))
    ? Number(trailingOpts.maintenanceMarginRate)
    : 0.005;
  const minDist =
    trailingOpts.minSlDistanceFrac != null && Number.isFinite(Number(trailingOpts.minSlDistanceFrac))
      ? Number(trailingOpts.minSlDistanceFrac)
      : 0.002;

  const mode = String(trailingOpts.mode || "SUPERTREND").toUpperCase() === "FEE_LADDER" ? "FEE_LADDER" : "SUPERTREND";
  // Persist last applied mode so exchange-native closes can be labeled correctly in history.
  tr.trailingMode = mode;

  let merged = null;
  let trailStatus = "";
  /** True only in SUPERTREND branch after mark is past activation (`computeSupertrendTrailingSlUpdate` returned OK). */
  let stInTrailZone = false;
  let supertrendPxForEvt = null;
  let proposedTrailSl = null;
  let minDistUsed = minDist;
  let trailKind = "supertrend_trailing_sl";

  if (mode === "FEE_LADDER") {
    const adv = advanceTrailingStopState({
      entryPx: tr.entryPrice,
      isLong,
      trailStep: tr.trailStep,
      extremePx: tr.extremePx,
      markPx,
      feeRate: feeR,
      extraScalpingPctsOfEntry: trailingOpts.extraScalpingPcts ?? [],
    });
    tr.trailStep = adv.trailStep;
    tr.extremePx = adv.extremePx;
    if (!adv.advanced || adv.proposedSl == null) return false;
    proposedTrailSl = adv.proposedSl;
    merged = mergeStopWithTrail({ isLong, currentStopPx: prevSl, trailSlPx: adv.proposedSl });
    trailStatus = "OK";
    trailKind = "fee_ladder_trailing_sl";
  } else {
    const useAdvTrail = trailingOpts.supertrendUseAdvancedTrail !== false;
    const stPx = trailingOpts.supertrendPx != null ? Number(trailingOpts.supertrendPx) : NaN;
    if (useAdvTrail && (!Number.isFinite(stPx) || stPx <= 0)) return false;
    supertrendPxForEvt = useAdvTrail && Number.isFinite(stPx) && stPx > 0 ? stPx : null;

    /**
     * Default `minSlDistanceFrac` (0.2%) is too strict on low-priced / small-tick symbols (e.g. DOGE).
     * When tick size is known, relax the fraction guard down to a small tick-based fraction so trailing can advance.
     */
    if (tickSize != null && Number.isFinite(tickSize) && tickSize > 0 && markPx > 0) {
      const tickFrac = (2 * tickSize) / markPx; // ~2 ticks away from mark
      if (Number.isFinite(tickFrac) && tickFrac > 0) minDistUsed = Math.min(minDistUsed, tickFrac);
    }

    const useFeeBeTrail = trailingOpts.supertrendUseFeeBreakeven !== false;

    const r = computeSupertrendTrailingSlUpdate({
      entryPrice: tr.entryPrice,
      currentPrice: markPx,
      supertrend: useAdvTrail ? stPx : NaN,
      previousSl: prevSl,
      isLong,
      leverage: lev,
      feeRate: feeBe,
      bufferRate: buf,
      maintenanceMarginRate: mm,
      minSlDistanceFrac: minDistUsed,
      useFeeBreakeven: trailingOpts.supertrendUseFeeBreakeven !== false,
      useAdvancedTrail: trailingOpts.supertrendUseAdvancedTrail !== false,
    });

    const activationPx = isLong
      ? tr.entryPrice * (1 + (useFeeBeTrail ? feeBe : 0) + buf)
      : tr.entryPrice * (1 - (useFeeBeTrail ? feeBe : 0) - buf);

    if (r.status === "REJECT_TRADE" || r.status === "INVALID") {
      if (trailDiagEmit(tr, `bad_${r.status}`, 120_000)) {
        notifyActivity({
          category: "risk",
          level: r.status === "REJECT_TRADE" ? "warn" : "error",
          msg: `Trailing ${r.status === "REJECT_TRADE" ? "blocked" : "invalid"} · ${sym} · ${r.status} (mark ${markPx}, entry ${tr.entryPrice})`,
          reason: "trailing_sl_diagnostic",
          symbol: sym,
          detail: { outcome: "failure", phase: "geometry", trailStatus: r.status, markPx, entryPrice: tr.entryPrice, isLong },
        });
      }
      return false;
    }
    if (r.status === "NO_SUPERTREND") {
      if (useAdvTrail && trailDiagEmit(tr, "no_st", 90_000)) {
        notifyActivity({
          category: "risk",
          level: "warn",
          msg: `Trailing activation unavailable · ${sym} · no Supertrend price for this mark (cannot align SL to ST)`,
          reason: "trailing_sl_diagnostic",
          symbol: sym,
          detail: { outcome: "failure", phase: "activation", trailStatus: r.status, markPx },
        });
      }
      return false;
    }
    if (r.status === "NO_TRAIL") {
      return false;
    }

    stInTrailZone = r.status === "OK";

    /** Mark has crossed fee+buffer activation — ST trailing zone (server will tighten when geometry allows). */
    if (r.status === "OK" && !tr._trailingActivationLogged) {
      tr._trailingActivationLogged = true;
      notifyActivity?.({
        category: "risk",
        level: "info",
        msg: `Trailing activation · ${sym} · mark passed activation (${activationPx.toFixed(6)}); futures trailing engaged`,
        reason: "trailing_activation_engaged",
        symbol: sym,
        detail: {
          outcome: "success",
          phase: "activation",
          markPx,
          activationPrice: activationPx,
          breakeven: useFeeBeTrail
            ? isLong
              ? tr.entryPrice * (1 + feeBe)
              : tr.entryPrice * (1 - feeBe)
            : tr.entryPrice,
          entryPrice: tr.entryPrice,
          isLong,
          supertrendPx: supertrendPxForEvt,
        },
      });
    }

    trailStatus = r.status;
    proposedTrailSl = r.newSl;
    merged = mergeStopWithTrail({ isLong, currentStopPx: prevSl, trailSlPx: r.newSl });
  }

  const finalSlPre =
    merged != null && Number.isFinite(Number(merged)) && Number(merged) > 0
      ? tickSize != null && Number.isFinite(tickSize) && tickSize > 0
        ? roundStopPx(merged, tickSize)
        : roundTo(merged, 8)
      : null;

  // Compare using the same rounding grid we apply to the new stop. Otherwise we can get stuck when
  // `merged` equals the previous raw stop, but tick rounding would advance (e.g. 0.238999 → 0.2390).
  const prevEff =
    tickSize != null && Number.isFinite(tickSize) && tickSize > 0
      ? roundStopPx(prevSl, tickSize)
      : roundTo(prevSl, 8);

  if (merged == null || finalSlPre == null) {
    return false;
  }

  // Tick-alignment: exchange triggers are on tick grid; sometimes the stored SL is off-grid (e.g. from open-orders parsing),
  // and our proposed SL rounds onto the same tick. In that case, sync the stored target to the tick without counting it
  // as a real trail advancement.
  if (finalSlPre === prevEff) {
    if (prevSl !== prevEff) {
      if (b) b.stopLoss = prevEff;
      if (placedBracketTargets && placedBracketTargets[sym]) {
        placedBracketTargets[sym] = { ...placedBracketTargets[sym], stopLoss: prevEff };
      }
    }
    const inTrailContext = stInTrailZone || mode === "FEE_LADDER";
    /**
     * After at least one successful trail tighten (`trailStep >= 1`), the engine still evaluates every mark;
     * geometry often matches exchange SL (tick / min-distance) → noisy repeat noops. Only log noops while
     * we have not yet advanced (`trailStep === 0`) — first tighten is the hard case to diagnose.
     */
    const trailStepN = Number(tr.trailStep) || 0;
    const allowNoopDiag = trailStepN < 1;
    if (inTrailContext && tr && allowNoopDiag && trailDiagEmit(tr, "noop_same_sl", 45_000)) {
      notifyActivity?.({
        category: "risk",
        level: "warn",
        msg: `Trailing no SL move · ${sym} · mark in trail zone but stop unchanged vs exchange (tick/min-distance or merge)`,
        reason: "trailing_sl_noop",
        symbol: sym,
        detail: {
          outcome: "failure",
          phase: "tighten",
          markPx,
          prevStopLoss: prevSl,
          prevStopLossRounded: prevEff,
          proposedTrailSl,
          proposedMerged: merged,
          proposedRounded: finalSlPre,
          tickSize: tickSize != null && Number.isFinite(tickSize) ? tickSize : null,
          minSlDistanceFrac: minDist,
          minSlDistanceFracUsed: minDistUsed,
          trailStatus,
          trailingMode: mode,
          kind: trailKind,
        },
      });
    }
    return false;
  }

  const finalSl = finalSlPre;
  if (!Number.isFinite(finalSl) || finalSl <= 0 || finalSl === prevEff) return false;

  const stFeeOn = mode !== "SUPERTREND" || trailingOpts.supertrendUseFeeBreakeven !== false;
  const breakeven = stFeeOn
    ? isLong
      ? tr.entryPrice * (1 + feeBe)
      : tr.entryPrice * (1 - feeBe)
    : tr.entryPrice;
  const activation = stFeeOn
    ? isLong
      ? tr.entryPrice * (1 + feeBe + buf)
      : tr.entryPrice * (1 - feeBe - buf)
    : isLong
      ? tr.entryPrice * (1 + buf)
      : tr.entryPrice * (1 - buf);

  const bumpTrailMetaSupertrend = () => {
    tr.trailStep = (Number(tr.trailStep) || 0) + 1;
    tr.extremePx = isLong ? Math.max(Number(tr.extremePx) || markPx, markPx) : Math.min(Number(tr.extremePx) || markPx, markPx);
  };

  const evtCore = {
    symbol: sym,
    venue: "FUTURES",
    prevStopLoss: prevSl,
    newStopLoss: finalSl,
    maxTrailSteps: trailingOpts.maxTrailSteps ?? 1,
    isLong,
    entryPrice: tr.entryPrice,
    supertrendPx: supertrendPxForEvt,
    trailStatus,
    breakeven,
    activationPrice: activation,
    leverage: lev,
    bufferRate: buf,
    maintenanceMarginRate: mm,
    kind: trailKind,
    trailingMode: mode,
  };

  if (b) {
    if (mode === "SUPERTREND") bumpTrailMetaSupertrend();
    b.stopLoss = finalSl;
    if (placedBracketTargets && placedBracketTargets[sym]) {
      placedBracketTargets[sym] = { ...placedBracketTargets[sym], stopLoss: finalSl };
    }
    onTrailingSlAdvance?.({
      ...evtCore,
      trailStep: tr.trailStep,
      source: "binance_usdm_local_bracket",
    });
    return true;
  }
  if (placedBracketTargets && placedBracketTargets[sym]) {
    if (mode === "SUPERTREND") bumpTrailMetaSupertrend();
    placedBracketTargets[sym] = { ...placedBracketTargets[sym], stopLoss: finalSl };
    onTrailingSlAdvance?.({
      ...evtCore,
      trailStep: tr.trailStep,
      source: "binance_usdm_bracket_targets",
    });
    return true;
  }
  return false;
}
