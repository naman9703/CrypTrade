/**
 * Volume Profile — POC / VAH / VAL, HVN / LVN, five setup types, structure SL/TP.
 * Uses OHLCV histogram (volume distributed across each bar's high–low range).
 */

const DEFAULT_LOOKBACK = 192;
const DEFAULT_BINS = 50;
const VALUE_AREA_PCT = 0.7;
const HVN_TOP_PCT = 0.15;
const LVN_VALLEY_MULT = 0.55;

/** Tier A = high-move / breakout; Tier B = mean-reversion */
export const VP_SETUP_TIERS = {
  lvn_vacuum: "A",
  vah_breakout: "A",
  val_breakdown: "A",
  poc_bounce: "B",
  va_rejection: "B",
  hvn_flip: "B",
};

const VP_PENALTIES = {
  vp_long_at_vah_ceiling: 4,
  vp_short_at_val_floor: 4,
  vp_long_below_poc_gravity: 3,
  vp_short_above_poc_gravity: 3,
  vp_rr_too_low: 5,
  vp_no_room_to_run: 4,
};

function typicalPrice(bar) {
  return (bar.high + bar.low + bar.close) / 3;
}

function nearLevel(price, level, tolPct) {
  return level > 0 && Math.abs(price - level) / level <= tolPct;
}

/** @returns {"off"|"soft"|"strict"} */
export function resolveVolumeProfileGateMode(opts = {}) {
  if (opts.volumeProfileEnabled === false) return "off";
  if (opts.volumeProfileGateMode === "soft" || opts.volumeProfileGateMode === "strict") {
    return opts.volumeProfileGateMode;
  }
  if (opts.volumeProfileSoftGates === true) return "soft";
  if (opts.volumeProfileGatesEnabled === true) return "strict";
  return "off";
}

function buildHistogram(slice, bins) {
  const lo = Math.min(...slice.map((c) => c.low));
  const hi = Math.max(...slice.map((c) => c.high));
  if (!(hi > lo)) return null;

  const tick = (hi - lo) / bins;
  if (tick <= 0) return null;

  const hist = new Map();
  let totalVol = 0;
  for (const c of slice) {
    const vol = Number(c.volume) || 0;
    if (vol <= 0) continue;
    const barLo = c.low;
    const barHi = c.high;
    const steps = Math.max(1, Math.ceil((barHi - barLo) / tick));
    const volPerStep = vol / steps;
    for (let s = 0; s < steps; s++) {
      const p = barLo + ((s + 0.5) / steps) * (barHi - barLo);
      const bin = Math.round(p / tick) * tick;
      hist.set(bin, (hist.get(bin) || 0) + volPerStep);
    }
    totalVol += vol;
  }
  if (totalVol <= 0) return null;

  const nodes = [...hist.entries()]
    .map(([price, volume]) => ({ price, volume }))
    .sort((a, b) => a.price - b.price);

  return { nodes, totalVol, lo, hi, tick };
}

/**
 * Standard value area: expand from POC outward in price until 70% of volume is included.
 */
export function valueAreaFromNodes(nodes, totalVol, valueAreaPct = VALUE_AREA_PCT) {
  if (!nodes.length || totalVol <= 0) {
    return { poc: 0, vah: 0, val: 0 };
  }

  let pocNode = nodes[0];
  for (const n of nodes) {
    if (n.volume > pocNode.volume) pocNode = n;
  }
  const poc = pocNode.price;

  const byPrice = [...nodes].sort((a, b) => a.price - b.price);
  let pocIdx = byPrice.findIndex((n) => n.price === poc);
  if (pocIdx < 0) {
    pocIdx = byPrice.reduce((best, n, i) => (Math.abs(n.price - poc) < Math.abs(byPrice[best].price - poc) ? i : best), 0);
  }

  let lo = pocIdx;
  let hi = pocIdx;
  let acc = byPrice[pocIdx].volume;
  const target = totalVol * valueAreaPct;

  while (acc < target && (lo > 0 || hi < byPrice.length - 1)) {
    const volBelow = lo > 0 ? byPrice[lo - 1].volume : -1;
    const volAbove = hi < byPrice.length - 1 ? byPrice[hi + 1].volume : -1;
    if (volBelow >= volAbove && lo > 0) {
      lo -= 1;
      acc += byPrice[lo].volume;
    } else if (hi < byPrice.length - 1) {
      hi += 1;
      acc += byPrice[hi].volume;
    } else if (lo > 0) {
      lo -= 1;
      acc += byPrice[lo].volume;
    } else {
      break;
    }
  }

  return {
    poc,
    vah: byPrice[hi].price,
    val: byPrice[lo].price,
  };
}

