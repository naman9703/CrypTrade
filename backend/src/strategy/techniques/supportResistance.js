/**
 * Institutional S/R — HTF zones (daily / weekly), bands not lines.
 */

/** @typedef {{ level: number, bandLow: number, bandHigh: number, tier: string, type: string, tag: string }} SrZone */

export function utcWeekId(ts) {
  return Math.floor(ts / (7 * 86_400_000));
}

/**
 * @param {number} level
 * @param {string} tier
 * @param {'support'|'resistance'} type
 * @param {string} tag
 * @param {number} widthPct — half-band as fraction of level (e.g. 0.002 = 0.2% each side)
 */
export function buildZone(level, tier, type, tag, widthPct = 0.002) {
  const lv = Number(level);
  if (!Number.isFinite(lv) || lv <= 0) return null;
  const w = Math.max(0.0001, Number(widthPct) || 0.002);
  return {
    level: lv,
    bandLow: lv * (1 - w),
    bandHigh: lv * (1 + w),
    tier,
    type,
    tag,
  };
}

/** @param {number} price @param {SrZone} zone */
export function priceInZone(price, zone) {
  if (!zone || !Number.isFinite(price)) return false;
  return price >= zone.bandLow && price <= zone.bandHigh;
}

/** @param {number} price @param {SrZone} zone @param {number} [atr] @param {object} opts */
export function zoneWidthPct(opts = {}, atr, price) {
  const pct = Number(opts.intradaySrZoneWidthPct ?? 0.002);
  const atrMult = Number(opts.intradaySrZoneWidthAtrMult ?? 0);
  if (atrMult > 0 && Number.isFinite(atr) && price > 0) {
    return Math.max(pct, (atrMult * atr) / price);
  }
  return pct;
}

/**
 * HTF support/resistance zones for a bar (priority: daily → weekly).
 * @param {object} pre
 * @param {number} idx
 * @param {'BUY'|'SELL'} side
 * @param {object} opts
 * @returns {SrZone[]}
 */
export function listHtfZones(pre, idx, side, opts = {}) {
  const i = idx;
  const atr = pre.atrSeries?.[i];
  const price = pre.prevDayHigh?.[i] > 0 ? pre.prevDayHigh[i] : 1;
  const w = zoneWidthPct(opts, atr, price);
  const zones = [];

  const pdh = pre.prevDayHigh?.[i];
  const pdl = pre.prevDayLow?.[i];
  const pwh = pre.prevWeekHigh?.[i];
  const pwl = pre.prevWeekLow?.[i];

  if (side === "BUY") {
    if (pdl > 0) {
      const z = buildZone(pdl, "daily", "support", "pdl", w);
      if (z) zones.push(z);
    }
    if (pwl > 0) {
      const z = buildZone(pwl, "weekly", "support", "pwl", w);
      if (z) zones.push(z);
    }
  } else {
    if (pdh > 0) {
      const z = buildZone(pdh, "daily", "resistance", "pdh", w);
      if (z) zones.push(z);
    }
    if (pwh > 0) {
      const z = buildZone(pwh, "weekly", "resistance", "pwh", w);
      if (z) zones.push(z);
    }
  }
  return zones;
}

/** @returns {SrZone | null} */
export function nearestHtfZone(pre, idx, side, opts = {}) {
  const zones = listHtfZones(pre, idx, side, opts);
  return zones[0] ?? null;
}

/**
 * Sweep interacted with HTF zone: wick pierced band and close reclaimed through setup level.
 * @param {'BUY'|'SELL'} side
 * @param {object} bar — reclaim bar
 * @param {object} pre
 * @param {number} idx
 * @param {object} setup — liquidity setup with level, wick, levelType
 * @param {object} opts
 */
export function passesHtfZoneAlignment(side, bar, pre, idx, setup, opts = {}) {
  const zones = listHtfZones(pre, idx, side, opts);
  if (!zones.length) return false;

  const level = Number(setup.level);
  const wick = Number(setup.wick);
  if (!Number.isFinite(level) || level <= 0) return false;

  const levelType = setup.levelType ?? "";
  const tierMatch =
    levelType === "pdl" || levelType === "pdh" || levelType === "pwl" || levelType === "pwh";

  for (const zone of zones) {
    const tagMatch =
      (levelType === "pdl" && zone.tag === "pdl") ||
      (levelType === "pdh" && zone.tag === "pdh") ||
      (levelType === "pwl" && zone.tag === "pwl") ||
      (levelType === "pwh" && zone.tag === "pwh");

    if (tierMatch && !tagMatch && zones.length > 1) continue;

    if (side === "BUY") {
      const wickInOrBelow = wick <= zone.bandHigh;
      const reclaimed = bar.close > level && bar.close > zone.bandLow;
      if (wickInOrBelow && reclaimed) return true;
    } else {
      const wickInOrAbove = wick >= zone.bandLow;
      const reclaimed = bar.close < level && bar.close < zone.bandHigh;
      if (wickInOrAbove && reclaimed) return true;
    }
  }

  if (!tierMatch) {
    const z = nearestHtfZone(pre, idx, side, opts);
    if (!z) return false;
    if (side === "BUY") {
      return wick <= z.bandHigh && bar.close > level;
    }
    return wick >= z.bandLow && bar.close < level;
  }
  return false;
}

/** @param {'BUY'|'SELL'} side @param {object} pre @param {number} idx @param {object} opts */
export function passesHtfTrend(side, pre, idx, opts = {}) {
  const minSep = Number(opts.intradaySrMinHtfSep ?? opts.intradayLiqMinHtfSep ?? 0);
  const sep = pre.htfSep?.[idx] ?? 0;
  if (minSep > 0 && sep < minSep) return false;
  if (side === "BUY") return pre.htfUp?.[idx] === true;
  if (side === "SELL") return pre.htfDown?.[idx] === true;
  return false;
}

/**
 * @param {object} pre
 * @param {number} idx
 * @param {object} opts
 */
export function passesVolumeExpansion(pre, idx, opts = {}) {
  const minR = Number(opts.intradaySrMinVolRatio ?? 1.2);
  if (minR <= 0) return true;
  const vol = pre.volumes?.[idx] ?? 0;
  const slice = pre.volumes?.slice(Math.max(0, idx - 20), idx) ?? [];
  const avg = slice.length ? slice.reduce((a, b) => a + b, 0) / slice.length : 0;
  if (avg <= 0) return true;
  return vol / avg >= minR;
}
