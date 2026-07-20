/**
 * Persist trail ladder activations during backtest simulation for chart replay.
 */
import { resolveSupertrendTieredActivationGate } from "../../lib/trailingStopLoss.js";

export function ensureTrailEvents(pos) {
  if (!Array.isArray(pos.trailEvents)) pos.trailEvents = [];
}

function lastRecordedStep(pos) {
  const events = pos.trailEvents;
  if (!Array.isArray(events) || !events.length) return 0;
  return Math.max(0, Math.floor(Number(events[events.length - 1].step) || 0));
}

function resolveNextActivationPx(pos, step, opts) {
  if (!opts || typeof opts !== "object") return null;
  const entry = Number(pos.entryFill);
  if (!Number.isFinite(entry) || entry <= 0) return null;
  const isLong = pos.side === "BUY";
  const gate = resolveSupertrendTieredActivationGate({
    stepNow: Math.max(0, Math.floor(Number(step) || 0)),
    isLong,
    entryPx: entry,
    feeBe: opts.feeBeSt ?? opts.feeBeLockRate ?? opts.feeBe,
    bufferRate: opts.bufferRate,
    postT02BufferRate: opts.postT02BufferRate,
    useFeeBeTrail: opts.useFeeBeTrail !== false,
    stLevels: opts.stLevels,
    roundTripFeeRate: opts.roundTripFeeR,
    postT02SpacingFrac: opts.postT02SpacingFrac,
  });
  const px = Number(gate.activationPx);
  return Number.isFinite(px) && px > 0 ? px : null;
}

/**
 * Record a trail step advance (SL lock-in) with activation price and next gate.
 *
 * @param {object} pos open position (mutated: `trailEvents`)
 * @param {object} args
 * @param {number} args.ts event timestamp (ms)
 * @param {{ proposedSl?:number|null, trailStep?:number, tierLabel?:string|null, advanced?:boolean }} args.advRes
 * @param {object} [args.opts] resolveTrailingOpts() output
 */
export function recordTrailAdvance(pos, { ts, advRes, opts }) {
  if (!advRes || !Number.isFinite(Number(ts))) return;
  const step = Math.max(0, Math.floor(Number(advRes.trailStep) || 0));
  const prevStep = lastRecordedStep(pos);
  const slMoved = advRes.advanced === true && advRes.proposedSl != null;
  if (!slMoved && step <= prevStep) return;

  ensureTrailEvents(pos);
  const slPrice = slMoved ? Number(advRes.proposedSl) : Number(pos.sl);
  if (!Number.isFinite(slPrice) || slPrice <= 0) return;

  const favorablePx = Number(pos.extremePx);
  const nextActivationPx = resolveNextActivationPx(pos, step, opts);

  const last = pos.trailEvents[pos.trailEvents.length - 1];
  if (last && last.step === step && last.slPrice === slPrice) return;

  pos.trailEvents.push({
    ts: Number(ts),
    step,
    tierLabel: advRes.tierLabel != null ? String(advRes.tierLabel) : null,
    slPrice,
    favorablePx: Number.isFinite(favorablePx) ? favorablePx : null,
    nextActivationPx,
  });
}
