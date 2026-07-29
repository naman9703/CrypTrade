/**
 * ICT session kill-zones (UTC).
 */

/**
 * ICT kill-zones in UTC. New York time windows are widened by one hour so a
 * single UTC window covers both EST (winter, NY = UTC-5) and EDT (summer,
 * NY = UTC-4). Default ICT preset uses LONDON_NY (London open or NY open).
 *
 *  - London Open KZ : 02:00-05:00 EST  -> 07:00-10:00 UTC
 *  - New York Open  : 08:00-11:00 EST  -> 12:00-16:00 UTC (covers EST/EDT)
 *  - NY/London overlap (incl. Silver Bullet 10:00-11:00 EST) -> 14:00-16:00 UTC
 *  - Asian range    : 19:00-23:00 EST  -> 00:00-04:00 UTC
 */
const PRESETS = {
  LONDON: { start: 7, end: 10 },
  NY: { start: 12, end: 16 },
  OVERLAP: { start: 14, end: 16 },
  SILVER_BULLET: { start: 14, end: 16 },
  ASIA: { start: 0, end: 4 },
  ALL: { start: 0, end: 24 },
};

export function utcHourFromTs(ts) {
  return new Date(ts).getUTCHours();
}

/**
 * @param {number} ts bar timestamp ms
 * @param {object} [opts]
 */
function inHourWindow(h, start, end) {
  if (start <= end) return h >= start && h < end;
  return h >= start || h < end;
}

export function inSmcKillzone(ts, opts = {}) {
  if (opts.intradaySmcKillzoneEnabled === false) return true;
  const mode = String(opts.intradaySmcKillzoneMode ?? "LONDON_NY").toUpperCase();
  if (mode === "ALL") return true;
  const h = utcHourFromTs(ts);
  // Deny Asian range only — keep London/NY/off hours (BTC autopsy: Asia was worst slice).
  if (mode === "NO_ASIA") {
    return !inHourWindow(h, PRESETS.ASIA.start, PRESETS.ASIA.end);
  }
  // Wider Asia deny matching research autopsy bucket (00–07 UTC).
  if (mode === "NO_ASIA_WIDE") {
    return !inHourWindow(h, 0, 7);
  }
  if (mode === "LONDON_NY") {
    return inHourWindow(h, PRESETS.LONDON.start, PRESETS.LONDON.end)
      || inHourWindow(h, PRESETS.NY.start, PRESETS.NY.end);
  }
  const preset = PRESETS[mode];
  let start;
  let end;
  if (preset) {
    start = preset.start;
    end = preset.end;
  } else if (mode === "CUSTOM") {
    start = Number(opts.intradaySmcKillzoneStartUtc ?? 13);
    end = Number(opts.intradaySmcKillzoneEndUtc ?? 17);
  } else {
    start = 13;
    end = 17;
  }

  return inHourWindow(h, start, end);
}

export function killzoneLabel(opts = {}) {
  return String(opts.intradaySmcKillzoneMode ?? "LONDON_NY").toUpperCase();
}

/** Order-flow entries: London + NY only by default (guide — avoid thin Asian session). */
export function inOrderFlowKillzone(ts, opts = {}) {
  const mode = String(opts.intradayOfKillzoneMode ?? opts.killzoneMode ?? "LONDON_NY").toUpperCase();
  return inSmcKillzone(ts, {
    intradaySmcKillzoneEnabled: true,
    intradaySmcKillzoneMode: mode === "ORDERFLOW_LONDON_NY" ? "LONDON_NY" : mode,
  });
}
