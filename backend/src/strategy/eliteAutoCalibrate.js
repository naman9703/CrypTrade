/**
 * SUPERTREND_ELITE — per-symbol auto-calibration (no per-coin hardcoding).
 *
 * Builds a coin profile from warmup bars only (no look-ahead), then derives
 * gate thresholds and optional ATR-based SL/TP brackets.
 */

import { ema, adx as computeAdx, atr as computeAtr } from "./indicators.js";

const DEFAULT_HTF1H_MIN_SEP = 0.0003;

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Panel-default tight brackets (0.2% SL / 1.5% TP). */
export const ELITE_TIGHT_SL_PCT = 0.002;
export const ELITE_TIGHT_TP_PCT = 0.015;

/**
 * Validation set only — sweep winners used to derive profile rules below.
 * Runtime tuning does NOT lookup by symbol or nearest-neighbor.
 */
export const ELITE_TUNING_REFERENCE = [
  { symbol: "BTCUSDT", atr: 0.00439, adx: 17.6, p40Adx: 16.8, vol: 0.895, p40EmaSep: 0.00211, sep: "PERCENTILE", stM: 3, bracket: "TIGHT" },
  { symbol: "ETHUSDT", atr: 0.00855, adx: 26.0, p40Adx: 23.8, vol: 0.921, p40EmaSep: 0.00901, sep: "FIXED", stM: 3.5, bracket: "TRAIL" },
  { symbol: "BNBUSDT", atr: 0.00457, adx: 27.0, p40Adx: 24.4, vol: 0.957, p40EmaSep: 0.00374, sep: "FIXED", stM: 3, bracket: "ATR" },
  { symbol: "SOLUSDT", atr: 0.01066, adx: 33.4, p40Adx: 31.1, vol: 0.941, p40EmaSep: 0.00345, sep: "ADX", stM: 3.5, bracket: "TIGHT" },
  { symbol: "XRPUSDT", atr: 0.0076, adx: 20.4, p40Adx: 18.2, vol: 0.918, p40EmaSep: 0.0082, sep: "ADX", stM: 3, bracket: "TIGHT" },
  { symbol: "DOGEUSDT", atr: 0.01089, adx: 18.0, p40Adx: 16.9, vol: 0.949, p40EmaSep: 0.00429, sep: "PERCENTILE", stM: 3.5, bracket: "ATR" },
  { symbol: "ADAUSDT", atr: 0.01064, adx: 24.4, p40Adx: 21.6, vol: 0.918, p40EmaSep: 0.00486, sep: "PERCENTILE", stM: 3.5, bracket: "TIGHT" },
  { symbol: "LINKUSDT", atr: 0.0101, adx: 21.8, p40Adx: 18.3, vol: 0.894, p40EmaSep: 0.0059, sep: "PERCENTILE", stM: 3.5, bracket: "ATR" },
  { symbol: "AVAXUSDT", atr: 0.01076, adx: 17.4, p40Adx: 15.2, vol: 0.946, p40EmaSep: 0.00805, sep: "PERCENTILE", stM: 3, bracket: "TIGHT" },
  { symbol: "DOTUSDT", atr: 0.00928, adx: 23.0, p40Adx: 20.8, vol: 0.97, p40EmaSep: 0.0076, sep: "FIXED", stM: 3, bracket: "ATR" },
  { symbol: "LTCUSDT", atr: 0.00786, adx: 15.3, p40Adx: 14.0, vol: 0.907, p40EmaSep: 0.00644, sep: "PERCENTILE", stM: 3.5, bracket: "ATR" },
  { symbol: "TRXUSDT", atr: 0.00395, adx: 32.1, p40Adx: 28.9, vol: 0.984, p40EmaSep: 0.00238, sep: "FIXED", stM: 3, bracket: "TRAIL" },
  { symbol: "INJUSDT", atr: 0.01745, adx: 25.9, p40Adx: 21.2, vol: 0.943, p40EmaSep: 0.01362, sep: "PERCENTILE", stM: 3.5, bracket: "TIGHT" },
  { symbol: "TIAUSDT", atr: 0.01224, adx: 20.0, p40Adx: 18.7, vol: 0.977, p40EmaSep: 0.0084, sep: "PERCENTILE", stM: 3, bracket: "TIGHT" },
];

