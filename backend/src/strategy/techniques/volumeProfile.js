/**
 * Volume Profile — Auction Market Theory levels + structure setups.
 *
 * Modes (`vpProfileMode` / `mode`):
 *   - `composite_utc` (default): last N UTC days ending at bar (multi-day value)
 *   - `session_utc`: developing profile from UTC day open only
 *   - `rolling`: fixed bar lookback (legacy)
 *
 * Histogram: OHLCV volume across high–low (uniform or close_weighted).
 * VA: contiguous expand from POC to ~70% volume. Prior-day naked POC supported.
 */

const DEFAULT_LOOKBACK = 192;
const DEFAULT_BINS = 50;
const VALUE_AREA_PCT = 0.7;
const HVN_TOP_PCT = 0.15;
const LVN_VALLEY_MULT = 0.55;
const SESSION_MIN_BARS = 8;
const MS_DAY = 86_400_000;

export const VP_SETUP_TIERS = {
  lvn_vacuum: "A",
  vah_breakout: "A",
  val_breakdown: "A",
  poc_bounce: "B",
  va_rejection: "B",
  hvn_flip: "B",
  naked_poc: "B",
};

const VP_PENALTIES = {
  vp_long_at_vah_ceiling: 4,
  vp_short_at_val_floor: 4,
  vp_long_below_poc_gravity: 3,
  vp_short_above_poc_gravity: 3,
  vp_rr_too_low: 5,
  vp_no_room_to_run: 4,
};

function nearLevel(price, level, tolPct) {
  return level > 0 && Math.abs(price - level) / level <= tolPct;
}

function utcDayStartMs(ts) {
  return Math.floor(Number(ts) / MS_DAY) * MS_DAY;
}

export function resolveVolumeProfileGateMode(opts = {}) {
  if (opts.volumeProfileEnabled === false) return "off";
  if (opts.volumeProfileGateMode === "soft" || opts.volumeProfileGateMode === "strict") {
    return opts.volumeProfileGateMode;
  }
  if (opts.volumeProfileSoftGates === true) return "soft";
  if (opts.volumeProfileGatesEnabled === true) return "strict";
  return "off";
}

/** @returns {"session_utc"|"composite_utc"|"rolling"} */
export function resolveVpProfileMode(opts = {}) {
  const raw = String(opts.mode ?? opts.vpProfileMode ?? "rolling").toLowerCase();
  if (raw === "session_utc" || raw === "session") return "session_utc";
  if (raw === "composite_utc" || raw === "composite") return "composite_utc";
  return "rolling";
}

export function resolveUtcSessionSlice(candles, endIdx) {
  if (!candles?.length || endIdx < 0 || endIdx >= candles.length) return null;
  const dayStart = utcDayStartMs(candles[endIdx].ts);
  let start = endIdx;
  while (start > 0 && utcDayStartMs(candles[start - 1].ts) === dayStart) start -= 1;
  return { startIdx: start, endIdx, dayStartMs: dayStart };
}

export function resolvePriorUtcSessionSlice(candles, endIdx, beforeDayStartMs) {
  if (!candles?.length || endIdx < 1) return null;
  let i = endIdx;
  while (i >= 0 && utcDayStartMs(candles[i].ts) >= beforeDayStartMs) i -= 1;
  if (i < 0) return null;
  const priorDay = utcDayStartMs(candles[i].ts);
  let start = i;
  while (start > 0 && utcDayStartMs(candles[start - 1].ts) === priorDay) start -= 1;
  return { startIdx: start, endIdx: i, dayStartMs: priorDay };
}

function findIdxOnOrAfter(candles, endIdx, dayStartMs) {
  let lo = 0;
  let hi = endIdx;
  let ans = endIdx;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (utcDayStartMs(candles[mid].ts) >= dayStartMs) {
      ans = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  while (ans > 0 && utcDayStartMs(candles[ans - 1].ts) >= dayStartMs) ans -= 1;
  if (utcDayStartMs(candles[ans].ts) < dayStartMs && ans < endIdx) {
    while (ans <= endIdx && utcDayStartMs(candles[ans].ts) < dayStartMs) ans += 1;
  }
  return ans <= endIdx ? ans : null;
}

function buildHistogram(slice, bins, opts = {}) {
  const lo = Math.min(...slice.map((c) => Number(c.low)));
  const hi = Math.max(...slice.map((c) => Number(c.high)));
  if (!(hi > lo) || bins < 4) return null;
  const tick = (hi - lo) / bins;
  if (!(tick > 0)) return null;
  const distribute = String(opts.distribute ?? opts.vpVolumeDistribute ?? "uniform").toLowerCase();
  const vols = new Float64Array(bins);
  let totalVol = 0;
  for (const c of slice) {
    const vol = Number(c.volume) || 0;
    if (vol <= 0) continue;
    const barLo = Number(c.low);
    const barHi = Number(c.high);
    if (!(barHi >= barLo)) continue;
    let i0 = Math.floor((barLo - lo) / tick);
    let i1 = Math.floor((barHi - lo) / tick);
    i0 = Math.max(0, Math.min(bins - 1, i0));
    i1 = Math.max(0, Math.min(bins - 1, i1));
    if (i1 < i0) { const t = i0; i0 = i1; i1 = t; }
    const n = i1 - i0 + 1;
    if (distribute === "close_weighted" && n > 1) {
      const close = Number(c.close);
      const closeFrac = barHi > barLo ? Math.max(0, Math.min(1, (close - barLo) / (barHi - barLo))) : 0.5;
      const closeBin = Math.max(0, Math.min(bins - 1, Math.floor((close - lo) / tick)));
      let wSum = 0;
      const weights = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const bi = i0 + k;
        const dist = Math.abs(bi - closeBin);
        const w = 1 / (1 + dist) + 0.25 * (1 - Math.abs(k / (n - 1) - closeFrac));
        weights[k] = w;
        wSum += w;
      }
      for (let k = 0; k < n; k++) vols[i0 + k] += (vol * weights[k]) / wSum;
    } else {
      const per = vol / n;
      for (let bi = i0; bi <= i1; bi++) vols[bi] += per;
    }
    totalVol += vol;
  }
  if (!(totalVol > 0)) return null;
  const nodes = [];
  for (let i = 0; i < bins; i++) {
    if (vols[i] <= 0) continue;
    nodes.push({ price: lo + (i + 0.5) * tick, volume: vols[i], bin: i });
  }
  return nodes.length ? { nodes, totalVol, lo, hi, tick, bins } : null;
}

