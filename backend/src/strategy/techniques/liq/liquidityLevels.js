/**
 * Ranked liquidity level registry for classical LIQ sweeps.
 */
import { resolveSessionExtremeLevel } from "../liquidity.js";
import { swingHighLow, isPivotHigh, isPivotLow } from "../fibonacci.js";
import { buildHtfLiquidityPools } from "../liquidityMap.js";

const TIER_WEIGHT = Object.freeze({
  prev_week_high: 1.35,
  prev_week_low: 1.35,
  pdh: 1.25,
  pdl: 1.25,
  asian_high: 1.15,
  asian_low: 1.15,
  session_high: 1.1,
  session_low: 1.1,
  swing_high: 1.0,
  swing_low: 1.0,
});

const DEFAULT_LEVELS = "daily";

export function parseLiqLevelModes(opts = {}) {
  const raw = String(opts.intradayLiqLevels ?? DEFAULT_LEVELS).toLowerCase();
  const parts = raw.split(/[,\s|]+/).map((s) => s.trim()).filter(Boolean);
  return new Set(parts.length ? parts : ["daily"]);
}

function pushCandidate(out, seen, candidate) {
  const key = `${candidate.levelType}:${candidate.level?.toFixed(8)}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push(candidate);
}

/**
 * @returns {Array<{ level: number, levelType: string, importance: number, opposingLevel: number, source: string, touches: number }>}
 */
export function resolveLiquidityCandidates(candles, idx, side, pre, opts = {}) {
  const modes = parseLiqLevelModes(opts);
  if (opts.intradayLiqSessionExtreme === true || opts.intradayLiqSessionExtreme === "true") {
    modes.add("session");
  }
  const pdh = Number(pre?.prevDayHigh?.[idx]);
  const pdl = Number(pre?.prevDayLow?.[idx]);
  const pwh = Number(pre?.prevWeekHigh?.[idx]);
  const pwl = Number(pre?.prevWeekLow?.[idx]);
  const asianH = Number(pre?.asianHigh?.[idx]);
  const asianL = Number(pre?.asianLow?.[idx]);

  const candidates = [];
  const seen = new Set();

  const defaultOpp = (lv) => {
    if (side === "BUY") return pdh > 0 ? pdh : lv * 1.02;
    return pdl > 0 ? pdl : lv * 0.98;
  };

  if (modes.has("daily")) {
    if (side === "BUY" && pdl > 0) {
      pushCandidate(candidates, seen, {
        level: pdl,
        levelType: "pdl",
        importance: TIER_WEIGHT.pdl,
        opposingLevel: pdh > 0 ? pdh : defaultOpp(pdl),
        source: "daily",
        touches: 1,
      });
    } else if (side === "SELL" && pdh > 0) {
      pushCandidate(candidates, seen, {
        level: pdh,
        levelType: "pdh",
        importance: TIER_WEIGHT.pdh,
        opposingLevel: pdl > 0 ? pdl : defaultOpp(pdh),
        source: "daily",
        touches: 1,
      });
    }
  }

  if (modes.has("weekly")) {
    if (side === "BUY" && pwl > 0) {
      pushCandidate(candidates, seen, {
        level: pwl,
        levelType: "prev_week_low",
        importance: TIER_WEIGHT.prev_week_low,
        opposingLevel: pwh > 0 ? pwh : defaultOpp(pwl),
        source: "weekly",
        touches: 1,
      });
    } else if (side === "SELL" && pwh > 0) {
      pushCandidate(candidates, seen, {
        level: pwh,
        levelType: "prev_week_high",
        importance: TIER_WEIGHT.prev_week_high,
        opposingLevel: pwl > 0 ? pwl : defaultOpp(pwh),
        source: "weekly",
        touches: 1,
      });
    }
  }

  if (modes.has("asian")) {
    if (side === "BUY" && asianL > 0) {
      pushCandidate(candidates, seen, {
        level: asianL,
        levelType: "asian_low",
        importance: TIER_WEIGHT.asian_low,
        opposingLevel: asianH > 0 ? asianH : defaultOpp(asianL),
        source: "asian",
        touches: 1,
      });
    } else if (side === "SELL" && asianH > 0) {
      pushCandidate(candidates, seen, {
        level: asianH,
        levelType: "asian_high",
        importance: TIER_WEIGHT.asian_high,
        opposingLevel: asianL > 0 ? asianL : defaultOpp(asianH),
        source: "asian",
        touches: 1,
      });
    }
  }

  if (modes.has("session") && (opts.intradayLiqSessionExtreme === true || opts.intradayLiqSessionExtreme === "true")) {
    const dayStart = idx >= 0 ? Math.max(0, idx - 96) : 0;
    const extreme = resolveSessionExtremeLevel(candles, idx, side, dayStart, opts);
    if (extreme?.level > 0) {
      const lt = extreme.levelType;
      pushCandidate(candidates, seen, {
        level: extreme.level,
        levelType: lt,
        importance: TIER_WEIGHT[lt] ?? 1.05,
        opposingLevel: defaultOpp(extreme.level),
        source: "session_cluster",
        touches: Number(opts.intradayLiqSessionExtremeMinTouches ?? 3),
      });
    }
  }

  if (modes.has("swing")) {
    const swing = swingHighLow(candles, idx, 48);
    if (swing) {
      const lv = side === "BUY" ? swing.low : swing.high;
      const lt = side === "BUY" ? "swing_low" : "swing_high";
      if (lv > 0) {
        pushCandidate(candidates, seen, {
          level: lv,
          levelType: lt,
          importance: TIER_WEIGHT[lt] ?? 1.0,
          opposingLevel: side === "BUY" ? swing.high : swing.low,
          source: "swing_48",
          touches: 1,
        });
      }
    }
  }

  // Guide-style fractal pivots: N bars lower/higher on each side (confirmed after `right` bars).
  if (modes.has("swing_pivot") || modes.has("pivot")) {
    const lookback = Math.max(1, Math.floor(Number(opts.intradayLiqSwingPivotLookback ?? 5)));
    const right = lookback;
    const left = lookback;
    const searchFrom = idx - right;
    const searchTo = Math.max(0, idx - 200);
    let found = null;
    for (let i = searchFrom; i >= searchTo; i--) {
      if (side === "BUY" && isPivotLow(candles, i, left, right)) {
        found = { level: Number(candles[i].low), levelType: "swing_low", pivotIdx: i };
        break;
      }
      if (side === "SELL" && isPivotHigh(candles, i, left, right)) {
        found = { level: Number(candles[i].high), levelType: "swing_high", pivotIdx: i };
        break;
      }
    }
    if (found?.level > 0) {
      // Opposing: most recent opposite pivot in the same lookback window.
      let opp = defaultOpp(found.level);
      for (let i = searchFrom; i >= searchTo; i--) {
        if (side === "BUY" && isPivotHigh(candles, i, left, right)) {
          opp = Number(candles[i].high);
          break;
        }
        if (side === "SELL" && isPivotLow(candles, i, left, right)) {
          opp = Number(candles[i].low);
          break;
        }
      }
      pushCandidate(candidates, seen, {
        level: found.level,
        levelType: found.levelType,
        importance: TIER_WEIGHT[found.levelType] ?? 1.0,
        opposingLevel: opp > 0 ? opp : defaultOpp(found.level),
        source: `swing_pivot_${lookback}`,
        touches: 1,
      });
    }
  }

  if (opts.intradayLiqUseHtfPools === true) {
    const pools = buildHtfLiquidityPools(candles, idx, pre, {
      liqMapHtfPoolTfs: opts.intradayLiqHtfPoolTfs ?? "1h,4h",
      liqMapHtfLookbackBars: opts.intradayLiqHtfLookbackBars ?? 72,
    });
    for (const p of pools) {
      if (p.side !== side) continue;
      const lt = String(p.type ?? p.poolType ?? "htf_pool");
      pushCandidate(candidates, seen, {
        level: Number(p.level),
        levelType: lt,
        importance: 1.2,
        opposingLevel: defaultOpp(Number(p.level)),
        source: String(p.source ?? "htf"),
        touches: Number(p.touches ?? 1),
      });
    }
  }

  candidates.sort((a, b) => b.importance - a.importance);
  return candidates;
}

export function levelImportanceScore(levelType) {
  const w = TIER_WEIGHT[String(levelType ?? "")];
  return Math.round(Math.min(10, Math.max(3, (w ?? 1) * 7)));
}
