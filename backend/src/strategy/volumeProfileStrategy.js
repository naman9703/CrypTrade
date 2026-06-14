/**
 * VOLUME_PROFILE — standalone strategy driven by VP structure (POC / VA / HVN / LVN).
 */

import { ema, adx as computeAdx, atr as computeAtr } from "./indicators.js";
import { dayStore } from "./adapterPersisted.js";
import {
  buildVolumeProfile,
  detectVolumeProfileSetup,
  applyVolumeProfileGates,
  resolveVolumeProfileGateMode,
  volumeProfileBrackets,
  pathToNextHvn,
  passesVpRegimeImmunity,
  VP_SETUP_TIERS,
} from "./techniques/volumeProfile.js";

const WARMUP = 120;
const DEFAULT_MAX_PER_DAY = 2;
const DEFAULT_MIN_BAR_GAP = 12;
const DEFAULT_MIN_SCORE = 10;

const DEFAULT_ALLOWED_SETUPS = ["lvn_vacuum", "vah_breakout", "val_breakdown", "poc_bounce", "va_rejection"];

function utcDayId(ts) {
  return Math.floor(ts / 86_400_000);
}

function utcHour(ts) {
  return Math.floor((ts % 86_400_000) / 3_600_000);
}

function aggregateToHourly(candles) {
  if (!candles.length) return [];
  const hourly = [];
  let cur = null;
  for (const c of candles) {
    const hourTs = Math.floor(c.ts / 3_600_000) * 3_600_000;
    if (!cur || cur.ts !== hourTs) {
      if (cur) hourly.push(cur);
      cur = { ts: hourTs, close: c.close };
    } else {
      cur.close = c.close;
    }
  }
  if (cur) hourly.push(cur);
  return hourly;
}