export function valueAreaFromNodes(nodes, totalVol, valueAreaPct = VALUE_AREA_PCT) {
  if (!nodes.length || totalVol <= 0) return { poc: 0, vah: 0, val: 0 };
  let pocNode = nodes[0];
  for (const n of nodes) if (n.volume > pocNode.volume) pocNode = n;
  const poc = pocNode.price;
  const byPrice = [...nodes].sort((a, b) => a.price - b.price);
  let pocIdx = byPrice.findIndex((n) => n.price === poc);
  if (pocIdx < 0) {
    pocIdx = byPrice.reduce((best, n, i) => (Math.abs(n.price - poc) < Math.abs(byPrice[best].price - poc) ? i : best), 0);
  }
  let lo = pocIdx, hi = pocIdx, acc = byPrice[pocIdx].volume;
  const target = totalVol * valueAreaPct;
  while (acc < target && (lo > 0 || hi < byPrice.length - 1)) {
    const volBelow = lo > 0 ? byPrice[lo - 1].volume : -1;
    const volAbove = hi < byPrice.length - 1 ? byPrice[hi + 1].volume : -1;
    if (volBelow >= volAbove && lo > 0) { lo -= 1; acc += byPrice[lo].volume; }
    else if (hi < byPrice.length - 1) { hi += 1; acc += byPrice[hi].volume; }
    else if (lo > 0) { lo -= 1; acc += byPrice[lo].volume; }
    else break;
  }
  return { poc, vah: byPrice[hi].price, val: byPrice[lo].price, valueAreaPct, valueAreaVolFrac: acc / totalVol };
}

function classifyNodes(nodes) {
  if (!nodes.length) return { hvn: [], lvn: [] };
  const meanVol = nodes.reduce((s, n) => s + n.volume, 0) / nodes.length;
  const sorted = [...nodes].sort((a, b) => b.volume - a.volume);
  const topN = Math.max(3, Math.ceil(nodes.length * HVN_TOP_PCT));
  const hvnSet = new Set(sorted.slice(0, topN).map((n) => n.price));
  const hvn = nodes.filter((n) => hvnSet.has(n.price));
  const lvn = [];
  for (let i = 1; i < nodes.length - 1; i++) {
    const cur = nodes[i];
    if (cur.volume < nodes[i - 1].volume && cur.volume < nodes[i + 1].volume && cur.volume < meanVol * LVN_VALLEY_MULT) lvn.push(cur);
  }
  return { hvn, lvn };
}

function mergeLvnZones(lvn, tick) {
  if (!lvn.length) return [];
  const sorted = [...lvn].sort((a, b) => a.price - b.price);
  const zones = [];
  let zone = { low: sorted[0].price, high: sorted[0].price };
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].price - zone.high <= tick * 1.5) zone.high = sorted[i].price;
    else { zones.push({ ...zone }); zone = { low: sorted[i].price, high: sorted[i].price }; }
  }
  zones.push(zone);
  return zones;
}

function finalizeProfile(slice, hist, meta = {}) {
  const valueAreaPct = Number(meta.valueAreaPct ?? VALUE_AREA_PCT);
  const { poc, vah, val, valueAreaVolFrac } = valueAreaFromNodes(hist.nodes, hist.totalVol, valueAreaPct);
  const { hvn, lvn } = classifyNodes(hist.nodes);
  return {
    poc, vah, val, totalVol: hist.totalVol, nodes: hist.nodes, hvn, lvn,
    lvnZones: mergeLvnZones(lvn, hist.tick),
    lo: hist.lo, hi: hist.hi, tick: hist.tick, bins: hist.bins,
    valueAreaPct, valueAreaVolFrac, barCount: slice.length, ...meta,
  };
}

function profileFromSlice(candles, startIdx, endIdx, opts = {}) {
  const slice = candles.slice(startIdx, endIdx + 1);
  if (slice.length < Number(opts.minBars ?? SESSION_MIN_BARS)) return null;
  const bins = Number(opts.bins ?? opts.vpBins ?? DEFAULT_BINS);
  const hist = buildHistogram(slice, bins, opts);
  if (!hist) return null;
  const valueAreaPct = Number(opts.valueAreaPct ?? opts.vpValueAreaPct ?? VALUE_AREA_PCT);
  return finalizeProfile(slice, hist, {
    lookback: slice.length, startIdx, endIdx, valueAreaPct,
    mode: opts.modeLabel ?? "slice", sessionStartMs: opts.sessionStartMs ?? null,
    compositeDays: opts.compositeDays, compositeStartMs: opts.compositeStartMs,
  });
}

export function sessionTradedThrough(candles, startIdx, endIdx, price, tolPct = 0) {
  if (!Number.isFinite(price) || price <= 0) return false;
  const lo = price * (1 - tolPct), hi = price * (1 + tolPct);
  for (let i = startIdx; i <= endIdx; i++) {
    if (candles[i].low <= hi && candles[i].high >= lo) return true;
  }
  return false;
}

