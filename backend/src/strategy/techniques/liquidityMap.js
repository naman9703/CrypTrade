/**
 * Rolling liquidity map scanner.
 *
 * This models the intraday liquidity traders mark manually: recent swing highs/lows
 * and equal high/low clusters. It is intentionally separate from the PDH/PDL
 * liquidity sweep module, which trades named session liquidity.
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function liquidityMapDayId(ts) {
  return Math.floor(Number(ts) / 86_400_000);
}

function sameDay(a, b) {
  return liquidityMapDayId(a) === liquidityMapDayId(b);
}

function bodyRatio(bar) {
  const range = Math.max(1e-9, num(bar.high) - num(bar.low));
  return Math.abs(num(bar.close) - num(bar.open)) / range;
}

function rejectionWick(bar, side) {
  const range = Math.max(1e-9, num(bar.high) - num(bar.low));
  if (side === "BUY") return (Math.min(num(bar.open), num(bar.close)) - num(bar.low)) / range;
  return (num(bar.high) - Math.max(num(bar.open), num(bar.close))) / range;
}

function avgVolume(candles, idx, lookback) {
  let sum = 0;
  let n = 0;
  for (let j = Math.max(0, idx - lookback); j < idx; j++) {
    const v = num(candles[j]?.volume);
    if (v > 0) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : 0;
}

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function positiveNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveLiquidityMapThresholds(opts = {}) {
  const normalize = opts.liqMapNormalizeThresholds !== false;
  const refAtrPct = positiveNumber(opts.refAtrPct, 0);
  const fixedSweepPct = Math.max(0, Number(opts.liqMapSweepPct ?? 0.0006));
  const fixedEqualTolPct = Math.max(0, Number(opts.liqMapEqualTolPct ?? 0.0008));

  if (!normalize || !(refAtrPct > 0)) {
    return {
      sweepPct: fixedSweepPct,
      equalTolPct: fixedEqualTolPct,
      scoreAtrPct: 0,
      normalized: false,
    };
  }

  const sweepAtrFrac = clamp(opts.liqMapSweepAtrFrac ?? 0.13, 0, 2);
  const equalTolAtrFrac = clamp(opts.liqMapEqualTolAtrFrac ?? 0.18, 0, 2);
  const sweepPct = Math.max(fixedSweepPct, sweepAtrFrac * refAtrPct);
  const equalTolPct = Math.max(fixedEqualTolPct, equalTolAtrFrac * refAtrPct);

  return {
    sweepPct,
    equalTolPct,
    scoreAtrPct: refAtrPct,
    normalized: true,
  };
}

function isPivotHigh(candles, p, left, right) {
  if (p < left || p + right >= candles.length) return false;
  const h = num(candles[p].high);
  if (!(h > 0)) return false;
  for (let j = p - left; j <= p + right; j++) {
    if (j !== p && num(candles[j]?.high) >= h) return false;
  }
  return true;
}

function isPivotLow(candles, p, left, right) {
  if (p < left || p + right >= candles.length) return false;
  const l = num(candles[p].low);
  if (!(l > 0)) return false;
  for (let j = p - left; j <= p + right; j++) {
    if (j !== p && num(candles[j]?.low) <= l) return false;
  }
  return true;
}

function addCluster(clusters, level, idx, side, tolPct) {
  if (!(level > 0)) return;
  for (const c of clusters) {
    if (Math.abs(c.level - level) / level <= tolPct) {
      c.level = (c.level * c.touches + level) / (c.touches + 1);
      c.touches += 1;
      c.firstIdx = Math.min(c.firstIdx, idx);
      c.lastIdx = Math.max(c.lastIdx, idx);
      return;
    }
  }
  clusters.push({ level, side, touches: 1, firstIdx: idx, lastIdx: idx });
}

/**
 * Build unresolved rolling intraday liquidity pools known at `idx`.
 *
 * @returns {Array<{side:'BUY'|'SELL', level:number, touches:number, firstIdx:number, lastIdx:number, type:string, score:number}>}
 */