function hourIndexForBar(barTs, hourly) {
  const hourTs = Math.floor(barTs / 3_600_000) * 3_600_000;
  let lo = 0;
  let hi = hourly.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (hourly[mid].ts <= hourTs) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

export function precomputeVolumeProfile(candles) {
  const n = candles.length;
  const volumes = candles.map((c) => Number(c.volume) || 0);
  const adxSeries = computeAdx(candles, 14);
  const atrSeries = computeAtr(candles, 14);

  const hourly = aggregateToHourly(candles);
  const hCloses = hourly.map((c) => c.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);
  const htfUp = new Array(n).fill(false);
  const htfDown = new Array(n).fill(false);
  const htfSep = new Array(n).fill(0);

  const minSep = 0.0006;
  for (let i = 0; i < n; i++) {
    const hIdx = hourIndexForBar(candles[i].ts, hourly);
    if (hIdx >= 50) {
      const e21 = hEma21[hIdx];
      const e50 = hEma50[hIdx];
      if (Number.isFinite(e21) && Number.isFinite(e50) && e50 !== 0) {
        const sep = Math.abs(e21 - e50) / Math.abs(e50);
        htfSep[i] = sep;
        if (sep >= minSep) {
          htfUp[i] = e21 > e50;
          htfDown[i] = e21 < e50;
        }
      }
    }
  }

  return { volumes, adxSeries, atrSeries, htfUp, htfDown, htfSep };
}

function isTradeableBar(candles, idx, pre, opts = {}) {
  const adxVal = pre.adxSeries[idx];
  const atrVal = pre.atrSeries[idx];
  const bar = candles[idx];
  const minAdx = Number(opts.vpMinAdx ?? 22);
  if (!Number.isFinite(adxVal) || adxVal < minAdx) return false;
  if (!Number.isFinite(atrVal) || atrVal <= 0 || bar.close <= 0) return false;
  const atrPct = atrVal / bar.close;
  if (atrPct < 0.0012 || atrPct > 0.04) return false;
  const volSlice = pre.volumes.slice(Math.max(0, idx - 20), idx);
  const volAvg = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  if (volAvg > 0 && pre.volumes[idx] / volAvg < 0.85) return false;
  return true;
}

function htfAllows(side, pre, idx, opts) {
  if (opts.vpRequireHtfAlign === false) return true;
  const minSep = Number(opts.vpMinHtfSepPct ?? 0.0035);
  if (pre.htfSep[idx] < minSep) return false;
  if (side === "BUY") return pre.htfUp[idx];
  return pre.htfDown[idx];
}

function normalizeAllowedSetups(opts) {
  if (Array.isArray(opts.vpAllowedSetups) && opts.vpAllowedSetups.length) return opts.vpAllowedSetups;
  return DEFAULT_ALLOWED_SETUPS;
}

export function evaluateVolumeProfileBar(candles, idx, opts = {}, pre = null) {
  const lookback = Number(opts.vpLookbackBars ?? 384);
  if (idx < Math.max(WARMUP, lookback)) return null;

  const hour = utcHour(candles[idx].ts);
  const start = Number(opts.vpSessionStartHour ?? opts.sessionStartHour ?? 7);
  const end = Number(opts.vpSessionEndHour ?? opts.sessionEndHour ?? 22);
  if (hour < start || hour >= end) return null;

  const P = pre || precomputeVolumeProfile(candles);
  if (!isTradeableBar(candles, idx, P, opts)) return null;

  const vpOpts = {
    ...opts,
    vpAllowedSetups: normalizeAllowedSetups(opts),
    volumeProfileEnabled: true,
  };

  const vp = buildVolumeProfile(candles, idx, {
    lookback,
    bins: opts.vpBins ?? 50,
  });
  if (!vp) return null;

  const gateMode = resolveVolumeProfileGateMode(vpOpts);
  let best = null;

  for (const side of ["BUY", "SELL"]) {
    if (!htfAllows(side, P, idx, opts)) continue;

    const setup = detectVolumeProfileSetup(candles, idx, side, vp, vpOpts);
    if (!setup) continue;

    if (opts.vpTierAOnly === true && setup.tier !== "A" && VP_SETUP_TIERS[setup.setup] !== "A") continue;

    const pathPreview = pathToNextHvn(candles[idx].close, side, vp);
    if (!passesVpRegimeImmunity(candles, idx, side, setup.setup, vp, P, pathPreview, { ...vpOpts, ...opts })) {
      continue;
    }

    const gates = applyVolumeProfileGates(candles, idx, side, vp, vpOpts);
    if (gateMode === "strict" && !gates.allow) continue;
    if (gateMode === "soft" && gates.hardBlock) continue;

    const minRR = Number(opts.vpMinRR ?? 1.5);
    if (gates.brackets?.rr > 0 && gates.brackets.rr < minRR) continue;

    let score = setup.score;
    if (gates.brackets?.rr >= 2) score += 2;
    if (gates.penalty > 0) score = Math.max(0, score - Math.min(5, gates.penalty));

    const minScore = Number(opts.vpMinScore ?? DEFAULT_MIN_SCORE);
    if (score < minScore) continue;

    if (!best || score > best.score || (setup.tier === "A" && best.tier !== "A")) {
      best = {
        action: side,
        reason: `vp_${setup.setup}`,
        score,
        tier: setup.tier ?? VP_SETUP_TIERS[setup.setup] ?? "B",
        setup: setup.setup,
        vpSetup: setup.setup,
        brackets: gates.brackets,
        path: gates.path,
        warnings: gates.warnings,
        sizeMult:
          setup.setup === "lvn_vacuum" && opts.vpLvnSizeMult
            ? Number(opts.vpLvnSizeMult)
            : 1,
      };
    }
  }

  if (!best) return null;

  const brackets = best.brackets ?? volumeProfileBrackets(candles[idx].close, best.action, vp, vpOpts);
  return {
    ...best,
    vpBrackets:
      opts.intradayVpBrackets === true && brackets?.slPct > 0
        ? { slPct: brackets.slPct, tpPct: brackets.tpPct, rr: brackets.rr }
        : null,
  };
}

export function selectVolumeProfilePicks(candles, opts = {}) {
  const pre = precomputeVolumeProfile(candles);
  const maxPerDay = Number(opts.vpMaxTradesPerDay ?? opts.maxTradesPerDay ?? DEFAULT_MAX_PER_DAY);
  const minScore = Number(opts.vpMinScore ?? DEFAULT_MIN_SCORE);
  const minGap = Number(opts.vpMinBarGap ?? opts.minBarGap ?? DEFAULT_MIN_BAR_GAP);
  const lookback = Number(opts.vpLookbackBars ?? 384);
  const startIdx = Math.max(WARMUP, lookback);
  const tierAOnly = opts.vpTierAOnly === true;

  const candidates = [];
  for (let i = startIdx; i < candles.length; i++) {
    const sig = evaluateVolumeProfileBar(candles, i, opts, pre);
    if (!sig || sig.score < minScore) continue;
    if (tierAOnly && sig.tier !== "A") continue;
    candidates.push({ idx: i, day: utcDayId(candles[i].ts), score: sig.score, tier: sig.tier, sig });
  }

  const byDay = new Map();
  for (const c of candidates) {
    const list = byDay.get(c.day) || [];
    list.push(c);
    byDay.set(c.day, list);
  }

  const picked = new Set();
  for (const list of byDay.values()) {
    list.sort((a, b) => {
      if (a.tier === "A" && b.tier !== "A") return -1;
      if (b.tier === "A" && a.tier !== "A") return 1;
      return b.score - a.score;
    });
    const chosen = [];
    for (const c of list) {
      if (chosen.length >= maxPerDay) break;
      if (chosen.some((x) => Math.abs(x.idx - c.idx) < minGap)) continue;
      chosen.push(c);
      picked.add(c.idx);
    }
  }

  const series = new Array(candles.length).fill(null);
  for (const idx of picked) {
    const c = candidates.find((x) => x.idx === idx);
    if (c) series[idx] = c.sig;
  }

  return {
    series,
    pickedCount: picked.size,
    candidateCount: candidates.length,
  };
}

export function buildVolumeProfileOptsFromCfg(cfg = {}) {
  return {
    vpLookbackBars: cfg.vpLookbackBars,
    vpBins: cfg.vpBins,
    vpMinRR: cfg.vpMinRR,
    vpMinRunPct: cfg.vpMinRunPct,
    minLvnRunPct: cfg.minLvnRunPct ?? cfg.vpMinRunPct,
    vpMinScore: cfg.vpMinScore,
    vpMaxTradesPerDay: cfg.vpMaxTradesPerDay,
    vpMinBarGap: cfg.vpMinBarGap,
    vpSessionStartHour: cfg.vpSessionStartHour,
    vpSessionEndHour: cfg.vpSessionEndHour,
    vpRequireHtfAlign: cfg.vpRequireHtfAlign,
    vpMinAdx: cfg.vpMinAdx,
    vpMinHtfSepPct: cfg.vpMinHtfSepPct,
    vpMinCloseBeyondPct: cfg.vpMinCloseBeyondPct,
    vpMinBreakoutBody: cfg.vpMinBreakoutBody,
    vpMinBreakoutCloseStrength: cfg.vpMinBreakoutCloseStrength,
    vpRegimeImmunity: cfg.vpRegimeImmunity,
    vpMaxPriorTrendPct: cfg.vpMaxPriorTrendPct,
    vpPriorTrendLookback: cfg.vpPriorTrendLookback,
    vpBuyBreakoutMinHtfSep: cfg.vpBuyBreakoutMinHtfSep,
    vpBuyRelaxedMinHtfSep: cfg.vpBuyRelaxedMinHtfSep,
    vpBuyHighPathMinPct: cfg.vpBuyHighPathMinPct,
    vpSellBreakdownMinHtfSep: cfg.vpSellBreakdownMinHtfSep,
    vpHardBlockCeilingFloor: cfg.vpHardBlockCeilingFloor,
    vpTierAOnly: cfg.vpTierAOnly,
    vpAllowedSetups: cfg.vpAllowedSetups,
    vpAllowHvnFlip: cfg.vpAllowHvnFlip,
    requireVpSetup: cfg.requireVpSetup,
    volumeProfileSoftGates: cfg.volumeProfileSoftGates,
    volumeProfileGatesEnabled: cfg.volumeProfileGatesEnabled,
    volumeProfileGateMode: cfg.volumeProfileGateMode,
    intradayVpBrackets: cfg.intradayVpBrackets ?? cfg.vpStructureBrackets,
    vpLvnSizeMult: cfg.vpLvnSizeMult ?? cfg.intradayLvnSizeMult,
    nearTolPct: cfg.vpNearTolPct,
    vpCeilingTolPct: cfg.vpCeilingTolPct,
    vpSoftBlockPenalty: cfg.vpSoftBlockPenalty,
    vpBreakoutMinVolRatio: cfg.vpBreakoutMinVolRatio,
    vpValBreakdownMinVolRatio: cfg.vpValBreakdownMinVolRatio,
    vpBreakoutMinPathPct: cfg.vpBreakoutMinPathPct,
    vpLvnMinVolRatio: cfg.vpLvnMinVolRatio,
    vpMinWickRatio: cfg.vpMinWickRatio,
    vpMaxSlPct: cfg.vpMaxSlPct,
    vpMaxTpPct: cfg.vpMaxTpPct,
  };
}

function minutesPerBar(tf) {
  return { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60 }[String(tf || "15m").toLowerCase()] ?? 15;
}

export function buildVolumeProfileBacktestAdapter(candles, opts = {}, tf = "15m") {
  const o = { ...buildVolumeProfileOptsFromCfg(opts), timeframe: tf };
  const { series } = selectVolumeProfilePicks(candles, o);
  const mpb = minutesPerBar(tf);
  const cooldownBars = Math.max(o.vpMinBarGap ?? DEFAULT_MIN_BAR_GAP, Math.ceil(60 / mpb));
  const maxPerDay = o.vpMaxTradesPerDay ?? DEFAULT_MAX_PER_DAY;

  let lastSignalIdx = -1;
  let tradesToday = 0;
  let curDay = null;
  const dayLocal = { lastSignalIdx: -1, tradesToday: 0, curDay: null };

  return function volumeProfileAdapter(bar, idx, ctx) {
    const dDay = dayStore(ctx, dayLocal);
    const day = utcDayId(bar.ts);
    if (day !== (ctx?.persisted ? dDay.curDay : curDay)) {
      if (ctx?.persisted) {
        dDay.curDay = day;
        dDay.tradesToday = 0;
      } else {
        curDay = day;
        tradesToday = 0;
      }
    }
    const tradesCount = ctx?.persisted ? dDay.tradesToday : tradesToday;
    if (tradesCount >= maxPerDay) return null;

    const sig = series[idx];
    if (!sig) return null;
    const lastIdx = ctx?.persisted ? dDay.lastSignalIdx : lastSignalIdx;
    if (lastIdx >= 0 && idx - lastIdx < cooldownBars) return null;

    if (ctx?.persisted) {
      dDay.lastSignalIdx = idx;
      dDay.tradesToday = tradesCount + 1;
    } else {
      lastSignalIdx = idx;
      tradesToday += 1;
    }
    const out = { action: sig.action, reason: sig.reason };
    if (sig.vpBrackets) out.vpBrackets = sig.vpBrackets;
    if (sig.sizeMult > 1) out.sizeMult = sig.sizeMult;
    if (sig.vpSetup) out.vpSetup = sig.vpSetup;
    return out;
  };
}

export function signal({ candles, timeframe } = {}) {
  if (!candles?.length) return { action: "HOLD", reason: "no_candles" };
  const pre = precomputeVolumeProfile(candles);
  const sig = evaluateVolumeProfileBar(candles, candles.length - 1, { timeframe }, pre);
  return sig || { action: "HOLD", reason: "no_vp_setup" };
}

export const VOLUME_PROFILE = {
  name: "Volume Profile — POC / VAH / VAL / HVN / LVN structure setups",
  signal,
  evaluateVolumeProfileBar,
  selectVolumeProfilePicks,
  buildVolumeProfileBacktestAdapter,
  buildVolumeProfileOptsFromCfg,
};