function attachPriorSession(candles, endIdx, sess, profile, histOpts, opts) {
  if (opts.includePriorSession === false || !profile || !sess) return profile;
  const priorSlice = resolvePriorUtcSessionSlice(candles, endIdx, sess.dayStartMs);
  if (!priorSlice) return profile;
  const prior = profileFromSlice(candles, priorSlice.startIdx, priorSlice.endIdx, {
    ...histOpts, minBars: Number(opts.priorSessionMinBars ?? 24),
    modeLabel: "prior_session_utc", sessionStartMs: priorSlice.dayStartMs,
  });
  if (!prior) return profile;
  const naked = Number.isFinite(prior.poc) && prior.poc > 0 &&
    !sessionTradedThrough(candles, sess.startIdx, endIdx, prior.poc, Number(opts.nakedPocTolPct ?? 0));
  profile.priorSession = { poc: prior.poc, vah: prior.vah, val: prior.val, sessionStartMs: prior.sessionStartMs, barCount: prior.barCount };
  profile.nakedPoc = naked ? prior.poc : null;
  profile.nakedPocActive = naked;
  const byPx = new Map();
  for (const n of [...(profile.hvn || []), ...(prior.hvn || [])]) {
    const k = Number(n.price);
    if (!Number.isFinite(k)) continue;
    const prev = byPx.get(k);
    if (!prev || n.volume > prev.volume) byPx.set(k, n);
  }
  profile.hvn = [...byPx.values()].sort((a, b) => a.price - b.price);
  return profile;
}

export function buildVolumeProfile(candles, endIdx, opts = {}) {
  const mode = resolveVpProfileMode(opts);
  const bins = Number(opts.bins ?? opts.vpBins ?? DEFAULT_BINS);
  const valueAreaPct = Number(opts.valueAreaPct ?? opts.vpValueAreaPct ?? VALUE_AREA_PCT);
  const histOpts = { bins, valueAreaPct, distribute: opts.distribute ?? opts.vpVolumeDistribute };

  if (mode === "rolling") {
    const lookback = Number(opts.lookback ?? opts.vpLookbackBars ?? DEFAULT_LOOKBACK);
    const start = Math.max(0, endIdx - lookback + 1);
    const slice = candles.slice(start, endIdx + 1);
    if (slice.length < 24) return null;
    const hist = buildHistogram(slice, bins, histOpts);
    if (!hist) return null;
    return finalizeProfile(slice, hist, { lookback, startIdx: start, endIdx, valueAreaPct, mode: "rolling", sessionStartMs: null });
  }

  const sess = resolveUtcSessionSlice(candles, endIdx);
  if (!sess) return null;
  let profile = null;
  if (mode === "session_utc") {
    profile = profileFromSlice(candles, sess.startIdx, sess.endIdx, {
      ...histOpts, minBars: Number(opts.sessionMinBars ?? SESSION_MIN_BARS),
      modeLabel: "session_utc", sessionStartMs: sess.dayStartMs,
    });
  } else {
    const days = Math.max(1, Math.floor(Number(opts.vpCompositeDays ?? opts.compositeDays ?? 5)));
    const rangeStartMs = sess.dayStartMs - (days - 1) * MS_DAY;
    const startIdx = findIdxOnOrAfter(candles, endIdx, rangeStartMs);
    if (startIdx == null || startIdx > endIdx) return null;
    profile = profileFromSlice(candles, startIdx, endIdx, {
      ...histOpts, minBars: Number(opts.sessionMinBars ?? 24),
      modeLabel: "composite_utc", sessionStartMs: sess.dayStartMs,
      compositeDays: days, compositeStartMs: rangeStartMs,
    });
  }
  if (!profile) return null;
  return attachPriorSession(candles, endIdx, sess, profile, histOpts, opts);
}

export function rollingVolumeProfile(candles, endIdx, lookback = DEFAULT_LOOKBACK, bins = DEFAULT_BINS) {
  return buildVolumeProfile(candles, endIdx, { mode: "rolling", lookback, bins });
}

export function nearestHvnAbove(price, hvn, minDistPct = 0.002) {
  const above = hvn.filter((n) => n.price > price * (1 + minDistPct)).sort((a, b) => a.price - b.price);
  return above[0] ?? null;
}

export function nearestHvnBelow(price, hvn, minDistPct = 0.002) {
  const below = hvn.filter((n) => n.price < price * (1 - minDistPct)).sort((a, b) => b.price - a.price);
  return below[below.length - 1] ?? null;
}

export function inLvnZone(price, lvnZones) {
  for (const z of lvnZones) {
    if (price >= z.low && price <= z.high) return z;
  }
  return null;
}

export function pathToNextHvn(price, side, vp) {
  if (!vp) return null;
  if (side === "BUY") {
    const target = nearestHvnAbove(price, vp.hvn, 0.001);
    if (!target) return { targetPrice: vp.hi, distPct: (vp.hi - price) / price, kind: "range_high" };
    return { targetPrice: target.price, distPct: (target.price - price) / price, kind: "hvn" };
  }
  const target = nearestHvnBelow(price, vp.hvn, 0.001);
  if (!target) return { targetPrice: vp.lo, distPct: (price - vp.lo) / price, kind: "range_low" };
  return { targetPrice: target.price, distPct: (price - target.price) / price, kind: "hvn" };
}