export function buildRollingLiquidityPools(candles, idx, opts = {}) {
  const lookback = Math.max(8, Number(opts.liqMapLookbackBars ?? 36));
  const left = Math.max(1, Number(opts.liqMapSwingLeft ?? 2));
  const right = Math.max(1, Number(opts.liqMapSwingRight ?? 2));
  const { equalTolPct: tolPct, scoreAtrPct } = resolveLiquidityMapThresholds(opts);
  const scoreScale = scoreAtrPct > 0 ? scoreAtrPct : 0.001;
  const minTouches = Math.max(1, Number(opts.liqMapMinTouches ?? 1));
  const maxAge = Math.max(4, Number(opts.liqMapMaxAgeBars ?? lookback));
  const minIdx = Math.max(0, idx - lookback);
  const maxPivot = Math.max(minIdx, idx - right - 1);
  const refTs = candles[idx]?.ts;
  const highs = [];
  const lows = [];

  for (let p = minIdx; p <= maxPivot; p++) {
    if (!sameDay(candles[p]?.ts, refTs)) continue;
    if (isPivotHigh(candles, p, left, right)) addCluster(highs, num(candles[p].high), p, "SELL", tolPct);
    if (isPivotLow(candles, p, left, right)) addCluster(lows, num(candles[p].low), p, "BUY", tolPct);
  }

  const pools = [];
  for (const c of [...highs, ...lows]) {
    if (c.touches < minTouches) continue;
    const age = idx - c.lastIdx;
    if (age < right || age > maxAge) continue;
    const touchedAfter = candles.slice(c.lastIdx + 1, idx).some((b) => {
      if (!sameDay(b.ts, refTs)) return false;
      return c.side === "SELL" ? num(b.high) > c.level * (1 + tolPct) : num(b.low) < c.level * (1 - tolPct);
    });
    if (opts.liqMapRequireUnresolved !== false && touchedAfter) continue;
    const distance = Math.abs(num(candles[idx].close) - c.level) / Math.max(c.level, 1e-9);
    const score =
      c.touches * 3 +
      Math.min(6, age / 4) +
      Math.max(0, 6 - distance / scoreScale) +
      (c.touches >= 2 ? 4 : 0);
    pools.push({
      ...c,
      type: c.touches >= 2 ? (c.side === "SELL" ? "equal_high" : "equal_low") : c.side === "SELL" ? "swing_high" : "swing_low",
      score,
    });
  }

  pools.sort((a, b) => b.score - a.score);
  return pools.slice(0, Math.max(1, Number(opts.liqMapMaxPools ?? 8)));
}

function tfMs(tf) {
  const s = String(tf || "").trim().toLowerCase();
  if (s.endsWith("m")) return Math.max(1, Number(s.slice(0, -1)) || 1) * 60_000;
  if (s.endsWith("h")) return Math.max(1, Number(s.slice(0, -1)) || 1) * 3_600_000;
  if (s.endsWith("d")) return Math.max(1, Number(s.slice(0, -1)) || 1) * 86_400_000;
  return 3_600_000;
}

function aggregateCompletedTf(candles, idx, tf) {
  const step = tfMs(tf);
  const currentBucket = Math.floor(Number(candles[idx]?.ts) / step) * step;
  const out = [];
  let cur = null;
  for (let j = 0; j < idx; j++) {
    const c = candles[j];
    if (!c || Number(c.ts) >= currentBucket) continue;
    const bucket = Math.floor(Number(c.ts) / step) * step;
    if (!cur || cur.ts !== bucket) {
      if (cur) out.push(cur);
      cur = { ts: bucket, open: num(c.open), high: num(c.high), low: num(c.low), close: num(c.close) };
    } else {
      cur.high = Math.max(cur.high, num(c.high));
      cur.low = Math.min(cur.low, num(c.low));
      cur.close = num(c.close);
    }
  }
  if (cur) out.push(cur);
  return out;
}

function pushPool(pools, level, side, type, score, extra = {}) {
  const lvl = num(level);
  if (!(lvl > 0)) return;
  pools.push({
    side,
    level: lvl,
    touches: Math.max(1, Number(extra.touches ?? 1)),
    firstIdx: Number(extra.firstIdx ?? -1),
    lastIdx: Number(extra.lastIdx ?? -1),
    type,
    score: Number(score) || 0,
    ...extra,
  });
}

function linePrice(a, b, x) {
  if (!a || !b || b.pivotIdx === a.pivotIdx) return NaN;
  const slope = (b.price - a.price) / (b.pivotIdx - a.pivotIdx);
  return a.price + slope * (x - a.pivotIdx);
}

function addTrendlinePool(pools, pivots, side, tf, tolPct, currentX) {
  if (pivots.length < 3) return;
  const recent = pivots.slice(-5);
  const a = recent[0];
  const b = recent[recent.length - 1];
  const projected = linePrice(a, b, currentX);
  if (!(projected > 0)) return;
  let touches = 0;
  for (const p of recent) {
    const lp = linePrice(a, b, p.pivotIdx);
    if (lp > 0 && Math.abs(p.price - lp) / Math.max(lp, 1e-9) <= tolPct) touches++;
  }
  if (touches < 3) return;
  pushPool(
    pools,
    projected,
    side,
    side === "SELL" ? `${tf}_trendline_high` : `${tf}_trendline_low`,
    10 + touches * 3,
    { touches, tf, source: "htf_trendline", firstIdx: a.pivotIdx, lastIdx: b.pivotIdx },
  );
}