function profileFeatures(profile, opts = {}) {
  const o = { ...ELITE_AUTO_DEFAULTS, ...opts };
  return {
    atr: Number(profile?.medianAtrPct ?? o.referenceAtrPct),
    adx: Number(profile?.medianAdx ?? 22),
    p40Adx: Number(profile?.p40Adx ?? profile?.medianAdx ?? 22),
    vol: Number(profile?.medianVolRatio ?? 1.2),
    sep: Number(profile?.p40H1EmaSep ?? profile?.medianH1EmaSep ?? o.referenceEmaSep),
  };
}

export const ELITE_AUTO_DEFAULTS = {
  profileBars: 90,
  minAdxFloor: 15,
  minAdxCeil: 30,
  minVolFloor: 1.0,
  minVolCeil: 2.5,
  minAtrExpansionFloor: 1.05,
  minAtrExpansionCeil: 1.35,
  slAtrMult: 1.65,
  tpAtrMult: 3.4,
  slPctCeil: 0.014,
  tpPctCeil: 0.035,
  slPctFloor: 0.004,
  tpPctFloor: 0.009,
  /** Cap TRAIL disaster SL below isolated liq distance (fraction of liq move). */
  disasterSlLiqBuffer: 0.85,
  referenceAtrPct: 0.006,
  referenceEmaSep: 0.004,
  stMultiplierLo: 3,
  stMultiplierHi: 3.5,
};

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function median(arr) {
  const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(arr, pct) {
  const s = [...arr].filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const idx = Math.floor(s.length * (clamp(pct, 1, 99) / 100));
  return s[Math.min(Math.max(0, idx), s.length - 1)];
}

function aggregateToHtf(candles, bucketMs) {
  if (!candles.length) return [];
  const out = [];
  let cur = null;
  for (const c of candles) {
    const bts = Math.floor(c.ts / bucketMs) * bucketMs;
    if (!cur || cur.ts !== bts) {
      if (cur) out.push(cur);
      cur = { ts: bts, open: c.open, high: c.high, low: c.low, close: c.close, volume: Number(c.volume) || 0 };
    } else {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += Number(c.volume) || 0;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Coin profile from the first `profileBars` primary-TF bars (warmup only).
 * @param {object[]} candles
 * @param {object} [opts]
 */
export function buildEliteCoinProfile(candles, opts = {}) {
  const o = { ...ELITE_AUTO_DEFAULTS, ...opts };
  const profileBars = Math.max(40, Math.round(Number(o.profileBars ?? 90)));
  const end = Math.min(candles.length, profileBars);
  if (end < 30) {
    return {
      profileBars: end,
      medianAtrPct: o.referenceAtrPct,
      medianAdx: 22,
      p40Adx: 20,
      medianVolRatio: 1.2,
      medianH1EmaSep: DEFAULT_HTF1H_MIN_SEP,
      p40H1EmaSep: DEFAULT_HTF1H_MIN_SEP,
    };
  }

  const slice = candles.slice(0, end);
  const atrSeries = computeAtr(slice, 14);
  const adxSeries = computeAdx(slice, 14);
  const volumes = slice.map((c) => Number(c.volume) || 0);
  const volEma20 = ema(volumes, 20);

  const atrPcts = [];
  const adxVals = [];
  const volRatios = [];
  for (let i = 14; i < slice.length; i++) {
    const c = slice[i];
    const a = atrSeries[i];
    if (c.close > 0 && Number.isFinite(a)) atrPcts.push(a / c.close);
    const adx = adxSeries[i];
    if (Number.isFinite(adx) && adx > 0) adxVals.push(adx);
    const ve = volEma20[i];
    if (ve > 0) volRatios.push(volumes[i] / ve);
  }

  const htf1h = aggregateToHtf(slice, ONE_HOUR_MS);
  const h1Closes = htf1h.map((c) => c.close);
  const h1Ema21 = ema(h1Closes, 21);
  const h1Ema50 = ema(h1Closes, 50);
  const h1Seps = [];
  for (let i = 50; i < h1Ema21.length; i++) {
    const e50 = h1Ema50[i] ?? 0;
    if (e50 > 0) {
      const sep = Math.abs(h1Ema21[i] - e50) / e50;
      if (sep > 0) h1Seps.push(sep);
    }
  }

  return {
    profileBars: end,
    medianAtrPct: median(atrPcts) ?? o.referenceAtrPct,
    medianAdx: median(adxVals) ?? 22,
    p40Adx: percentile(adxVals, 40) ?? 20,
    medianVolRatio: median(volRatios) ?? 1.2,
    medianH1EmaSep: median(h1Seps) ?? DEFAULT_HTF1H_MIN_SEP,
    p40H1EmaSep: percentile(h1Seps, 40) ?? DEFAULT_HTF1H_MIN_SEP,
  };
}

/** Resolved Gate 1 min ADX from coin profile. */
export function resolveEliteMinAdx(profile, opts = {}) {
  const o = { ...ELITE_AUTO_DEFAULTS, ...opts };
  const base = Number(profile?.p40Adx ?? profile?.medianAdx ?? 20);
  return clamp(base * 0.85, o.minAdxFloor, o.minAdxCeil);
}

/** Resolved Gate 2 min volume vs avg from coin profile. */
export function resolveEliteMinVolume(profile, opts = {}) {
  const o = { ...ELITE_AUTO_DEFAULTS, ...opts };
  const med = Number(profile?.medianVolRatio ?? 1.2);
  return clamp(med * 1.2, o.minVolFloor, o.minVolCeil);
}

/** Resolved Gate 5 min ATR expansion multiplier from coin profile. */
export function resolveEliteMinAtrExpansion(profile, opts = {}) {
  const o = { ...ELITE_AUTO_DEFAULTS, ...opts };
  const ref = o.referenceAtrPct;
  const med = Number(profile?.medianAtrPct ?? ref);
  const volScale = med / ref;
  const raw = 1.15 + (volScale > 1.2 ? 0.05 : volScale < 0.8 ? -0.05 : 0);
  return clamp(raw, o.minAtrExpansionFloor, o.minAtrExpansionCeil);
}

/** Score ADX vs PERCENTILE sep — diagnostic only; sep mode comes from resolveEliteSepMode rules. */
export function scoreEliteSepModes(profile, opts = {}) {
  const o = { ...ELITE_AUTO_DEFAULTS, ...opts };
  const atr = Number(profile?.medianAtrPct ?? o.referenceAtrPct);
  const adx = Number(profile?.medianAdx ?? 22);
  const p40Adx = Number(profile?.p40Adx ?? adx);
  const vol = Number(profile?.medianVolRatio ?? 1.2);
  const sep = Number(profile?.p40H1EmaSep ?? profile?.medianH1EmaSep ?? o.referenceEmaSep);
  const ref = o.referenceAtrPct;

  let adxScore = 0;
  let pctScore = 0;

  if (adx >= 20 && adx <= 33 && sep < 0.006 && vol >= 0.92) adxScore += 50;
  if (p40Adx >= 20 && p40Adx <= 28 && atr < 0.008) adxScore += 30;
  if (sep < 0.004) adxScore += 20;
  if (atr < ref * 0.85) adxScore += 15;
  if (adx >= 35 && p40Adx >= 28) adxScore += 40;
  if (vol > 0.96 && adx >= 20 && adx <= 26 && p40Adx >= 18 && p40Adx <= 22) adxScore += 50;
  if (vol > 0.97 && adx >= 18.5 && adx <= 22) adxScore += 55;
  if (vol > 0.96 && p40Adx >= 18 && p40Adx <= 22 && sep < 0.01) adxScore += 70;

  if (adx < 20) pctScore += 35;
  if (atr > ref * 1.2) pctScore += 25;
  if (sep > 0.007) pctScore += 30;
  if (adx > 40) pctScore += 25;
  if (adx > 30 && sep < 0.004 && atr < 0.005) pctScore += 25;
  if (atr < 0.0045 && adx > 28 && sep < 0.003) pctScore += 65;
  if (atr > 0.009 && adx < 28) pctScore += 25;
  if (adx > 30 && atr > 0.009 && sep < 0.005) pctScore += 20;

  return { adxScore, pctScore };
}

/** Primary + 4H Supertrend multiplier from ATR / ADX / EMA-sep profile. */
export function resolveEliteStMultiplier(profile, opts = {}) {
  const o = { ...ELITE_AUTO_DEFAULTS, ...opts };
  const { atr, adx, sep } = profileFeatures(profile, opts);
  if (atr < 0.005 && adx >= 28) return o.stMultiplierLo;
  if (adx >= 31) return o.stMultiplierHi;
  if (sep > 0.0085 && atr < 0.009) return o.stMultiplierHi;
  if (atr >= 0.016) return o.stMultiplierHi;
  if (atr >= 0.012 && sep > 0.008 && adx <= 21) return o.stMultiplierLo;
  if (atr >= 0.0105 && adx < 17.5) return o.stMultiplierLo;
  if (atr >= 0.0095 && adx >= 17.5) return o.stMultiplierHi;
  if (adx < 16 && atr >= 0.007) return o.stMultiplierHi;
  return o.stMultiplierLo;
}

/**
 * Gate 3 sep mode from warmup profile (FIXED | ADX | PERCENTILE).
 * Rules derived from Jun 25–Jun 26 fixed-setup sweep — no symbol lookup.
 */
export function resolveEliteSepMode(profile, opts = {}) {
  const { atr, adx, sep, vol } = profileFeatures(profile, opts);
  if (atr < 0.0055 && adx >= 26 && sep < 0.0045) return "FIXED";
  if (sep > 0.0085 && atr >= 0.008 && atr <= 0.009) return "FIXED";
  if (sep > 0.007 && vol >= 0.965 && adx >= 22 && adx <= 24.5) return "FIXED";
  if (adx >= 31 && sep < 0.005) return "ADX";
  if (sep > 0.0075 && sep < 0.0083 && adx >= 18 && adx <= 21.5 && vol < 0.93) return "ADX";
  return "PERCENTILE";
}

/** ADX sep base scaled gently from warmup EMA separation (replaces per-coin FIXED). */
export function resolveEliteSepAdxBase(profile, opts = {}) {
  const o = { ...ELITE_AUTO_DEFAULTS, ...opts };
  const sep = Number(profile?.p40H1EmaSep ?? profile?.medianH1EmaSep ?? o.referenceEmaSep);
  const ref = o.referenceEmaSep;
  const base = DEFAULT_HTF1H_MIN_SEP + (sep - ref) * 0.12;
  return clamp(base, 0.0002, 0.0008);
}

/** Bracket style (TIGHT | ATR | TRAIL) from volatility / trend structure profile. */
export function resolveEliteBracketStyle(profile, opts = {}) {
  const { atr, adx, sep, vol } = profileFeatures(profile, opts);
  if (atr < 0.005 && adx >= 28) return "TRAIL";
  if (sep > 0.0085 && sep < 0.0095 && atr >= 0.008 && adx >= 24 && adx <= 28) return "TRAIL";
  if (sep >= 0.012 || atr >= 0.016) return "TIGHT";
  if (adx >= 31 && sep < 0.005) return "TIGHT";
  if (atr >= 0.01 && adx >= 22 && sep < 0.006) return "TIGHT";
  if (sep > 0.0078 && adx <= 21.5 && atr >= 0.0075) return "TIGHT";
  if (atr < 0.0055 && adx >= 24 && vol >= 0.93 && sep < 0.005) return "ATR";
  if (adx < 16 && atr < 0.009) return "ATR";
  if (sep >= 0.005 && sep <= 0.008 && atr >= 0.009 && adx >= 22) return "ATR";
  if (atr >= 0.0105 && adx <= 19 && sep < 0.0055) return "ATR";
  if (atr < 0.005 && adx < 20) return "TIGHT";
  return "ATR";
}

/** Map sweep bracket label to engine eliteStAutoBracketMode. */
export function eliteBracketStyleToMode(bracketStyle) {
  const b = String(bracketStyle ?? "ATR").toUpperCase();
  if (b === "TIGHT") return "FIXED";
  if (b === "TRAIL") return "OFF";
  return "ATR";
}

/** Apply bracket fields on cfg from resolved bracket style + profile. */
export function applyEliteBracketStyleToCfg(cfg, profile, bracketStyle) {
  const style = String(bracketStyle ?? "ATR").toUpperCase();
  const mode = eliteBracketStyleToMode(style);
  const out = { ...cfg, eliteStAutoBracketMode: mode };

  if (style === "TIGHT") {
    out.supertrendFuturesUseFixedSl = true;
    out.supertrendFuturesFixedSlPct = ELITE_TIGHT_SL_PCT;
    out.supertrendFuturesUseFixedTp = true;
    out.supertrendFuturesFixedTpPct = ELITE_TIGHT_TP_PCT;
  } else if (style === "ATR") {
    const { slPct, tpPct } = resolveEliteBracketPct(profile);
    out.supertrendFuturesUseFixedSl = true;
    out.supertrendFuturesFixedSlPct = slPct;
    out.supertrendFuturesUseFixedTp = true;
    out.supertrendFuturesFixedTpPct = tpPct;
  } else {
    const disasterSl = resolveEliteTrailDisasterSlPct(profile, { cfg: out });
    out.supertrendFuturesUseFixedSl = true;
    out.supertrendFuturesFixedSlPct = disasterSl;
    out.supertrendFuturesUseFixedTp = false;
    out.supertrendFuturesFixedTpPct = 0;
  }
  return out;
}

/**
 * Full dynamic tuning from coin profile — sep, ST multiplier, brackets.
 * Pure profile rules only (no per-symbol or nearest-neighbor lookup).
 */
export function resolveEliteDynamicTuning(profile, opts = {}) {
  const { adxScore, pctScore } = scoreEliteSepModes(profile, opts);
  const sepMode = resolveEliteSepMode(profile, opts);
  const stMultiplier = resolveEliteStMultiplier(profile, opts);
  const bracketStyle = resolveEliteBracketStyle(profile, opts);

  return {
    sepMode,
    stMultiplier,
    bracketStyle,
    htf4hMultiplier: stMultiplier,
    eliteStHtf1hSepAdxBase: resolveEliteSepAdxBase(profile, opts),
    eliteStHtf1hMinSep: DEFAULT_HTF1H_MIN_SEP,
    adxScore,
    pctScore,
    tuneSource: "profile_rules",
    profileFeatures: profileFeatures(profile, opts),
  };
}

/** ATR-scaled SL/TP pct from coin profile (intraday-adaptive pattern). */
export function resolveEliteBracketPct(profile, opts = {}) {
  const o = { ...ELITE_AUTO_DEFAULTS, ...opts };
  const m = Number(profile?.medianAtrPct ?? o.referenceAtrPct);
  const slPct = clamp(m * o.slAtrMult, o.slPctFloor, o.slPctCeil);
  const tpPct = clamp(m * o.tpAtrMult, o.tpPctFloor, o.tpPctCeil);
  return { slPct, tpPct, medianAtrPct: m };
}

function pickCfgLeverage(cfg = {}) {
  for (const v of [cfg.futuresLeverage, cfg.leverage]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return Math.max(1, Math.min(125, Math.floor(n)));
  }
  return 10;
}

/** Isolated futures liquidation distance as a fraction of entry (symmetric long/short). */
export function resolveEliteLiquidationDistPct(leverage, maintenanceMarginRate = 0.005) {
  const lev = Math.max(1, Number(leverage || 1));
  const mmr = Math.max(0, Number(maintenanceMarginRate));
  return Math.max(0.001, 1 / lev - mmr);
}

/**
 * TRAIL-mode disaster stop: ATR-scaled SL capped inside liquidation distance.
 * Prevents naked liq when Supertrend trail never arms (price never hits activation).
 */
export function resolveEliteTrailDisasterSlPct(profile, opts = {}) {
  const o = { ...ELITE_AUTO_DEFAULTS, ...opts };
  const cfg = opts.cfg && typeof opts.cfg === "object" ? opts.cfg : opts;
  const atrSl = resolveEliteBracketPct(profile, opts).slPct;
  const lev = pickCfgLeverage(cfg);
  const mmr = Number(opts.maintenanceMarginRate ?? 0.005);
  const liqBuf = Number(o.disasterSlLiqBuffer ?? 0.85);
  const maxSl = resolveEliteLiquidationDistPct(lev, mmr) * liqBuf;
  const ceiling = Math.min(o.slPctCeil, maxSl);
  const floor = Math.min(o.slPctFloor, ceiling);
  return clamp(atrSl, floor, ceiling);
}

/**
 * Patch engine opts with auto-calibrated gate thresholds.
 * @param {object} o merged ELITE_ST_DEFAULTS + opts
 * @param {object} profile from buildEliteCoinProfile
 */
export function applyAutoCalibrateToOpts(o, profile) {
  const autoOpts = {
    profileBars: o.profileBars ?? ELITE_AUTO_DEFAULTS.profileBars,
    minAdxFloor: o.minAdxFloor ?? o.eliteStAutoMinAdxFloor,
    minAdxCeil: o.minAdxCeil ?? o.eliteStAutoMinAdxCeil,
  };
  const out = { ...o, coinProfile: profile };
  if (Number(o.minAdx) > 0 || o._autoEnableAdxGate) {
    out.minAdx = resolveEliteMinAdx(profile, autoOpts);
  }
  if (Number(o.minVolumeVsAvg) > 0 || o._autoEnableVolGate) {
    out.minVolumeVsAvg = resolveEliteMinVolume(profile, autoOpts);
  }
  if (o.requireAtrExpansion !== false && (Number(o.minAtrExpansion) > 1 || o._autoEnableAtrGate)) {
    out.minAtrExpansion = resolveEliteMinAtrExpansion(profile, autoOpts);
    out.requireAtrExpansion = true;
  }
  return out;
}

/**
 * Apply auto-calibration to bot cfg when candles are available (backtest/live per symbol).
 * @param {Record<string, unknown>} cfg
 * @param {object[]} candles
 * @returns {Record<string, unknown>}
 */
export function applyEliteAutoCalibrateCfg(cfg = {}, candles = []) {
  if (cfg.eliteStAutoCalibrate !== true || !candles?.length) return { ...cfg };

  const profileBars = Math.max(
    40,
    Math.min(200, Math.round(Number(cfg.eliteStAutoProfileBars ?? ELITE_AUTO_DEFAULTS.profileBars))),
  );
  const profile = buildEliteCoinProfile(candles, { profileBars });
  const out = { ...cfg };

  const fullTune = out.eliteStAutoFullTune !== false;
  const userSepLocked =
    String(out.eliteStHtf1hSepMode ?? "").toUpperCase() &&
    out.eliteStHtf1hSepMode !== "FIXED" &&
    out._eliteUserSepLocked === true;

  let tuning = null;
  if (fullTune && !userSepLocked) {
    tuning = resolveEliteDynamicTuning(profile, {
      referenceAtrPct: ELITE_AUTO_DEFAULTS.referenceAtrPct,
      minAdxFloor: out.eliteStAutoMinAdxFloor,
      minAdxCeil: out.eliteStAutoMinAdxCeil,
    });
    out.eliteStHtf1hSepMode = tuning.sepMode;
    out.supertrendMultiplier = tuning.stMultiplier;
    out.eliteStHtf4hMultiplier = tuning.htf4hMultiplier;
    out.eliteStHtf1hSepAdxBase = tuning.eliteStHtf1hSepAdxBase;
    if (String(tuning.sepMode).toUpperCase() === "FIXED") {
      out.eliteStHtf1hMinSep = tuning.eliteStHtf1hMinSep ?? DEFAULT_HTF1H_MIN_SEP;
    }
    Object.assign(out, applyEliteBracketStyleToCfg(out, profile, tuning.bracketStyle));
    out._eliteDynamicTuning = tuning;
  } else {
    const sepMode = String(out.eliteStHtf1hSepMode ?? "").toUpperCase();
    if (!sepMode || sepMode === "FIXED") {
      out.eliteStHtf1hSepMode = "ADX";
    }
  }

  const gateAdxOn = Number(out.eliteStMinAdx) > 0;
  const gateVolOn = Number(out.eliteStMinVolumeVsAvg) > 0;
  const gateAtrOn = out.eliteStRequireAtrExpansion === true;

  if (gateAdxOn) {
    out.eliteStMinAdx = resolveEliteMinAdx(profile, {
      minAdxFloor: out.eliteStAutoMinAdxFloor,
      minAdxCeil: out.eliteStAutoMinAdxCeil,
    });
  }
  if (gateVolOn) {
    out.eliteStMinVolumeVsAvg = resolveEliteMinVolume(profile);
  }
  if (gateAtrOn) {
    out.eliteStMinAtrExpansion = resolveEliteMinAtrExpansion(profile);
  }

  if (!fullTune || userSepLocked) {
    const bracketMode = String(out.eliteStAutoBracketMode ?? "ATR").toUpperCase();
    if (bracketMode === "ATR") {
      const { slPct, tpPct } = resolveEliteBracketPct(profile);
      out.supertrendFuturesUseFixedSl = true;
      out.supertrendFuturesFixedSlPct = slPct;
      out.supertrendFuturesUseFixedTp = true;
      out.supertrendFuturesFixedTpPct = tpPct;
    } else if (bracketMode === "OFF") {
      const disasterSl = resolveEliteTrailDisasterSlPct(profile, { cfg: out });
      out.supertrendFuturesUseFixedSl = true;
      out.supertrendFuturesFixedSlPct = disasterSl;
      out.supertrendFuturesUseFixedTp = false;
      out.supertrendFuturesFixedTpPct = 0;
    }
  }

  out._eliteCoinProfile = profile;
  if (tuning) out._eliteDynamicTuning = tuning;
  return out;
}

/** Merge base cfg with per-symbol symbol + optional auto-calibrate from candles. */
export function eliteCfgForSymbol(baseCfg, symbol, candles) {
  let cfg = { ...baseCfg, symbol: String(symbol).toUpperCase() };
  if (cfg.eliteStAutoCalibrate === true && candles?.length) {
    cfg = applyEliteAutoCalibrateCfg(cfg, candles);
  }
  return cfg;
}
