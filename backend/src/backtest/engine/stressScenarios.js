/**
 * Synthetic stress scenarios for strategy testing ("what if" black-swan checks).
 *
 * Pure candle-array transforms + cost-model presets so they can be unit-tested
 * and replayed deterministically. Synthetic shocks answer questions historical
 * data cannot (no 2008 for crypto; COVID-2020 only exists for majors):
 *   - flash crash:    single-bar gap-down + volume spike + partial recovery
 *   - sustained bear: grinding multi-bar decline with elevated ranges
 *   - liquidity crunch: cost-model preset (slippage explosion, taker-only)
 *   - exchange gap:   missing bars + reopen price gap
 *
 * Real crash windows (used when DB coverage exists) live in REAL_CRASH_WINDOWS.
 */

/** Multiplicatively scale one candle's OHLC, keeping internal consistency. */
function scaleCandle(c, factor) {
  return {
    ...c,
    open: c.open * factor,
    high: c.high * factor,
    low: c.low * factor,
    close: c.close * factor,
  };
}

/**
 * Inject a flash crash at `atIndex` (default: middle of the series).
 * One bar gaps down `dropPct`% with a volume spike, then price recovers
 * `recoveryPct` of the drop over `recoveryBars`, after which the rest of the
 * series continues at the (partially recovered) shifted level.
 *
 * @param {Array<{ts:number,open:number,high:number,low:number,close:number,volume:number}>} candles
 * @param {{ dropPct?: number, recoveryBars?: number, recoveryPct?: number, atIndex?: number }} [opts]
 * @returns {Array} new candle array (input untouched)
 */
export function injectFlashCrash(candles, opts = {}) {
  const n = candles?.length ?? 0;
  if (n < 20) return [...(candles || [])];
  const dropPct = Math.min(80, Math.max(1, Number(opts.dropPct ?? 15)));
  const recoveryBars = Math.max(1, Math.round(Number(opts.recoveryBars ?? 16)));
  const recoveryPct = Math.min(100, Math.max(0, Number(opts.recoveryPct ?? 60)));
  const at = Math.min(n - recoveryBars - 2, Math.max(10, Math.round(Number(opts.atIndex ?? n / 2))));

  const dropFrac = dropPct / 100;
  const out = candles.slice(0, at).map((c) => ({ ...c }));

  // Crash bar: opens at prior close, plunges to -dropPct, closes near the low.
  const prior = candles[at - 1];
  const crashLow = prior.close * (1 - dropFrac);
  const crashClose = prior.close * (1 - dropFrac * 0.9);
  out.push({
    ...candles[at],
    open: prior.close,
    high: prior.close * 1.002,
    low: crashLow,
    close: crashClose,
    volume: (candles[at].volume || 1) * 8,
  });

  // Recovery: retrace `recoveryPct` of the drop over `recoveryBars`.
  const recoveredClose = crashClose + (prior.close - crashClose) * (recoveryPct / 100);
  for (let i = 1; i <= recoveryBars; i++) {
    const src = candles[at + i];
    if (!src) break;
    const t = i / recoveryBars;
    const level = crashClose + (recoveredClose - crashClose) * t;
    const prevLevel = crashClose + (recoveredClose - crashClose) * ((i - 1) / recoveryBars);
    const wobble = Math.abs(src.high - src.low) / Math.max(1e-9, src.close);
    out.push({
      ...src,
      open: prevLevel,
      close: level,
      high: Math.max(prevLevel, level) * (1 + wobble * 1.5),
      low: Math.min(prevLevel, level) * (1 - wobble * 1.5),
      volume: (src.volume || 1) * Math.max(1.5, 4 - 2.5 * t),
    });
  }

  // Remainder: shift the original series so it continues from the recovered level.
  const resumeIdx = at + recoveryBars + 1;
  const anchor = candles[resumeIdx];
  if (anchor) {
    const shift = recoveredClose / anchor.open;
    for (let i = resumeIdx; i < n; i++) {
      out.push(scaleCandle(candles[i], shift));
    }
  }
  return out;
}

/**
 * Inject a sustained bear leg: a grinding `dropPct`% decline over `bars` bars
 * starting at `atIndex`, with ranges widened by `volMult`. Series after the leg
 * continues at the depressed level (no recovery — tests trend-following exits
 * and kill-switch behavior in a regime that "keeps going down").
 */