export function volumeProfileBrackets(price, side, vp, opts = {}) {
  const minRR = Number(opts.minRR ?? 1.5);
  const slBuffer = Number(opts.slBufferPct ?? 0.0015);
  const tpBuffer = Number(opts.tpBufferPct ?? 0.001);

  if (!vp || !Number.isFinite(price) || price <= 0) {
    return { sl: null, tp: null, slPct: 0, tpPct: 0, rr: 0, slReason: "no_vp", tpReason: "no_vp" };
  }

  let sl;
  let slReason;
  let tp;
  let tpReason;

  if (side === "BUY") {
    const below = nearestHvnBelow(price, vp.hvn, 0);
    const structural = Math.min(vp.val, vp.poc);
    sl = (below?.price ?? structural) * (1 - slBuffer);
    slReason = below ? "hvn_below" : "val_poc";
    const path = pathToNextHvn(price, "BUY", vp);
    tp = path.targetPrice * (1 - tpBuffer);
    tpReason = path.kind === "hvn" ? "next_hvn" : "range_high";
  } else {
    const above = nearestHvnAbove(price, vp.hvn, 0);
    const structural = Math.max(vp.vah, vp.poc);
    sl = (above?.price ?? structural) * (1 + slBuffer);
    slReason = above ? "hvn_above" : "vah_poc";
    const path = pathToNextHvn(price, "SELL", vp);
    tp = path.targetPrice * (1 + tpBuffer);
    tpReason = path.kind === "hvn" ? "next_hvn" : "range_low";
  }

  let slPct = side === "BUY" ? (price - sl) / price : (sl - price) / price;
  let tpPct = side === "BUY" ? (tp - price) / price : (price - tp) / price;

  const minSl = Number(opts.vpMinSlPct ?? 0.0025);
  const maxSl = Number(opts.vpMaxSlPct ?? 0.009);
  const maxTp = Number(opts.vpMaxTpPct ?? 0.03);
  slPct = Math.min(maxSl, Math.max(minSl, slPct));
  tpPct = Math.min(maxTp, Math.max(minSl, tpPct));

  const rr = slPct > 0 ? tpPct / slPct : 0;

  return {
    sl,
    tp,
    slPct,
    tpPct,
    rr,
    slReason,
    tpReason,
    rrOk: rr >= minRR,
  };
}

function volRatio(candles, idx, lookback = 20) {
  const volSlice = candles.slice(Math.max(0, idx - lookback), idx).map((c) => Number(c.volume) || 0);
  const avg = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  return avg > 0 ? (Number(candles[idx].volume) || 0) / avg : 1;
}

function barRange(bar) {
  return Math.max(bar.high - bar.low, 1e-12);
}

function lowerWickRatio(bar) {
  const r = barRange(bar);
  return (Math.min(bar.open, bar.close) - bar.low) / r;
}

function upperWickRatio(bar) {
  const r = barRange(bar);
  return (bar.high - Math.max(bar.open, bar.close)) / r;
}

function directionalBody(bar, side) {
  const r = barRange(bar);
  if (side === "BUY") return (bar.close - bar.open) / r;
  return (bar.open - bar.close) / r;
}

/** Close position in bar range: 0 = at low, 1 = at high */
function closeStrength(bar) {
  const r = barRange(bar);
  return (bar.close - bar.low) / r;
}

/** Signed % move over prior bars ending at idx (positive = up). */
export function priorTrendMovePct(candles, idx, lookback = 16) {
  const start = Math.max(0, idx - lookback);
  const a = candles[start]?.close;
  const b = candles[idx]?.close;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0) return 0;
  return (b - a) / a;
}

/** Whole bar must clear VA level (reduces wick-only / fake breakouts). */
export function fullBarClearsVaLevel(bar, side, vp, minBeyond = 0.0025) {
  if (!vp || !bar) return false;
  const cushion = minBeyond * 0.35;
  if (side === "BUY") return bar.low >= vp.vah * (1 + cushion);
  return bar.high <= vp.val * (1 - cushion);
}

/**
 * Regime immunity — blocks H2-style traps without killing high-path H1 winners.
 * Uses only data available at the signal bar (no lookahead).
 */
