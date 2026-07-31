#!/usr/bin/env node
/**
 * Diagnose L1-L4 mandatory gate — same-bar vs sequential ICT formation.
 * Usage: FROM=2026-07-19 TO=2026-07-30 node scripts/research-mlcts-L1234-formation-audit.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = (process.env.SYMBOL || "BTCUSDT").toUpperCase();
const FROM = process.env.FROM || "2026-07-19";
const TO = process.env.TO || new Date().toISOString().slice(0, 10);
const fromMs = Date.parse(FROM);
const toMs = Math.min(Date.parse(TO) > fromMs ? Date.parse(TO) : Date.now(), Date.now());

const { fetchBinanceKlinesRange } = await import("../src/lib/binanceKlinesRest.js");
const {
  evaluateMlctsLayers,
  mandatoryLayersPass,
  sweepPoked,
  sweepReclaimedClose,
  MLCTS_WARMUP,
  MLCTS_DEFAULTS,
} = await import("../src/strategy/techniques/mlctsLayers.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { optsFromMlctsCfg, resolveMlctsCfg, mlctsPadFromMs } = await import("../src/strategy/mlctsIntraday.js");
const { fetchBinanceKlinesRows } = await import("../src/lib/binanceKlinesRest.js");

const padFrom = mlctsPadFromMs(fromMs, "15m");
const candles = await fetchBinanceKlinesRange({
  symbol: SYMBOL,
  interval: "15m",
  startTime: padFrom,
  endTime: toMs,
  feedKind: "BINANCE_FUTURES",
  chartPublic: true,
});
const pre = precomputeIntraday(candles);
const opts = optsFromMlctsCfg(resolveMlctsCfg({ symbol: SYMBOL }));

let weekly = null;
try {
  const rows = await fetchBinanceKlinesRows({ symbol: SYMBOL, interval: "1w", limit: 3, feedKind: "futures", chartPublic: true });
  const prev = rows?.[rows.length - 2];
  if (prev) weekly = { high: Number(prev.high), low: Number(prev.low), source: "binance_1w" };
} catch { /* ignore */ }

const stats = {
  analysisBars: 0,
  sameBar_strict_L1234_pass: 0,
  sameBar_L3_and_L4_pass: 0,
  sameBar_L3L4_fail_L1: 0,
  sameBar_L3L4_fail_L2: 0,
  sameBar_L3L4_fail_L1_and_L2: 0,
  hasDirection_bull_or_bear: 0,
  L1_fail_reasons: { range_bias: 0, adx_below_20: 0, score_below_50: 0 },
  L2_fail_when_L3_pass: 0,
  sequential_8bar: 0,
  sequential_32bar: 0,
  daily: {},
};

/** Relaxed L1: bias only (ICT context), no ADX/score gate */
function l1BiasOnly(ev) {
  const b = ev.layers.trend?.detail?.bias;
  return b === "BULL" || b === "BEAR";
}

/** Sequential formation within lookback bars ending at idx */
function sequentialFormation(idx, lookback) {
  const extras = { pre, weeklyLiquidity: weekly };
  let hadBias = false;
  let hadL2Near = false;
  let sweepBar = null;
  let bosBar = null;

  for (let j = Math.max(MLCTS_WARMUP, idx - lookback); j <= idx; j++) {
    const ev = evaluateMlctsLayers(candles, j, opts, extras);
    const L = ev.layers;
    if (l1BiasOnly(ev)) hadBias = true;
    if (L.liquidity?.pass || (L.liquidity?.score ?? 0) >= 40) hadL2Near = true;
    if (L.sweep?.pass && L.sweep?.detail?.swept && L.sweep?.detail?.reclaim) {
      sweepBar = j;
    }
    if (L.structure?.pass && L.structure?.detail?.bos) {
      bosBar = j;
    }
  }

  const evNow = evaluateMlctsLayers(candles, idx, opts, extras);
  const side = evNow.direction ?? (evNow.layers.trend?.detail?.bias === "BULL" ? "BUY" : evNow.layers.trend?.detail?.bias === "BEAR" ? "SELL" : null);
  if (!side) return false;

  const sweepOk = sweepBar != null;
  const bosOk = bosBar != null && sweepBar != null && bosBar >= sweepBar && bosBar <= idx;
  return hadBias && hadL2Near && sweepOk && bosOk;
}

