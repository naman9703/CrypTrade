/**
 * Tokyo / Asia session — first-two-candle bias + dynamic structure SL/TP.
 * Session default: 00:00–04:00 UTC (ICT Asia).
 */

export const TOKYO_SESSION_DEFAULTS = {
  sessionStartUtc: 0,
  sessionEndUtc: 4,
  preAsiaHours: 4,
  /** FIRST2 = legacy two-candle bias · SWEEP_FADE · SWEEP_HI_ONLY (best on BNB study) */
  entryMode: "FIRST2",
  sweepMaxBarIdx: 11,
  minPreAsiaWidthPct: 0,
  hiSweepOnlyDays: false,
  sweepTpTarget: "PRE_LOW",
  dirMode: "SECOND_MOMENTUM",
  /** DYNAMIC | ADAPTIVE | FIRST2_RANGE | SWEEP_WICK */
  slMode: "DYNAMIC",
  tpMode: "DYNAMIC",
  slBufferPct: 0.0005,
  slMinPct: 0.0045,
  slMaxPct: 0.009,
  slAtrMult: 1.1,
  slSpanMult: 0.3,
  /** TP1 scalp — 0.8R default (reachable before loser reversal). */
  tp1Rr: 0.8,
  tp1MinPct: 0.0035,
  /** TP2 runner — ~1.75R + structure; winners MFE median ~1.33%. */
  tp2Rr: 1.75,
  tp2MinPct: 0.008,
  tp2MaxPct: 0.022,
  tp2PreWidthFrac: 0.4,
  tpMinPct: 0.008,
  tpMaxPct: 0.025,
  tpPreWidthFrac: 0.42,
  tpRr: 1.5,
  tpMinRr: 1,
  partialFrac: 0.5,
  partialTp: true,
  maxTradesPerDay: 1,
  minFirst2RangePct: 0.001,
  skipMixedBodies: false,
};

export function utcHourFromTs(ts) {
  return new Date(ts).getUTCHours();
}

export function utcDayId(ts) {
  return Math.floor(ts / 86_400_000);
}

export function inTokyoSession(ts, opts = {}) {
  const start = Number(opts.tokyoSessionStartUtc ?? opts.sessionStartUtc ?? 0);
  const end = Number(opts.tokyoSessionEndUtc ?? opts.sessionEndUtc ?? 4);
  const h = utcHourFromTs(ts);
  return h >= start && h < end;
}

export function tokyoSessionDayId(ts, opts = {}) {
  const start = Number(opts.tokyoSessionStartUtc ?? opts.sessionStartUtc ?? 0);
  const h = utcHourFromTs(ts);
  const dayMs = Math.floor(ts / 86_400_000) * 86_400_000;
  if (h < start) return dayMs - 86_400_000;
  return dayMs;
}

function isBull(c) {
  return c.close > c.open;
}