export function passesVpRegimeImmunity(candles, idx, side, setup, vp, pre, path, opts = {}) {
  if (opts.vpRegimeImmunity === false) return true;
  if (!setup || !vp || !pre) return true;

  const htfSep = pre.htfSep[idx] ?? 0;
  const minHtf = Number(opts.vpMinHtfSepPct ?? 0.0035);
  const pathDist = path?.distPct ?? 0;

  // Close-beyond-VA is enforced in setup detectors; skip full-bar clear (kills valid wick breakouts).
  if (setup === "vah_breakout" || setup === "val_breakdown") {
    const maxPrior = Number(opts.vpMaxPriorTrendPct ?? 0.012);
    const prior = priorTrendMovePct(candles, idx, Number(opts.vpPriorTrendLookback ?? 16));
    if (side === "BUY" && prior > maxPrior) return false;
    if (side === "SELL" && prior < -maxPrior) return false;
  }

  if (setup === "vah_breakout" && side === "BUY") {
    if (!pre.htfUp[idx]) return false;
    const strictBuy = Number(opts.vpBuyBreakoutMinHtfSep ?? 0.004);
    const highPath = Number(opts.vpBuyHighPathMinPct ?? 0.012);
    const relaxedMin = Number(opts.vpBuyRelaxedMinHtfSep ?? minHtf);
    if (htfSep >= strictBuy) return true;
    return htfSep >= relaxedMin && pathDist >= highPath;
  }

  if (setup === "val_breakdown" && side === "SELL") {
    if (!pre.htfDown[idx]) return false;
    const soft = Number(opts.vpSellMinHtfSepPct ?? minHtf);
    let minSell = Number(opts.vpSellBreakdownMinHtfSep ?? soft);
    if (opts.vpSellMacroAdapt === true) {
      const hard = Number(opts.vpSellMacroBullMinHtfSepPct ?? Math.max(soft, 0.005));
      const priorThresh = Number(opts.vpSellMacroPrior20dBullPct ?? 0.02);
      const above = pre.macroAboveEma20d?.[idx] === true;
      const slope = Number(pre.macroEma5dSlope?.[idx] ?? 0);
      const prior20 = Number(pre.macroPrior20d?.[idx] ?? 0);
      const macroBull = above || slope > 0 || prior20 > priorThresh;
      minSell = macroBull ? hard : soft;
      const nonBearMin = Number(opts.vpSellNonBearMinHtfSepPct ?? 0);
      if (nonBearMin > 0) {
        const bearFloor = Number(opts.vpSellBearPrior60dPct ?? -0.05);
        const prior60 = Number(pre.macroPrior60d?.[idx] ?? 0);
        if (prior60 > bearFloor) minSell = Math.max(minSell, nonBearMin);
      }
      const weakBearMin = Number(opts.vpSellWeakBearMinHtfSepPct ?? 0);
      if (weakBearMin > 0 && !macroBull) {
        const weakBearFloor = Number(opts.vpSellWeakBearPrior20dFloorPct ?? -0.1);
        if (prior20 > weakBearFloor) minSell = Math.max(minSell, weakBearMin);
      }
    }
    return htfSep >= minSell;
  }

  if (setup === "lvn_vacuum") {
    return side === "BUY" ? pre.htfUp[idx] && htfSep >= minHtf : pre.htfDown[idx] && htfSep >= minHtf;
  }

  return htfSep >= minHtf;
}

function topHvnNodes(vp, n = 3) {
  return [...vp.hvn].sort((a, b) => b.volume - a.volume).slice(0, n);
}

function wasOutsideValueArea(candles, idx, side, vp, lookback = 10) {
  const tol = 0.0015;
  const start = Math.max(0, idx - lookback);
  for (let j = start; j < idx; j++) {
    const c = candles[j].close;
    if (side === "BUY" && c > vp.vah * (1 + tol)) return true;
    if (side === "SELL" && c < vp.val * (1 - tol)) return true;
  }
  return false;
}

function detectPocBounce(candles, idx, side, vp, opts) {
  const bar = candles[idx];
  const price = bar.close;
  const tol = Number(opts.nearTolPct ?? 0.0015);
  const minWick = Number(opts.vpMinWickRatio ?? 0.32);
  const outsideLb = Number(opts.vpOutsideVaLookback ?? 12);
  const level = side === "BUY" ? Math.min(vp.poc, vp.val) : Math.max(vp.poc, vp.vah);
  const touched = nearLevel(bar.low, level, tol) || nearLevel(bar.high, level, tol) || nearLevel(price, vp.poc, tol);
  if (!touched) return null;
  if (!wasOutsideValueArea(candles, idx, side, vp, outsideLb)) return null;

  if (side === "BUY") {
    if (price > vp.vah * (1 + tol)) return null;
    if (lowerWickRatio(bar) < minWick || bar.close < bar.open) return null;
    if (directionalBody(bar, "BUY") < 0.35) return null;
    return { setup: "poc_bounce", score: 10, tier: "B", meta: { level: vp.poc } };
  }
  if (price < vp.val * (1 - tol)) return null;
  if (upperWickRatio(bar) < minWick || bar.close > bar.open) return null;
  if (directionalBody(bar, "SELL") < 0.35) return null;
  return { setup: "poc_bounce", score: 10, tier: "B", meta: { level: vp.poc } };
}

function detectLvnVacuum(candles, idx, side, vp, opts) {
  const bar = candles[idx];
  const prev = candles[idx - 1];
  const price = bar.close;
  const minRun = Number(opts.minLvnRunPct ?? 0.01);
  const minVolR = Number(opts.vpLvnMinVolRatio ?? 1.15);
  const volR = volRatio(candles, idx);

  const prevIn = inLvnZone(prev.close, vp.lvnZones);
  const nowIn = inLvnZone(price, vp.lvnZones);
  const entered = !prevIn && nowIn;
  const inZone = nowIn || entered;
  if (!inZone) return null;

  const path = pathToNextHvn(price, side, vp);
  if (!path || path.distPct < minRun || path.kind !== "hvn") return null;
  if (volR < minVolR) return null;
  const minBody = Number(opts.vpMinLvnBody ?? opts.vpMinBreakoutBody ?? 0.4);
  if (directionalBody(bar, side) < minBody) return null;

  const score = path.distPct >= 0.015 ? 14 : 12;
  return {
    setup: "lvn_vacuum",
    score,
    tier: "A",
    meta: { zone: nowIn || prevIn, target: path.targetPrice, distPct: path.distPct, volR },
  };
}