for (let i = MLCTS_WARMUP; i < candles.length; i++) {
  const ts = candles[i].ts;
  if (ts < fromMs || ts >= toMs) continue;
  stats.analysisBars++;

  const day = new Date(ts).toISOString().slice(0, 10);
  if (!stats.daily[day]) {
    stats.daily[day] = { bars: 0, L3_sweep_events: 0, L4_bos_events: 0, strict_L1234: 0, seq32: 0 };
  }
  stats.daily[day].bars++;

  const ev = evaluateMlctsLayers(candles, i, opts, { pre, weeklyLiquidity: weekly });
  const L = ev.layers;

  if (ev.direction) stats.hasDirection_bull_or_bear++;

  if (mandatoryLayersPass(L, ev.direction)) {
    stats.sameBar_strict_L1234_pass++;
    stats.daily[day].strict_L1234++;
  }

  if (L.sweep?.pass && L.structure?.pass) {
    stats.sameBar_L3_and_L4_pass++;
    const l1fail = !L.trend?.pass;
    const l2fail = !L.liquidity?.pass;
    if (l1fail && l2fail) stats.sameBar_L3L4_fail_L1_and_L2++;
    else if (l1fail) stats.sameBar_L3L4_fail_L1++;
    else if (l2fail) stats.sameBar_L3L4_fail_L2++;
  }

  if (L.sweep?.pass && !L.liquidity?.pass) stats.L2_fail_when_L3_pass++;

  const bias = L.trend?.detail?.bias;
  const adx = L.trend?.detail?.adx ?? 0;
  if (bias === "RANGE") stats.L1_fail_reasons.range_bias++;
  else if (adx < 20) stats.L1_fail_reasons.adx_below_20++;
  else if ((L.trend?.score ?? 0) < 50) stats.L1_fail_reasons.score_below_50++;

  if (L.sweep?.detail?.swept && L.sweep?.detail?.reclaim) stats.daily[day].L3_sweep_events++;
  if (L.structure?.detail?.bos) stats.daily[day].L4_bos_events++;

  if (sequentialFormation(i, 8)) stats.sequential_8bar++;
  if (sequentialFormation(i, 32)) {
    stats.sequential_32bar++;
    stats.daily[day].seq32++;
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  window: { from: FROM, to: new Date(toMs).toISOString(), analysisBars: stats.analysisBars },
  finding:
    "ICT formation is sequential (trend → approach level → sweep bar → BOS bar). Current mandatory gate requires all 4 .pass on ONE 15m bar — that is NOT the same as the theory.",
  sameBarImplementation: {
    strict_L1234_all_pass: stats.sameBar_strict_L1234_pass,
    ratePct: +((100 * stats.sameBar_strict_L1234_pass) / stats.analysisBars).toFixed(2),
    L3_and_L4_pass_same_bar: stats.sameBar_L3_and_L4_pass,
    of_L3L4_blocked_by_L1: stats.sameBar_L3L4_fail_L1,
    of_L3L4_blocked_by_L2: stats.sameBar_L3L4_fail_L2,
    of_L3L4_blocked_by_both: stats.sameBar_L3L4_fail_L1_and_L2,
    L3_pass_but_L2_fail: stats.L2_fail_when_L3_pass,
  },
  sequentialImplementation: {
    within_8_bars_2h: stats.sequential_8bar,
    within_32_bars_8h: stats.sequential_32bar,
    ratePct_32bar: +((100 * stats.sequential_32bar) / stats.analysisBars).toFixed(2),
  },
  L1_gateBreakdown: stats.L1_fail_reasons,
  hasDirectionBars: stats.hasDirection_bull_or_bear,
  dailyBreakdown: stats.daily,
  passConditionsReminder: {
    L1_pass: "bias !== RANGE AND ADX >= 20 AND trend score >= 50",
    L2_pass: "price within ~3 ATR of nearest liquidity level AND score >= 50",
    L3_pass: "sweep poke + reclaim on L2 level SAME bar AND score >= 50",
    L4_pass: "BOS on SAME bar AND body >= 70% AND score >= 50",
  },
};

const outPath = path.join(__dirname, ".mlcts-L1234-formation-audit.json");
import fs from "fs";
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