/**
 * HTF liquidity pools for the mechanical sweep setup.
 *
 * Includes previous daily/weekly highs/lows, 1H/4H swing highs/lows, HTF equal
 * highs/lows, and simple multi-touch HTF trendline liquidity. Only completed HTF
 * candles before `idx` are used, so the level is known before the 15m sweep bar.
 */
export function buildHtfLiquidityPools(candles, idx, pre = {}, opts = {}) {
  const pools = [];
  const { equalTolPct: tolPct, scoreAtrPct } = resolveLiquidityMapThresholds(opts);
  const scoreScale = scoreAtrPct > 0 ? scoreAtrPct : 0.001;
  const includeDailyWeekly = opts.liqMapUseDailyWeeklyPools !== false;

  if (includeDailyWeekly) {
    pushPool(pools, pre.prevDayHigh?.[idx], "SELL", "prev_day_high", 24, { source: "daily" });
    pushPool(pools, pre.prevDayLow?.[idx], "BUY", "prev_day_low", 24, { source: "daily" });
    pushPool(pools, pre.prevWeekHigh?.[idx], "SELL", "prev_week_high", 30, { source: "weekly" });
    pushPool(pools, pre.prevWeekLow?.[idx], "BUY", "prev_week_low", 30, { source: "weekly" });
  }

  const tfList = String(opts.liqMapHtfPoolTfs ?? "1h,4h")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const left = Math.max(1, Number(opts.liqMapHtfSwingLeft ?? 2));
  const right = Math.max(1, Number(opts.liqMapHtfSwingRight ?? 2));
  const lookback = Math.max(12, Number(opts.liqMapHtfLookbackBars ?? 72));
  const minEqualTouches = Math.max(2, Number(opts.liqMapHtfEqualMinTouches ?? 2));

  for (const tf of tfList) {
    const htf = aggregateCompletedTf(candles, idx, tf);
    if (htf.length < left + right + 4) continue;
    const start = Math.max(left, htf.length - lookback);
    const maxPivot = htf.length - right - 1;
    const highs = [];
    const lows = [];
    const highClusters = [];
    const lowClusters = [];

    for (let p = start; p <= maxPivot; p++) {
      if (isPivotHigh(htf, p, left, right)) {
        const price = num(htf[p].high);
        highs.push({ pivotIdx: p, price });
        addCluster(highClusters, price, p, "SELL", tolPct);
      }
      if (isPivotLow(htf, p, left, right)) {
        const price = num(htf[p].low);
        lows.push({ pivotIdx: p, price });
        addCluster(lowClusters, price, p, "BUY", tolPct);
      }
    }

    for (const c of [...highClusters, ...lowClusters]) {
      const touchedAfter = htf.slice(c.lastIdx + 1).some((b) =>
        c.side === "SELL" ? num(b.high) > c.level * (1 + tolPct) : num(b.low) < c.level * (1 - tolPct),
      );
      if (opts.liqMapRequireUnresolved !== false && touchedAfter) continue;
      const type =
        c.touches >= minEqualTouches
          ? c.side === "SELL"
            ? `${tf}_equal_high`
            : `${tf}_equal_low`
          : c.side === "SELL"
            ? `${tf}_swing_high`
            : `${tf}_swing_low`;
      const distance = Math.abs(num(candles[idx]?.close) - c.level) / Math.max(c.level, 1e-9);
      const score = c.touches * 5 + Math.max(0, 8 - distance / scoreScale) + (c.touches >= minEqualTouches ? 10 : 4);
      pushPool(pools, c.level, c.side, type, score, {
        touches: c.touches,
        tf,
        source: c.touches >= minEqualTouches ? "htf_equal" : "htf_swing",
        firstIdx: c.firstIdx,
        lastIdx: c.lastIdx,
      });
    }

    if (opts.liqMapUseTrendlinePools !== false) {
      addTrendlinePool(pools, highs, "SELL", tf, tolPct * 1.5, htf.length);
      addTrendlinePool(pools, lows, "BUY", tf, tolPct * 1.5, htf.length);
    }
  }

  pools.sort((a, b) => b.score - a.score);
  return pools.slice(0, Math.max(1, Number(opts.liqMapMaxPools ?? 12)));
}

/**
 * Detect a 15m sweep + close-back-inside of HTF liquidity known before `idx`.
 */