function detectVaBreakout(candles, idx, side, vp, opts) {
  const bar = candles[idx];
  const prev = candles[idx - 1];
  const price = bar.close;
  const breakoutVolR = Number(opts.vpBreakoutMinVolRatio ?? 1.5);
  const breakdownVolR = Number(opts.vpValBreakdownMinVolRatio ?? breakoutVolR);
  const minPath = Number(opts.vpBreakoutMinPathPct ?? 0.007);
  const minBeyond = Number(opts.vpMinCloseBeyondPct ?? 0.0025);
  const minBody = Number(opts.vpMinBreakoutBody ?? 0.52);
  const minCloseStrength = Number(opts.vpMinBreakoutCloseStrength ?? 0.62);
  const volR = volRatio(candles, idx);

  // Auction Market Theory: VA breakouts reference *prior completed session* value when
  // available. Developing VAH/VAL moves with the bar and is too elastic for a clean break.
  const prior = vp.priorSession;
  const usePrior = opts.vpBreakoutUsePriorSession !== false && prior?.vah > 0 && prior?.val > 0;
  const vah = usePrior ? prior.vah : vp.vah;
  const val = usePrior ? prior.val : vp.val;
  const levelSrc = usePrior ? "prior_session" : "developing";

  if (side === "BUY") {
    if (volR < breakoutVolR) return null;
    if (prev.close > vah * (1 + minBeyond)) return null;
    if (bar.close <= vah * (1 + minBeyond)) return null;
    if (directionalBody(bar, "BUY") < minBody) return null;
    if (closeStrength(bar) < minCloseStrength) return null;
    const path = pathToNextHvn(price, "BUY", vp);
    if (!path || path.distPct < minPath) return null;
    const vacuumMaxPrior5d = Number(opts.vpBuyVacuumMaxPrior5dPct ?? 0);
    if (vacuumMaxPrior5d > 0 && path.distPct >= Number(opts.vpVacuumPathPct ?? 0.02)) {
      const prior5d = priorTrendMovePct(candles, idx, Number(opts.vpBuyVacuumPrior5dLookback ?? 96 * 5));
      if (Number.isFinite(prior5d) && prior5d > vacuumMaxPrior5d) return null;
    }
    // Structured expansion only outside bull macro: vacuum VAH loses in bear/chop
    // years; capping in bull freed day-slots to worse shorts (2023–24 regression).
    const maxPath = Number(opts.vpBuyBreakoutMaxPathPct ?? 0);
    if (maxPath > 0 && path.distPct > maxPath) {
      const nonBullOnly = opts.vpBuyBreakoutMaxPathNonBullOnly === true;
      if (!nonBullOnly) return null;
      const prior60 = priorTrendMovePct(candles, idx, Number(opts.vpBuyVacuumPriorLookback ?? 96 * 60));
      const bullThresh = Number(opts.vpBuyVacuumBullPriorPct ?? 0.05);
      if (!(prior60 > bullThresh)) return null;
    }
    const score = path.distPct >= 0.012 ? 13 : 12;
    return { setup: "vah_breakout", score, tier: "A", meta: { vah, volR, target: path.targetPrice, levelSrc } };
  }
  if (volR < breakdownVolR) return null;
  if (prev.close < val) return null;
  if (prev.close > vah * 1.002) return null;
  if (bar.close >= val * (1 - minBeyond)) return null;
  if (directionalBody(bar, "SELL") < minBody) return null;
  if (closeStrength(bar) > 1 - minCloseStrength) return null;
  const path = pathToNextHvn(price, "SELL", vp);
  if (!path || path.distPct < minPath) return null;
  // Optional abstention: vacuum VAL (large path to next HVN) can be unprepared
  // in squeeze/early-bear regimes even when prior60d is deep bear.
  const maxPath = Number(opts.vpSellBreakdownMaxPathPct ?? 0);
  if (maxPath > 0 && path.distPct > maxPath) return null;
  const score = path.distPct >= 0.012 ? 13 : 12;
  return { setup: "val_breakdown", score, tier: "A", meta: { val, volR, target: path.targetPrice, levelSrc } };
}

function detectHvnFlip(candles, idx, side, vp, opts) {
  const bar = candles[idx];
  const price = bar.close;
  const tol = Number(opts.nearTolPct ?? 0.0015);
  const retestTol = Number(opts.vpRetestTolPct ?? 0.002);
  const nodes = topHvnNodes(vp, 3);

  for (const node of nodes) {
    const h = node.price;
    if (side === "SELL") {
      let wasAbove = false;
      for (let j = Math.max(0, idx - 12); j < idx - 1; j++) {
        if (candles[j].close > h * (1 + tol * 2)) {
          wasAbove = true;
          break;
        }
      }
      if (!wasAbove) continue;
      const retest = bar.high >= h * (1 - retestTol) && bar.high <= h * (1 + retestTol);
      if (!retest || price >= h) continue;
      if (bar.close > bar.open) continue;
      if (upperWickRatio(bar) < 0.28) continue;
      return { setup: "hvn_flip", score: 9, tier: "B", meta: { hvn: h } };
    }
    let wasBelow = false;
    for (let j = Math.max(0, idx - 12); j < idx - 1; j++) {
      if (candles[j].close < h * (1 - tol * 2)) {
        wasBelow = true;
        break;
      }
    }
    if (!wasBelow) continue;
    const retest = bar.low <= h * (1 + retestTol) && bar.low >= h * (1 - retestTol);
    if (!retest || price <= h) continue;
    if (bar.close < bar.open) continue;
    if (lowerWickRatio(bar) < 0.28) continue;
    return { setup: "hvn_flip", score: 9, tier: "B", meta: { hvn: h } };
  }
  return null;
}