/** Top-volume bins = HVN; local volume valleys = LVN (not flat 45% cutoff). */
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
    if (cur.volume < nodes[i - 1].volume && cur.volume < nodes[i + 1].volume && cur.volume < meanVol * LVN_VALLEY_MULT) {
      lvn.push(cur);
    }
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
    else {
      zones.push({ ...zone });
      zone = { low: sorted[i].price, high: sorted[i].price };
    }
  }
  zones.push(zone);
  return zones;
}

export function buildVolumeProfile(candles, endIdx, opts = {}) {
  const lookback = Number(opts.lookback ?? DEFAULT_LOOKBACK);
  const bins = Number(opts.bins ?? DEFAULT_BINS);
  const start = Math.max(0, endIdx - lookback + 1);
  const slice = candles.slice(start, endIdx + 1);
  if (slice.length < 24) return null;

  const hist = buildHistogram(slice, bins);
  if (!hist) return null;

  const { poc, vah, val } = valueAreaFromNodes(hist.nodes, hist.totalVol);
  const { hvn, lvn } = classifyNodes(hist.nodes);
  const lvnZones = mergeLvnZones(lvn, hist.tick);

  return {
    poc,
    vah,
    val,
    totalVol: hist.totalVol,
    nodes: hist.nodes,
    hvn,
    lvn,
    lvnZones,
    lookback,
    lo: hist.lo,
    hi: hist.hi,
  };
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
    const minSell = Number(opts.vpSellBreakdownMinHtfSep ?? minHtf);
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
  const level = side === "BUY" ? Math.min(vp.poc, vp.val) : Math.max(vp.poc, vp.vah);
  const touched = nearLevel(bar.low, level, tol) || nearLevel(bar.high, level, tol) || nearLevel(price, vp.poc, tol);
  if (!touched) return null;
  if (!wasOutsideValueArea(candles, idx, side, vp, 12)) return null;

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
  if (directionalBody(bar, side) < 0.4) return null;

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

  if (side === "BUY") {
    if (volR < breakoutVolR) return null;
    if (prev.close > vp.vah * (1 + minBeyond)) return null;
    if (bar.close <= vp.vah * (1 + minBeyond)) return null;
    if (directionalBody(bar, "BUY") < minBody) return null;
    if (closeStrength(bar) < minCloseStrength) return null;
    const path = pathToNextHvn(price, "BUY", vp);
    if (!path || path.distPct < minPath) return null;
    const score = path.distPct >= 0.012 ? 13 : 12;
    return { setup: "vah_breakout", score, tier: "A", meta: { vah: vp.vah, volR, target: path.targetPrice } };
  }
  if (volR < breakdownVolR) return null;
  if (prev.close < vp.val) return null;
  if (prev.close > vp.vah * 1.002) return null;
  if (bar.close >= vp.val * (1 - minBeyond)) return null;
  if (directionalBody(bar, "SELL") < minBody) return null;
  if (closeStrength(bar) > 1 - minCloseStrength) return null;
  const path = pathToNextHvn(price, "SELL", vp);
  if (!path || path.distPct < minPath) return null;
  const score = path.distPct >= 0.012 ? 13 : 12;
  return { setup: "val_breakdown", score, tier: "A", meta: { val: vp.val, volR, target: path.targetPrice } };
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

  if (side === "SELL") {
    if (bar.high < vp.vah * (1 + spikeTol)) return null;
    if (bar.close >= vp.vah) return null;
    if (bar.close <= vp.poc) return null;
    return { setup: "va_rejection", score: 9, tier: "B", meta: { vah: vp.vah } };
  }
  if (bar.low > vp.val * (1 - spikeTol)) return null;
  if (bar.close <= vp.val) return null;
  if (bar.close >= vp.poc) return null;
  return { setup: "va_rejection", score: 9, tier: "B", meta: { val: vp.val } };
}

export function detectVolumeProfileSetup(candles, idx, side, vp, opts = {}) {
  if (!vp || idx < 8) return null;

  const allowHvnFlip = opts.vpAllowHvnFlip === true;
  const detectors = [
    () => detectLvnVacuum(candles, idx, side, vp, opts),
    () => detectVaBreakout(candles, idx, side, vp, opts),
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

export function rollingVolumeProfile(candles, endIdx, lookback = DEFAULT_LOOKBACK, bins = DEFAULT_BINS) {
  return buildVolumeProfile(candles, endIdx, { lookback, bins });
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