export function detectHtfLiquiditySweeps(candles, idx, pre = {}, opts = {}) {
  const bar = candles[idx];
  if (!bar) return [];
  const { sweepPct, scoreAtrPct } = resolveLiquidityMapThresholds(opts);
  const scoreScale = scoreAtrPct > 0 ? scoreAtrPct : 0.001;
  const minWick = Number(opts.liqMapMinWickRatio ?? 0);
  const minBody = Number(opts.liqMapMinBodyRatio ?? 0);
  const minRvol = Number(opts.liqMapMinRvol ?? 0);
  const volAvg = avgVolume(candles, idx, Number(opts.liqMapRvolLookback ?? 20));
  const rvol = volAvg > 0 ? (num(bar.volume) || 0) / volAvg : 1;
  if (minRvol > 0 && rvol < minRvol) return [];
  if (minBody > 0 && bodyRatio(bar) < minBody) return [];

  const out = [];
  for (const pool of buildHtfLiquidityPools(candles, idx, pre, opts)) {
    const side = pool.side;
    const swept =
      side === "SELL"
        ? num(bar.high) > pool.level * (1 + sweepPct) && num(bar.close) < pool.level
        : num(bar.low) < pool.level * (1 - sweepPct) && num(bar.close) > pool.level;
    if (!swept) continue;
    const wick = rejectionWick(bar, side);
    if (minWick > 0 && wick < minWick) continue;
    if (side === "BUY" && num(bar.close) <= num(bar.open) && opts.liqMapRequireDirectionalClose === true) continue;
    if (side === "SELL" && num(bar.close) >= num(bar.open) && opts.liqMapRequireDirectionalClose === true) continue;
    const extension =
      side === "SELL"
        ? (num(bar.high) - pool.level) / Math.max(pool.level, 1e-9)
        : (pool.level - num(bar.low)) / Math.max(pool.level, 1e-9);
    out.push({
      side,
      level: pool.level,
      poolType: pool.type,
      poolSource: pool.source,
      poolTf: pool.tf ?? null,
      touches: pool.touches,
      poolScore: pool.score,
      entry: num(bar.close),
      wickPrice: side === "SELL" ? num(bar.high) : num(bar.low),
      extension,
      wickRatio: wick,
      bodyRatio: bodyRatio(bar),
      rvol,
      score: pool.score + wick * 8 + Math.min(4, rvol) + Math.min(4, extension / scoreScale),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * Detect sweep + reclaim of rolling liquidity pools at bar `idx`.
 */
export function detectRollingLiquiditySweeps(candles, idx, opts = {}) {
  const bar = candles[idx];
  if (!bar) return [];
  const { sweepPct, scoreAtrPct } = resolveLiquidityMapThresholds(opts);
  const scoreScale = scoreAtrPct > 0 ? scoreAtrPct : 0.001;
  const minWick = Number(opts.liqMapMinWickRatio ?? 0);
  const minBody = Number(opts.liqMapMinBodyRatio ?? 0);
  const minRvol = Number(opts.liqMapMinRvol ?? 0);
  const volAvg = avgVolume(candles, idx, Number(opts.liqMapRvolLookback ?? 20));
  const rvol = volAvg > 0 ? (num(bar.volume) || 0) / volAvg : 1;
  if (minRvol > 0 && rvol < minRvol) return [];
  if (minBody > 0 && bodyRatio(bar) < minBody) return [];

  const out = [];
  for (const pool of buildRollingLiquidityPools(candles, idx, opts)) {
    const side = pool.side;
    const swept =
      side === "SELL"
        ? num(bar.high) > pool.level * (1 + sweepPct) && num(bar.close) < pool.level
        : num(bar.low) < pool.level * (1 - sweepPct) && num(bar.close) > pool.level;
    if (!swept) continue;
    const wick = rejectionWick(bar, side);
    if (minWick > 0 && wick < minWick) continue;
    if (side === "BUY" && num(bar.close) <= num(bar.open) && opts.liqMapRequireDirectionalClose === true) continue;
    if (side === "SELL" && num(bar.close) >= num(bar.open) && opts.liqMapRequireDirectionalClose === true) continue;
    const extension =
      side === "SELL"
        ? (num(bar.high) - pool.level) / Math.max(pool.level, 1e-9)
        : (pool.level - num(bar.low)) / Math.max(pool.level, 1e-9);
    out.push({
      side,
      level: pool.level,
      poolType: pool.type,
      touches: pool.touches,
      poolScore: pool.score,
      entry: num(bar.close),
      wickPrice: side === "SELL" ? num(bar.high) : num(bar.low),
      extension,
      wickRatio: wick,
      bodyRatio: bodyRatio(bar),
      rvol,
      score: pool.score + wick * 8 + Math.min(4, rvol) + Math.min(4, extension / scoreScale),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