function detectVaRejection(candles, idx, side, vp, opts) {
  const bar = candles[idx];
  const minVolR = Number(opts.vpRejectionMinVolRatio ?? 1.2);
  const volR = volRatio(candles, idx);
  if (volR < minVolR) return null;
  const spikeTol = Number(opts.vpRejectionSpikePct ?? 0.004);
  // Real rejection: wick dominance + (optional) close deep into VA.
  const minWick = Number(opts.vpRejectionMinWickRatio ?? 0);
  const minDepth = Number(opts.vpRejectionMinCloseDepth ?? 0);
  // When true, close-depth only applies in extended markets (SELL after drop / BUY after rally)
  // — that is the 2022 bounce-short failure; enforcing depth in bull grind hurt 2023–24.
  const depthExtendedOnly = opts.vpRejectionDepthExtendedOnly === true;
  const prior20 = priorTrendMovePct(candles, idx, Number(opts.vpRejectionPriorLookback ?? 96 * 20));
  const extThresh = Number(opts.vpRejectionExtendedPriorPct ?? 0.05);

  if (side === "SELL") {
    if (opts.vpRejectionSellBlockExtendedDown === true && prior20 <= -extThresh) return null;
    if (bar.high < vp.vah * (1 + spikeTol)) return null;
    if (bar.close >= vp.vah) return null;
    if (bar.close <= vp.poc) return null;
    if (minWick > 0 && upperWickRatio(bar) < minWick) return null;
    const needDepth = minDepth > 0 && (!depthExtendedOnly || prior20 <= -extThresh);
    if (needDepth) {
      const span = vp.vah - vp.poc;
      if (!(span > 0) || (vp.vah - bar.close) / span < minDepth) return null;
    }
    return { setup: "va_rejection", score: 9, tier: "B", meta: { vah: vp.vah } };
  }
  if (bar.low > vp.val * (1 - spikeTol)) return null;
  if (bar.close <= vp.val) return null;
  if (bar.close >= vp.poc) return null;
  if (minWick > 0 && lowerWickRatio(bar) < minWick) return null;
  // BUY rejection needs a real reclaim body (not wick-only spike).
  // Signal-bar autopsy uses |close-open|/range — match that (not signed body),
  // so we don't over-cut red-wick reclaims that still paid on lock years.
  const minBody = Number(opts.vpBuyRejectionMinBody ?? 0);
  if (minBody > 0) {
    const r = barRange(bar);
    const body = Math.abs(bar.close - bar.open) / r;
    if (body < minBody) return null;
  }
  const minCloseStr = Number(opts.vpBuyRejectionMinCloseStrength ?? 0);
  if (minCloseStr > 0 && closeStrength(bar) < minCloseStr) return null;
  const needDepth = minDepth > 0 && (!depthExtendedOnly || prior20 >= extThresh);
  if (needDepth) {
    const span = vp.poc - vp.val;
    if (!(span > 0) || (bar.close - vp.val) / span < minDepth) return null;
  }
  return { setup: "va_rejection", score: 9, tier: "B", meta: { val: vp.val } };
}

/**
 * Naked POC — prior session POC not yet traded in the developing session.
 * Mean-reversion magnet: reject at first touch toward developing POC / VA.
 */
function detectNakedPoc(candles, idx, side, vp, opts) {
  if (opts.vpEnableNakedPoc === false) return null;
  const level = Number(vp?.nakedPoc);
  if (!(level > 0) || vp.nakedPocActive !== true) return null;

  const bar = candles[idx];
  const tol = Number(opts.nearTolPct ?? 0.0015);
  const minWick = Number(opts.vpMinWickRatio ?? 0.32);
  const minVolR = Number(opts.vpNakedPocMinVolRatio ?? 1.05);
  const volR = volRatio(candles, idx);
  if (volR < minVolR) return null;

  const touched =
    nearLevel(bar.low, level, tol) || nearLevel(bar.high, level, tol) || nearLevel(bar.close, level, tol);
  if (!touched) return null;

  // Direction: buy if price is below magnet and rejects higher; sell if above and rejects lower.
  if (side === "BUY") {
    if (bar.close >= level) return null;
    if (lowerWickRatio(bar) < minWick && directionalBody(bar, "BUY") < 0.35) return null;
    if (bar.close < bar.open && lowerWickRatio(bar) < minWick) return null;
    return { setup: "naked_poc", score: 11, tier: "B", meta: { level, prior: vp.priorSession } };
  }
  if (bar.close <= level) return null;
  if (upperWickRatio(bar) < minWick && directionalBody(bar, "SELL") < 0.35) return null;
  if (bar.close > bar.open && upperWickRatio(bar) < minWick) return null;
  return { setup: "naked_poc", score: 11, tier: "B", meta: { level, prior: vp.priorSession } };
}

export function detectVolumeProfileSetup(candles, idx, side, vp, opts = {}) {
  if (!vp || idx < 8) return null;

  const allowHvnFlip = opts.vpAllowHvnFlip === true;
  const detectors = [
    () => detectLvnVacuum(candles, idx, side, vp, opts),
    () => detectVaBreakout(candles, idx, side, vp, opts),
    () => detectNakedPoc(candles, idx, side, vp, opts),
    () => detectVaRejection(candles, idx, side, vp, opts),
    () => detectPocBounce(candles, idx, side, vp, opts),
  ];
  if (allowHvnFlip) detectors.push(() => detectHvnFlip(candles, idx, side, vp, opts));

  for (const fn of detectors) {
    const hit = fn();
    if (!hit) continue;
    const allowed = opts.vpAllowedSetups;
    if (Array.isArray(allowed) && allowed.length && !allowed.includes(hit.setup)) continue;
    return hit;
  }
  return null;
}

/**
 * Evaluate VP structure. Strict = hard veto; soft = score penalties + rare hard blocks.
 */
