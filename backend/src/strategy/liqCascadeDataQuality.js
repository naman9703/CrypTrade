/**
 * LIQ_CASCADE replay / backtest data quality — separate coverage from strategy logic.
 */

const DEFAULT_MIN_WEEKS = Number(process.env.LIQ_FORCE_MIN_WEEKS || 8);
const DEFAULT_MIN_TICKS = Number(process.env.LIQ_FORCE_MIN_TICKS || 500);

/**
 * @param {{
 *   ticks?: { time: number }[],
 *   liqSeries?: { liqLongUsd?: number, liqShortUsd?: number, ts: number }[],
 *   fromMs: number,
 *   toMs: number,
 *   intervalMs: number,
 *   minWeeks?: number,
 *   minTicks?: number,
 * }} ctx
 */
export function computeLiqCascadeDataQuality(ctx = {}) {
  const fromMs = Number(ctx.fromMs);
  const toMs = Number(ctx.toMs);
  const intervalMs = Number(ctx.intervalMs) || 300_000;
  const minWeeks = Number(ctx.minWeeks ?? DEFAULT_MIN_WEEKS);
  const minTicks = Number(ctx.minTicks ?? DEFAULT_MIN_TICKS);
  const ticks = ctx.ticks ?? [];
  const liqSeries = ctx.liqSeries ?? [];

  const nonzero = liqSeries.filter(
    (r) => (Number(r.liqLongUsd ?? 0) + Number(r.liqShortUsd ?? 0)) > 0,
  );
  const expectedBars =
    fromMs < toMs ? Math.floor((toMs - fromMs) / intervalMs) + 1 : 0;
  const zeroFillPct =
    expectedBars > 0 ? +(((expectedBars - nonzero.length) / expectedBars) * 100).toFixed(1) : 100;

  const firstTick = ticks.length ? Number(ticks[0].time) : null;
  const lastTick = ticks.length ? Number(ticks[ticks.length - 1].time) : null;
  const coverageMs = firstTick != null && lastTick != null ? lastTick - firstTick : 0;
  const coverageWeeks = +(coverageMs / (7 * 864e5)).toFixed(2);
  const coverageDays = +(coverageMs / 864e5).toFixed(2);

  const accurateReplayReady = coverageWeeks >= minWeeks && ticks.length >= minTicks;
  const effectiveCoveragePct =
    toMs > fromMs && coverageMs > 0
      ? +Math.min(100, (coverageMs / (toMs - fromMs)) * 100).toFixed(1)
      : 0;

  let verdict = "accumulating";
  let verdictNote =
    "Tick history still building — edge confirmation uses effective coverage, not requested window label.";
  if (accurateReplayReady) {
    verdict = "sufficient";
    verdictNote = "Tick coverage meets minimum for full-window replay claims.";
  } else if (ticks.length === 0) {
    verdict = "missing";
    verdictNote = "No force_orders ticks in range — keep WS + migration 036 running.";
  } else if (effectiveCoveragePct < 25) {
    verdict = "partial";
    verdictNote = `Only ~${effectiveCoveragePct}% of requested window has tick data; results reflect ${coverageDays}d effective span.`;
  }

  return {
    tickCount: ticks.length,
    nonzeroLiqBars: nonzero.length,
    expectedLiqBars: expectedBars,
    zeroFillPct,
    coverageWeeks,
    coverageDays,
    effectiveCoveragePct,
    tickFirst: firstTick != null ? new Date(firstTick).toISOString() : null,
    tickLast: lastTick != null ? new Date(lastTick).toISOString() : null,
    minWeeks,
    minTicks,
    accurateReplayReady,
    verdict,
    verdictNote,
  };
}
