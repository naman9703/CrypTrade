/**
 * SMC/ICT setup metadata for analytics and backtest trade rows.
 */

/**
 * @param {object} setup enriched setup from evaluateSmcIctSetup
 * @param {object} opts
 * @param {object} pre
 * @param {number} idx
 */
export function buildSmcEntryContext(setup, opts, pre, idx) {
  if (!setup) return null;
  const meta = setup.smcMeta ?? {};
  return {
    setupType: "smc_ict",
    side: setup.action,
    sweepLevel: meta.sweepLevel ?? setup.level,
    opposingLevel: meta.opposingLevel ?? setup.opposing ?? setup.liqBrackets?.opposingLevel ?? null,
    plannedRr: meta.plannedRr ?? setup.liqBrackets?.rr ?? null,
    sweepExtensionPct: meta.sweepExtensionPct ?? setup.extension,
    levelType: setup.levelType,
    chochLevel: meta.chochLevel ?? null,
    chochType: meta.chochType ?? null,
    bosLevel: meta.bosLevel ?? setup.bosLevel,
    bosType: meta.bosType ?? null,
    fvgTop: meta.fvgTop ?? null,
    fvgBottom: meta.fvgBottom ?? null,
    obTop: meta.obTop ?? null,
    obBottom: meta.obBottom ?? null,
    killzone: meta.killzone ?? null,
    htfStrictness: opts.intradaySmcHtfStrictness ?? "both",
    adxAtEntry: pre.adxSeries?.[idx] ?? null,
    rrPlanned: setup.liqBrackets?.rr ?? null,
    failReason: meta.failReason ?? null,
    trendState: meta.trendState ?? null,
    invalidationEnforced: meta.invalidationEnforced ?? null,
    pdAfterChoch: meta.pdAfterChoch ?? null,
  };
}