export function injectSustainedBear(candles, opts = {}) {
  const n = candles?.length ?? 0;
  if (n < 50) return [...(candles || [])];
  const dropPct = Math.min(90, Math.max(5, Number(opts.dropPct ?? 30)));
  const bars = Math.max(10, Math.round(Number(opts.bars ?? Math.min(400, Math.floor(n / 4)))));
  const volMult = Math.max(1, Number(opts.volMult ?? 1.8));
  const at = Math.min(n - bars - 1, Math.max(10, Math.round(Number(opts.atIndex ?? n / 3))));

  const out = candles.slice(0, at).map((c) => ({ ...c }));
  const startPx = candles[at - 1].close;
  const endFactor = 1 - dropPct / 100;

  for (let i = 0; i < bars; i++) {
    const src = candles[at + i];
    if (!src) break;
    const t = (i + 1) / bars;
    const tPrev = i / bars;
    // Exponential glide keeps per-bar % drop roughly constant.
    const level = startPx * Math.pow(endFactor, t);
    const prevLevel = startPx * Math.pow(endFactor, tPrev);
    const srcRangeFrac = Math.abs(src.high - src.low) / Math.max(1e-9, src.close);
    const range = level * srcRangeFrac * volMult;
    out.push({
      ...src,
      open: prevLevel,
      close: level,
      high: Math.max(prevLevel, level) + range * 0.5,
      low: Math.min(prevLevel, level) - range * 0.5,
      volume: (src.volume || 1) * volMult,
    });
  }

  const resumeIdx = at + bars;
  const anchor = candles[resumeIdx];
  if (anchor) {
    const shift = (startPx * endFactor) / anchor.open;
    for (let i = resumeIdx; i < n; i++) {
      out.push(scaleCandle(candles[i], shift));
    }
  }
  return out;
}

/**
 * Exchange outage / gap: remove `gapBars` bars at `atIndex` and gap the reopen
 * price by `reopenGapPct`% (negative = gap down). Stops cannot fill inside the
 * gap — exactly the "can't exit at your planned price" failure mode.
 */
export function injectExchangeGap(candles, opts = {}) {
  const n = candles?.length ?? 0;
  if (n < 50) return [...(candles || [])];
  const gapBars = Math.max(1, Math.round(Number(opts.gapBars ?? 24)));
  const reopenGapPct = Number(opts.reopenGapPct ?? -8);
  const at = Math.min(n - gapBars - 2, Math.max(10, Math.round(Number(opts.atIndex ?? n / 2))));

  const out = candles.slice(0, at).map((c) => ({ ...c }));
  const resumeIdx = at + gapBars;
  const anchor = candles[resumeIdx];
  if (anchor) {
    const target = candles[at - 1].close * (1 + reopenGapPct / 100);
    const shift = target / anchor.open;
    for (let i = resumeIdx; i < n; i++) {
      out.push(scaleCandle(candles[i], shift));
    }
  }
  return out;
}

/**
 * Liquidity-crunch cost model: slippage explodes, everything fills as taker.
 * Models "liquidity dries up and you can't exit at your planned price" without
 * touching the candles.
 *
 * @param {object} [base] existing cost-model override to extend
 * @param {{ slippageMult?: number }} [opts]
 */
export function liquidityCrunchCostModel(base = {}, opts = {}) {
  const slippageMult = Math.max(1, Number(opts.slippageMult ?? 8));
  const baseSlippage = Number(base.slippagePct ?? 0.0005);
  return {
    ...base,
    slippagePct: baseSlippage * slippageMult,
    useMakerEntries: false,
    useMakerExits: false,
  };
}

/**
 * Real historical crash windows. Used when DB coverage exists for the symbol;
 * crypto has no 2008, and pre-2019 futures data is unavailable on Binance.
 */
export const REAL_CRASH_WINDOWS = [
  {
    id: "covid_2020",
    label: "COVID crash (Feb–Apr 2020)",
    from: "2020-02-15",
    to: "2020-04-15",
  },
  {
    id: "may_2021",
    label: "May 2021 deleveraging",
    from: "2021-05-01",
    to: "2021-06-15",
  },
  {
    id: "ftx_2022",
    label: "FTX collapse (Nov–Dec 2022)",
    from: "2022-11-01",
    to: "2022-12-15",
  },
];

/** Catalogue of synthetic scenarios the battery runs (single source of truth). */
export const SYNTHETIC_SCENARIOS = [
  {
    id: "flash_crash_15",
    label: "Flash crash −15% (1 bar, 60% recovery)",
    kind: "candles",
    apply: (candles) => injectFlashCrash(candles, { dropPct: 15, recoveryBars: 16, recoveryPct: 60 }),
  },
  {
    id: "flash_crash_30",
    label: "Flash crash −30% (1 bar, 40% recovery)",
    kind: "candles",
    apply: (candles) => injectFlashCrash(candles, { dropPct: 30, recoveryBars: 24, recoveryPct: 40 }),
  },
  {
    id: "sustained_bear_30",
    label: "Sustained bear −30% (grinding, no recovery)",
    kind: "candles",
    apply: (candles) => injectSustainedBear(candles, { dropPct: 30, volMult: 1.8 }),
  },
  {
    id: "exchange_gap",
    label: "Exchange outage + reopen gap −8%",
    kind: "candles",
    apply: (candles) => injectExchangeGap(candles, { gapBars: 24, reopenGapPct: -8 }),
  },
  {
    id: "liquidity_crunch",
    label: "Liquidity crunch (slippage ×8, taker-only)",
    kind: "costModel",
    applyCost: (base) => liquidityCrunchCostModel(base, { slippageMult: 8 }),
  },
];