function isBear(c) {
  return c.close < c.open;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function resolveTokyoDirection(c1, c2, opts = {}) {
  const mode = String(opts.tokyoDirMode ?? opts.dirMode ?? TOKYO_SESSION_DEFAULTS.dirMode).toUpperCase();
  if (mode === "BOTH_BODY") {
    if (isBull(c1) && isBull(c2)) return "BUY";
    if (isBear(c1) && isBear(c2)) return "SELL";
    if (opts.skipMixedBodies === true || opts.tokyoSkipMixedBodies === true) return null;
    return c2.close >= c1.close ? "BUY" : "SELL";
  }
  if (mode === "NET_CLOSE") {
    if (c2.close === c1.close) return null;
    return c2.close > c1.close ? "BUY" : "SELL";
  }
  if (c2.close === c1.open) return null;
  return c2.close > c1.open ? "BUY" : "SELL";
}

export function first2Box(c1, c2) {
  const hi2 = Math.max(c1.high, c2.high);
  const lo2 = Math.min(c1.low, c2.low);
  return { hi2, lo2, mid: (hi2 + lo2) / 2, span: hi2 - lo2 };
}

/** Overnight box: 20:00 UTC prior evening → 00:00 UTC session day (keyed by session day). */
export function buildPreAsiaRangeByDay(candles, opts = {}) {
  const hours = num(opts.tokyoPreAsiaHours ?? opts.preAsiaHours, 4);
  const sessionStart = num(opts.tokyoSessionStartUtc ?? opts.sessionStartUtc, 0);
  const eveningStart = 24 - hours;
  const map = new Map();

  for (const c of candles) {
    const h = utcHourFromTs(c.ts);
    const dayMs = Math.floor(c.ts / 86_400_000) * 86_400_000;
    let sessionDayKey = null;
    if (h >= eveningStart) sessionDayKey = dayMs + 86_400_000;
    else if (h < sessionStart) sessionDayKey = dayMs;
    if (sessionDayKey == null) continue;

    let row = map.get(sessionDayKey);
    if (!row) {
      row = { dayId: sessionDayKey, hi: c.high, lo: c.low, startTs: c.ts, endTs: c.ts };
      map.set(sessionDayKey, row);
    } else {
      row.hi = Math.max(row.hi, c.high);
      row.lo = Math.min(row.lo, c.low);
      row.endTs = c.ts;
    }
  }
  for (const row of map.values()) {
    row.mid = (row.hi + row.lo) / 2;
    row.width = row.hi - row.lo;
  }
  return map;
}

export function detectPreAsiaSweep(c2, pre, buf = 0.0003) {
  if (!pre || !(pre.width > 0)) return null;
  if (c2.high > pre.hi * (1 + buf) && c2.close < pre.hi) {
    return { side: "SELL", type: "SWEEP_HI_FADE", wick: c2.high, level: pre.hi };
  }
  if (c2.low < pre.lo * (1 - buf) && c2.close > pre.lo) {
    return { side: "BUY", type: "SWEEP_LO_FADE", wick: c2.low, level: pre.lo };
  }
  return null;
}

export function classifyTokyoSetup(c1, c2, pre, tradeSide) {
  const sweep = detectPreAsiaSweep(c2, pre);
  const { hi2, lo2 } = first2Box(c1, c2);
  const bothBull = isBull(c1) && isBull(c2);
  const bothBear = isBear(c1) && isBear(c2);
  let setup = "MOMENTUM";
  if (sweep) setup = sweep.type;
  else if (bothBull || bothBear) setup = "BODY_ALIGN";

  const aligned =
    (tradeSide === "BUY" && (sweep?.type === "SWEEP_LO_FADE" || bothBull)) ||
    (tradeSide === "SELL" && (sweep?.type === "SWEEP_HI_FADE" || bothBear));

  return { setup, sweep, bothBull, bothBear, aligned, hi2, lo2 };
}

function legacySlPrice(c1, c2, side, opts = {}) {
  const buf = num(opts.tokyoSlBufferPct ?? opts.slBufferPct, 0.0005);
  const mode = String(opts.tokyoSlMode ?? opts.slMode ?? "").toUpperCase();
  const { hi2, lo2, mid } = first2Box(c1, c2);

  if (side === "BUY") {
    if (mode === "C2_EXTREME") return c2.low * (1 - buf);
    if (mode === "C1_ANCHOR") return c1.low * (1 - buf);
    if (mode === "FIRST2_OPPOSITE") return hi2 * (1 + buf);
    if (mode === "FIRST2_MID") return mid * (1 - buf);
    return lo2 * (1 - buf);
  }
  if (mode === "C2_EXTREME") return c2.high * (1 + buf);
  if (mode === "C1_ANCHOR") return c1.high * (1 + buf);
  if (mode === "FIRST2_OPPOSITE") return lo2 * (1 - buf);
  if (mode === "FIRST2_MID") return mid * (1 + buf);
  return hi2 * (1 + buf);
}

export function resolveAdaptiveSlPrice(entry, c1, c2, side, atrVal, opts = {}) {
  const fill = Number(entry);
  if (!Number.isFinite(fill) || fill <= 0) return null;

  const buf = num(opts.tokyoSlBufferPct ?? opts.slBufferPct, 0.0005);
  const minPct = num(opts.tokyoSlMinPct ?? opts.slMinPct, TOKYO_SESSION_DEFAULTS.slMinPct);
  const maxPct = num(opts.tokyoSlMaxPct ?? opts.slMaxPct, TOKYO_SESSION_DEFAULTS.slMaxPct);
  const atrMult = num(opts.tokyoSlAtrMult ?? opts.slAtrMult, TOKYO_SESSION_DEFAULTS.slAtrMult);
  const spanMult = num(opts.tokyoSlSpanMult ?? opts.slSpanMult, TOKYO_SESSION_DEFAULTS.slSpanMult);
  const { hi2, lo2, span } = first2Box(c1, c2);
  const atr = Number(atrVal);

  if (side === "BUY") {
    const invalidation = Math.min(c1.low, c2.low);
    const structure = invalidation * (1 - buf) - span * spanMult;
    const atrSl = atr > 0 ? fill - atrMult * atr : structure;
    const minWide = fill * (1 - minPct);
    const maxRisk = fill * (1 - maxPct);
    let sl = Math.min(structure, atrSl, minWide);
    sl = Math.max(sl, maxRisk);
    return sl < fill ? sl : null;
  }

  const invalidation = Math.max(c1.high, c2.high);
  const structure = invalidation * (1 + buf) + span * spanMult;
  const atrSl = atr > 0 ? fill + atrMult * atr : structure;
  const minWide = fill * (1 + minPct);
  const maxRisk = fill * (1 + maxPct);
  let sl = Math.max(structure, atrSl, minWide);
  sl = Math.min(sl, maxRisk);
  return sl > fill ? sl : null;
}

/**
 * Dynamic SL — autopsy-driven: widen to survive loser MAE p75 (~1.66%), anchor to sweep wick.
 */
export function resolveDynamicSlPrice(entry, c1, c2, side, atrVal, pre, opts = {}) {
  const fill = Number(entry);
  const base = resolveAdaptiveSlPrice(fill, c1, c2, side, atrVal, opts);
  if (!Number.isFinite(base)) return null;

  const buf = num(opts.tokyoSlBufferPct ?? opts.slBufferPct, 0.0005);
  const { lo2, hi2, span } = first2Box(c1, c2);
  const sweep = detectPreAsiaSweep(c2, pre, buf);
  const cls = classifyTokyoSetup(c1, c2, pre, side);

  if (side === "BUY") {
    let sl = base;
    if (sweep?.type === "SWEEP_LO_FADE") {
      sl = Math.min(sl, Math.min(lo2, pre?.lo ?? lo2) * (1 - buf) - span * 0.15);
    } else if (sweep?.type === "SWEEP_HI_FADE") {
      sl = Math.min(sl, lo2 * (1 - buf) - span * 0.25);
    } else if (!cls.aligned) {
      sl = Math.min(sl, c1.low * (1 - buf) - span * 0.2);
    }
    const maxRisk = fill * (1 - num(opts.tokyoSlMaxPct ?? opts.slMaxPct, 0.009));
    sl = Math.max(sl, maxRisk);
    return sl < fill ? sl : null;
  }

  let sl = base;
  if (sweep?.type === "SWEEP_HI_FADE") {
    sl = Math.max(sl, Math.max(hi2, pre?.hi ?? hi2) * (1 + buf) + span * 0.15);
  } else if (sweep?.type === "SWEEP_LO_FADE") {
    sl = Math.max(sl, hi2 * (1 + buf) + span * 0.25);
  } else if (!cls.aligned) {
    sl = Math.max(sl, c1.high * (1 + buf) + span * 0.2);
  }
  const maxRisk = fill * (1 + num(opts.tokyoSlMaxPct ?? opts.slMaxPct, 0.009));
  sl = Math.min(sl, maxRisk);
  return sl > fill ? sl : null;
}

export function resolveTokyoSlPrice(entry, c1, c2, side, atrVal, pre, opts = {}) {
  const mode = String(opts.tokyoSlMode ?? opts.slMode ?? TOKYO_SESSION_DEFAULTS.slMode).toUpperCase();
  if (mode === "DYNAMIC") return resolveDynamicSlPrice(entry, c1, c2, side, atrVal, pre, opts);
  if (mode === "ADAPTIVE") return resolveAdaptiveSlPrice(entry, c1, c2, side, atrVal, opts);
  return legacySlPrice(c1, c2, side, opts);
}

/**
 * Dynamic TP1 + TP2 legs from trade autopsy:
 * - TP1: early scalp (0.8R / first-2 mid / min 0.35%) — 50% partial
 * - TP2: runner (1.75R + overnight extension / EQ / first-2 liquidity)
 */
export function resolveDynamicTpLegs(entry, sl, side, c1, c2, pre, opts = {}) {
  const fill = Number(entry);
  const risk = Math.abs(fill - sl);
  if (!(risk > 0)) return null;

  const tp1Rr = num(opts.tokyoTp1Rr ?? opts.tp1Rr, TOKYO_SESSION_DEFAULTS.tp1Rr);
  const tp1MinPct = num(opts.tokyoTp1MinPct ?? opts.tp1MinPct, TOKYO_SESSION_DEFAULTS.tp1MinPct);
  const tp2Rr = num(opts.tokyoTp2Rr ?? opts.tp2Rr, TOKYO_SESSION_DEFAULTS.tp2Rr);
  const tp2MinPct = num(opts.tokyoTp2MinPct ?? opts.tp2MinPct, TOKYO_SESSION_DEFAULTS.tp2MinPct);
  const tp2MaxPct = num(opts.tokyoTp2MaxPct ?? opts.tp2MaxPct, TOKYO_SESSION_DEFAULTS.tp2MaxPct);
  const tp2PreFrac = num(opts.tokyoTp2PreWidthFrac ?? opts.tp2PreWidthFrac, TOKYO_SESSION_DEFAULTS.tp2PreWidthFrac);
  const { hi2, lo2, mid, span } = first2Box(c1, c2);
  const sweep = detectPreAsiaSweep(c2, pre);
  const cls = classifyTokyoSetup(c1, c2, pre, side);

  if (side === "BUY") {
    const rr1 = fill + tp1Rr * risk;
    const min1 = fill + fill * tp1MinPct;
    const struct1 = mid > fill + fill * 0.001 ? mid : rr1;
    let tp1 = Math.min(Math.max(Math.min(rr1, struct1), min1), fill + risk);
    if (!(tp1 > fill)) tp1 = fill + Math.max(risk * 0.5, fill * tp1MinPct);

    let tp2 = fill + tp2Rr * risk;
    if (pre?.width > 0) tp2 = Math.max(tp2, fill + pre.width * tp2PreFrac);
    if (sweep?.type === "SWEEP_LO_FADE" && pre?.mid > fill) tp2 = Math.max(tp2, pre.mid);
    if (cls.setup === "BODY_ALIGN" || cls.setup === "MOMENTUM") tp2 = Math.max(tp2, hi2 + span * 0.4);
    tp2 = Math.max(tp2, fill + fill * tp2MinPct);
    tp2 = Math.min(tp2, fill + fill * tp2MaxPct);
    if (tp2 <= tp1) tp2 = tp1 + risk * 0.9;
    return { tp1, tp2 };
  }

  const rr1 = fill - tp1Rr * risk;
  const min1 = fill - fill * tp1MinPct;
  const struct1 = mid < fill - fill * 0.001 ? mid : rr1;
  let tp1 = Math.max(Math.min(Math.max(rr1, struct1), min1), fill - risk);
  if (!(tp1 < fill)) tp1 = fill - Math.max(risk * 0.5, fill * tp1MinPct);

  let tp2 = fill - tp2Rr * risk;
  if (pre?.width > 0) tp2 = Math.min(tp2, fill - pre.width * tp2PreFrac);
  if (sweep?.type === "SWEEP_HI_FADE" && pre?.mid < fill) tp2 = Math.min(tp2, pre.mid);
  if (cls.setup === "BODY_ALIGN" || cls.setup === "MOMENTUM") tp2 = Math.min(tp2, lo2 - span * 0.4);
  tp2 = Math.min(tp2, fill - fill * tp2MinPct);
  tp2 = Math.max(tp2, fill - fill * tp2MaxPct);
  if (tp2 >= tp1) tp2 = tp1 - risk * 0.9;
  return { tp1, tp2 };
}

/** Single TP fallback (no partial). */
export function resolveDynamicTpPrice(entry, sl, side, c1, c2, pre, opts = {}) {
  const legs = resolveDynamicTpLegs(entry, sl, side, c1, c2, pre, opts);
  return legs?.tp2 ?? null;
}

function sessionPriorBars(candles, sessionBarIdx, uptoBarIdx, dayKey, sessionDay) {
  const out = [];
  for (let j = 0; j < candles.length; j++) {
    if (sessionDay[j] !== dayKey) continue;
    const sb = sessionBarIdx[j];
    if (sb < 0 || sb >= uptoBarIdx) continue;
    out.push(candles[j]);
  }
  return out;
}

export function sessionSweptPreLowBefore(candles, sessionBarIdx, uptoBarIdx, dayKey, sessionDay, pre, buf = 0.0003) {
  if (!pre) return false;
  for (const b of sessionPriorBars(candles, sessionBarIdx, uptoBarIdx, dayKey, sessionDay)) {
    if (b.low < pre.lo * (1 - buf)) return true;
  }
  return false;
}

export function sessionSweptPreHighBefore(candles, sessionBarIdx, uptoBarIdx, dayKey, sessionDay, pre, buf = 0.0003) {
  if (!pre) return false;
  for (const b of sessionPriorBars(candles, sessionBarIdx, uptoBarIdx, dayKey, sessionDay)) {
    if (b.high > pre.hi * (1 + buf)) return true;
  }
  return false;
}

/**
 * Sweep-fade brackets — study winner: hi sweep short → SL above wick, TP at pre-Asia low.
 */
export function buildSweepFadeBrackets(entry, bar, side, sweep, pre, opts = {}) {
  const fill = Number(entry);
  if (!Number.isFinite(fill) || fill <= 0 || !pre || !sweep) return null;

  const buf = num(opts.tokyoSlBufferPct ?? opts.slBufferPct, 0.001);
  const minSlPct = num(opts.tokyoSlMinPct ?? opts.slMinPct, 0.004);
  const maxSlPct = num(opts.tokyoSlMaxPct ?? opts.slMaxPct, 0.012);
  const minTpPct = num(opts.tokyoTpMinPct ?? opts.tpMinPct, 0.005);
  const tpTarget = String(opts.sweepTpTarget ?? opts.tokyoSweepTpTarget ?? "PRE_LOW").toUpperCase();
  const minRr = num(opts.tokyoTpMinRr ?? opts.tpMinRr, 1.2);

  let sl;
  let tp;
  if (side === "SELL") {
    sl = bar.high * (1 + buf);
    let slPct = (sl - fill) / fill;
    if (slPct < minSlPct) sl = fill * (1 + minSlPct);
    if (slPct > maxSlPct) sl = fill * (1 + maxSlPct);
    tp =
      tpTarget === "PRE_MID"
        ? pre.mid
        : tpTarget === "PRE_HIGH"
          ? pre.hi
          : pre.lo;
    if (!(tp < fill)) tp = fill - (sl - fill) * minRr;
    const tpPct = (fill - tp) / fill;
    if (tpPct < minTpPct) tp = fill * (1 - minTpPct);
  } else {
    sl = bar.low * (1 - buf);
    let slPct = (fill - sl) / fill;
    if (slPct < minSlPct) sl = fill * (1 - minSlPct);
    if (slPct > maxSlPct) sl = fill * (1 - maxSlPct);
    tp =
      tpTarget === "PRE_MID"
        ? pre.mid
        : tpTarget === "PRE_LOW"
          ? pre.lo
          : pre.hi;
    if (!(tp > fill)) tp = fill + (fill - sl) * minRr;
    const tpPct = (tp - fill) / fill;
    if (tpPct < minTpPct) tp = fill * (1 + minTpPct);
  }

  const risk = Math.abs(fill - sl);
  if (!(risk > 0)) return null;
  const tpDist = Math.abs(tp - fill);
  if (!(tpDist > 0)) return null;

  const slPct = risk / fill;
  const tpPct = tpDist / fill;
  const partialOn = opts.tokyoPartialTp !== false && opts.partialTp !== false;

  return {
    slPct,
    tpPct,
    tp1Pct: 0,
    slPrice: sl,
    tpPrice: tp,
    tp1Price: 0,
    tp2Price: tp,
    rr: tpPct / slPct,
    levelType: sweep.type === "SWEEP_HI_FADE" ? "pre_asia_high" : "pre_asia_low",
    level: sweep.level,
    sweepWick: sweep.wick,
    opposingLevel: tp,
    liqQuality: 1.4,
    partialTp: false,
    partialFrac: 0.5,
    tp2Enabled: true,
    tpMode: "tokyo_sweep_fade",
    beTriggerPx: 0,
    tokyoMeta: {
      setup: sweep.type,
      aligned: true,
      sweepType: sweep.type,
      preAsiaHi: pre.hi,
      preAsiaLo: pre.lo,
      preAsiaMid: pre.mid,
      preAsiaWidth: pre.width,
      sweepTpTarget: tpTarget,
      slDistPct: slPct,
      tpDistPct: tpPct,
      tp2Rr: tpPct / slPct,
      entryMode: opts.entryMode ?? opts.tokyoEntryMode,
    },
  };
}

export function resolveTokyoEntry(candles, i, sessionBarIdxArr, sessionDayArr, dayKey, pre, opts = {}) {
  const mode = String(opts.entryMode ?? opts.tokyoEntryMode ?? TOKYO_SESSION_DEFAULTS.entryMode).toUpperCase();
  const sb = sessionBarIdxArr[i];
  const c2 = candles[i];
  const c1 = candles[i - 1];
  if (!c2) return null;

  if (mode === "FIRST2") {
    if (sb !== 1 || !c1) return null;
    const side = resolveTokyoDirection(c1, c2, opts);
    if (!side) return null;
    const sweep = detectPreAsiaSweep(c2, pre);
    const cls = classifyTokyoSetup(c1, c2, pre, side);
    if (opts.tokyoSkipMisaligned === true && !cls.aligned) return null;
    return { side, c1, c2, bar: c2, sweep, setup: cls.setup };
  }

  const maxScan = num(opts.sweepMaxBarIdx ?? opts.tokyoSweepMaxBarIdx, TOKYO_SESSION_DEFAULTS.sweepMaxBarIdx);
  if (sb < 0 || sb > maxScan) return null;

  const sweep = detectPreAsiaSweep(c2, pre);
  if (!sweep) return null;
  if (mode === "SWEEP_HI_ONLY" && sweep.type !== "SWEEP_HI_FADE") return null;
  if (mode === "SWEEP_LO_ONLY" && sweep.type !== "SWEEP_LO_FADE") return null;

  const minW = num(opts.minPreAsiaWidthPct ?? opts.tokyoMinPreAsiaWidthPct, 0);
  if (minW > 0 && pre && pre.width / c2.close < minW) return null;

  if ((opts.hiSweepOnlyDays === true || opts.tokyoHiSweepOnlyDays === true) && sweep.type === "SWEEP_HI_FADE") {
    if (sessionSweptPreLowBefore(candles, sessionBarIdxArr, sb, dayKey, sessionDayArr, pre)) return null;
  }
  if ((opts.loSweepOnlyDays === true || opts.tokyoLoSweepOnlyDays === true) && sweep.type === "SWEEP_LO_FADE") {
    if (sessionSweptPreHighBefore(candles, sessionBarIdxArr, sb, dayKey, sessionDayArr, pre)) return null;
  }

  return { side: sweep.side, c1: c1 ?? c2, c2, bar: c2, sweep, setup: sweep.type };
}

export function buildTokyoBrackets(entry, c1, c2, side, opts = {}, atrVal = 0, pre = null) {
  const fill = Number(entry);
  if (!Number.isFinite(fill) || fill <= 0) return null;

  const slMode = String(opts.tokyoSlMode ?? opts.slMode ?? TOKYO_SESSION_DEFAULTS.slMode).toUpperCase();
  const tpMode = String(opts.tokyoTpMode ?? opts.tpMode ?? TOKYO_SESSION_DEFAULTS.tpMode).toUpperCase();
  const slPrice = resolveTokyoSlPrice(fill, c1, c2, side, atrVal, pre, opts);
  if (!Number.isFinite(slPrice)) return null;

  const risk = Math.abs(fill - slPrice);
  if (!(risk > 0)) return null;

  const rr = Math.max(0.5, num(opts.tokyoTpRr ?? opts.tpRr, TOKYO_SESSION_DEFAULTS.tpRr));
  const partialOn = opts.tokyoPartialTp !== false && opts.partialTp !== false;
  const partialFrac = num(opts.tokyoPartialFrac ?? opts.partialFrac, 0.5);

  let tp1Price = 0;
  let tpPrice = 0;
  if (tpMode === "DYNAMIC") {
    const legs = resolveDynamicTpLegs(fill, slPrice, side, c1, c2, pre, opts);
    if (!legs) return null;
    tp1Price = legs.tp1;
    tpPrice = legs.tp2;
  } else {
    tpPrice = side === "BUY" ? fill + rr * risk : fill - rr * risk;
    tp1Price = partialOn ? (side === "BUY" ? fill + risk : fill - risk) : 0;
  }
  if (!Number.isFinite(tpPrice)) return null;

  const slPct = risk / fill;
  const tpPct = Math.abs(tpPrice - fill) / fill;
  const tp1Pct = tp1Price > 0 ? Math.abs(tp1Price - fill) / fill : 0;
  const { hi2, lo2 } = first2Box(c1, c2);
  const cls = classifyTokyoSetup(c1, c2, pre, side);

  return {
    slPct,
    tpPct,
    tp1Pct,
    slPrice,
    tpPrice,
    tp1Price: partialOn ? tp1Price : 0,
    tp2Price: tpPrice,
    rr: tpPct / slPct,
    levelType: "tokyo_first2",
    level: side === "BUY" ? lo2 : hi2,
    sweepWick: side === "BUY" ? c2.low : c2.high,
    opposingLevel: tpPrice,
    liqQuality: cls.aligned ? 1.2 : 0.8,
    partialTp: partialOn,
    partialFrac,
    tp2Enabled: true,
    tpMode: partialOn && tp1Price > 0 ? "tokyo_dynamic_partial" : tpMode === "DYNAMIC" ? "tokyo_dynamic" : "tokyo_rr",
    beTriggerPx: partialOn && tp1Price > 0 ? tp1Price : 0,
    tokyoMeta: {
      first2High: hi2,
      first2Low: lo2,
      preAsiaHi: pre?.hi ?? null,
      preAsiaLo: pre?.lo ?? null,
      preAsiaMid: pre?.mid ?? null,
      preAsiaWidth: pre?.width ?? null,
      setup: cls.setup,
      aligned: cls.aligned,
      c1Open: c1.open,
      c1Close: c1.close,
      c2Open: c2.open,
      c2Close: c2.close,
      dirMode: opts.tokyoDirMode ?? opts.dirMode,
      slMode,
      tpMode,
      slDistPct: slPct,
      tpDistPct: tpPct,
      tp1DistPct: tp1Pct,
      tp2DistPct: tpPct,
      tp1Rr: tp1Pct > 0 ? tp1Pct / slPct : null,
      tp2Rr: tpPct / slPct,
      tpRr: rr,
      atrAtEntry: atrVal > 0 ? atrVal : null,
    },
  };
}

export function buildTokyoSessionIndex(candles, opts = {}) {
  const n = candles.length;
  const sessionBarIdx = new Int16Array(n).fill(-1);
  const sessionDay = new Array(n).fill(null);
  let curDay = null;
  let idxInSession = 0;

  for (let i = 0; i < n; i++) {
    const ts = candles[i].ts;
    if (!inTokyoSession(ts, opts)) {
      sessionBarIdx[i] = -1;
      continue;
    }
    const d = tokyoSessionDayId(ts, opts);
    if (d !== curDay) {
      curDay = d;
      idxInSession = 0;
    }
    sessionBarIdx[i] = idxInSession;
    sessionDay[i] = d;
    idxInSession += 1;
  }
  return { sessionBarIdx, sessionDay };
}

export function buildTokyoSessionRangeByDay(candles, opts = {}) {
  const map = new Map();
  for (const c of candles) {
    if (!inTokyoSession(c.ts, opts)) continue;
    const d = tokyoSessionDayId(c.ts, opts);
    let row = map.get(d);
    if (!row) {
      row = { dayId: d, startTs: c.ts, endTs: c.ts, high: c.high, low: c.low };
      map.set(d, row);
    } else {
      row.endTs = c.ts;
      row.high = Math.max(row.high, c.high);
      row.low = Math.min(row.low, c.low);
    }
  }
  return map;
}

export function buildTokyoSessionSeries(candles, opts = {}, atrSeries = null) {
  const o = { ...TOKYO_SESSION_DEFAULTS, ...opts };
  const n = candles.length;
  const out = new Array(n).fill(null);
  const { sessionBarIdx, sessionDay } = buildTokyoSessionIndex(candles, o);
  const sessionRanges = buildTokyoSessionRangeByDay(candles, o);
  const preAsia = buildPreAsiaRangeByDay(candles, o);
  const tradesPerDay = new Map();

  const entryMode = String(o.entryMode ?? o.tokyoEntryMode ?? TOKYO_SESSION_DEFAULTS.entryMode).toUpperCase();
  const sweepEntry = entryMode !== "FIRST2";

  for (let i = 0; i < n; i++) {
    if (sessionBarIdx[i] < 0) continue;
    if (!sweepEntry && sessionBarIdx[i] !== 1) continue;

    const dayKey = sessionDay[i];
    const count = tradesPerDay.get(dayKey) ?? 0;
    if (count >= o.maxTradesPerDay) continue;

    const pre = preAsia.get(dayKey) ?? null;
    const entryRes = resolveTokyoEntry(candles, i, sessionBarIdx, sessionDay, dayKey, pre, o);
    if (!entryRes) continue;

    const { side, c1, c2, bar, sweep, setup } = entryRes;

    if (!sweepEntry) {
      const minRange = num(o.tokyoMinFirst2RangePct ?? o.minFirst2RangePct, 0);
      const rangePct = (Math.max(c1.high, c2.high) - Math.min(c1.low, c2.low)) / c2.close;
      if (minRange > 0 && rangePct < minRange) continue;
    }

    const entry = c2.close;
    const atrVal = atrSeries?.[i] ?? 0;
    const brackets = sweepEntry
      ? buildSweepFadeBrackets(entry, bar, side, sweep, pre, o)
      : buildTokyoBrackets(entry, c1, c2, side, o, atrVal, pre);
    if (!brackets) continue;

    const sess = sessionRanges.get(dayKey);
    if (sess) {
      brackets.tokyoMeta.sessionStartTs = sess.startTs;
      brackets.tokyoMeta.sessionEndTs = sess.endTs;
      brackets.tokyoMeta.sessionHigh = sess.high;
      brackets.tokyoMeta.sessionLow = sess.low;
    }

    tradesPerDay.set(dayKey, count + 1);
    out[i] = {
      action: side,
      reason: `tokyo_${side.toLowerCase()}_${String(setup ?? brackets.tokyoMeta.setup ?? "setup").toLowerCase()}`,
      playbook: sweepEntry ? "TOKYO_SWEEP_FADE" : "TOKYO_FIRST2",
      trigger: sweepEntry ? "pre_asia_sweep_reject" : "first_two_candles",
      liqBrackets: brackets,
      techniques: ["tokyo_session"],
    };
  }

  return out;
}