export function applyVolumeProfileGates(candles, idx, side, vp, opts = {}) {
  const gateMode = resolveVolumeProfileGateMode(opts);
  if (gateMode === "off" || !vp) {
    return { allow: true, gateMode, penalty: 0, warnings: [] };
  }

  const bar = candles[idx];
  const price = bar.close;
  const tol = Number(opts.vpCeilingTolPct ?? 0.003);
  const minRR = Number(opts.vpMinRR ?? 1.5);
  const minRun = Number(opts.vpMinRunPct ?? 0.004);
  const softBlockPenalty = Number(opts.vpSoftBlockPenalty ?? 10);

  let penalty = 0;
  const warnings = [];
  let vetoId;

  const addWarning = (id) => {
    warnings.push(id);
    penalty += VP_PENALTIES[id] ?? 2;
    if (!vetoId) vetoId = id;
  };

  if (side === "BUY" && nearLevel(price, vp.vah, tol)) addWarning("vp_long_at_vah_ceiling");
  if (side === "SELL" && nearLevel(price, vp.val, tol)) addWarning("vp_short_at_val_floor");

  if (side === "BUY" && price < vp.poc * (1 - tol) && !nearLevel(price, vp.val, tol)) {
    addWarning("vp_long_below_poc_gravity");
  }
  if (side === "SELL" && price > vp.poc * (1 + tol) && !nearLevel(price, vp.vah, tol)) {
    addWarning("vp_short_above_poc_gravity");
  }

  const brackets = volumeProfileBrackets(price, side, vp, { minRR, ...opts });
  if (!brackets.rrOk) addWarning("vp_rr_too_low");

  const path = pathToNextHvn(price, side, vp);
  if (!path || path.distPct < minRun) addWarning("vp_no_room_to_run");

  const setup = detectVolumeProfileSetup(candles, idx, side, vp, opts);
  if (opts.requireVpSetup === true && !setup) {
    return { allow: false, gateMode, penalty, warnings, vetoId: "vp_no_setup", brackets, setup, path, hardBlock: true };
  }

  const hardBlockCeilingFloor =
    opts.vpHardBlockCeilingFloor === true &&
    (warnings.includes("vp_long_at_vah_ceiling") || warnings.includes("vp_short_at_val_floor"));

  const hardBlock =
    hardBlockCeilingFloor ||
    (gateMode === "soft" &&
      ((brackets.rr > 0 && brackets.rr < 0.5) || (penalty >= softBlockPenalty && !setup)));

  if (gateMode === "strict" && warnings.length > 0) {
    return { allow: false, gateMode, penalty, warnings, vetoId, brackets, setup, path, hardBlock: true };
  }

  if (gateMode === "soft" && hardBlock) {
    return { allow: false, gateMode, penalty, warnings, vetoId, brackets, setup, path, hardBlock: true };
  }

  return {
    allow: true,
    gateMode,
    penalty,
    warnings,
    vetoId: warnings[0],
    brackets,
    setup,
    path,
    hardBlock: false,
  };
}


/** True when `price` is within `maxPct` of POC/VAH/VAL (and optional HVN / naked POC). */
export function isPriceNearVpStructure(price, vp, maxPct, opts = {}) {
  if (!vp || !(Number(price) > 0) || !(Number(maxPct) > 0)) return false;
  const tol = Number(maxPct);
  const levels = [vp.poc, vp.vah, vp.val];
  if (Number(vp.nakedPoc) > 0) levels.push(vp.nakedPoc);
  for (const lv of levels) {
    if (nearLevel(price, lv, tol)) return true;
  }
  if (opts.vpProximityIncludeHvn !== false && Array.isArray(vp.hvn)) {
    for (const h of vp.hvn) {
      if (nearLevel(price, h.price, tol)) return true;
    }
  }
  return false;
}

export function volumeProfileBias(bar, vp, side, tolPct = 0.0025) {
  if (!vp) return { ok: false, tag: "no_vp" };
  if (side === "BUY") {
    if (nearLevel(bar.close, vp.val, tolPct) || nearLevel(bar.close, vp.poc, tolPct)) {
      return { ok: true, tag: "vp_support" };
    }
    if (bar.close > vp.poc && bar.close < vp.vah) return { ok: true, tag: "vp_value_long" };
  } else {
    if (nearLevel(bar.close, vp.vah, tolPct) || nearLevel(bar.close, vp.poc, tolPct)) {
      return { ok: true, tag: "vp_resist" };
    }
    if (bar.close < vp.poc && bar.close > vp.val) return { ok: true, tag: "vp_value_short" };
  }
  return { ok: false, tag: "vp_miss" };
}

export function scoreVolumeProfile(candles, idx, side, vp, opts = {}) {
  if (opts.volumeProfileEnabled === false) {
    return { score: 0, blocked: false, penalty: 0, gateMode: "off" };
  }

  const gateMode = resolveVolumeProfileGateMode(opts);
  const gates = applyVolumeProfileGates(candles, idx, side, vp, opts);

  if (gateMode === "strict" && !gates.allow) {
    return { score: 0, blocked: true, vetoId: gates.vetoId, penalty: gates.penalty, gateMode, warnings: gates.warnings };
  }
  if (gateMode === "soft" && gates.hardBlock) {
    return { score: 0, blocked: true, vetoId: gates.vetoId, penalty: gates.penalty, gateMode, warnings: gates.warnings };
  }

  let score = 0;
  const setup = gates.setup;
  if (setup) {
    score += setup.score;
  } else {
    const bias = volumeProfileBias(candles[idx], vp, side);
    if (bias.ok) score += 3;
  }

  if (gates.brackets?.rr >= 2.5) score += 4;
  else if (gates.brackets?.rr >= 1.5) score += 2;

  if (setup?.setup === "lvn_vacuum") score += 5;

  if (gateMode === "soft" && gates.penalty > 0) {
    score = Math.max(0, score - Math.min(8, gates.penalty));
  }

  return {
    score: Math.min(25, score),
    blocked: false,
    penalty: gates.penalty,
    gateMode,
    warnings: gates.warnings,
    setup: setup?.setup ?? null,
    brackets: gates.brackets,
    path: gates.path,
  };
}
