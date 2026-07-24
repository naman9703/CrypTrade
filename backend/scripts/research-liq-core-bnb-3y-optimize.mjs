#!/usr/bin/env node
/**
 * BNB-only LIQ_CORE: 3-year baseline + per-trade liquidity feature autopsy + enhance A/B.
 *
 * Philosophy: promote layers that lift PF/ret; reject N-only liquidity/context gates.
 *
 * Usage (backend/):
 *   SKIP_ENSURE=1 node scripts/research-liq-core-bnb-3y-optimize.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
/** Exact 3y window ending near today */
const FROM = process.env.FROM || "2023-07-01";
const TO = process.env.TO || "2026-07-01";
/** Holdout: last 12 months */
const HOLD_FROM = process.env.HOLD_FROM || "2025-07-01";
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const holdFromMs = Date.parse(HOLD_FROM);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const {
  buildIntradayBacktestAdapter,
  precomputeIntraday,
  buildIntradayOptsFromCfg,
} = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_CORE_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { listSessionLiquiditySetups } = await import("../src/strategy/techniques/liquidity.js");
const { isBreakdownDay, isBreakoutDay } = await import(
  "../src/strategy/techniques/liquidityTrendContinuation.js"
);
const { resolveSessionNarrative } = await import("../src/strategy/techniques/liq/marketState.js");

function findIdx(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
  const t = Number(ts);
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const ct = Number(candles[mid].ts);
    if (ct === t) return mid;
    if (ct < t) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function failClass(t) {
  const mfe = Number(t.mfePct ?? 0);
  const pnl = Number(t.netPnl ?? 0);
  if (pnl > 0) return "winner";
  if (mfe <= 0.001) return "never_green";
  if (mfe < 0.005) return "sl_no_follow";
  if (String(t.exitReason || "").includes("time_stop")) return "time_stop_gave_back";
  if (mfe >= 0.01) return "gave_back_after_mfe";
  return "other_loss";
}

function metrics(trades, lo, hi) {
  const s = (trades || [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= lo && Number(t.entryTs) < hi);
  let eq = 100;
  const curve = [{ ts: lo, equity: eq }];
  for (const t of s) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades: s, equityCurve: curve, tf: TF, startingEquity: 100 });
  const weeks = Math.max(0.01, (hi - lo) / (7 * 864e5));
  const byFail = {};
  for (const t of s) {
    const k = failClass(t);
    byFail[k] ??= { n: 0, pnl: 0 };
    byFail[k].n += 1;
    byFail[k].pnl += Number(t.netPnl ?? 0);
  }
  const years = Math.max(0.01, (hi - lo) / (365.25 * 864e5));
  const totalRet = Number(m.totalReturnPct ?? 0);
  const cagr = years > 0 ? (Math.pow(Math.max(1e-9, 1 + totalRet / 100), 1 / years) - 1) * 100 : 0;
  return {
    n: s.length,
    tw: +(s.length / weeks).toFixed(2),
    ret: +totalRet.toFixed(2),
    cagr: +cagr.toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(3),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    cal: +(m.calmar ?? 0).toFixed(2),
    byFail,
  };
}

function yearSlices(lo, hi) {
  const out = [];
  let y = new Date(lo).getUTCFullYear();
  const endY = new Date(hi - 1).getUTCFullYear();
  while (y <= endY) {
    const a = Math.max(lo, Date.UTC(y, 0, 1));
    const b = Math.min(hi, Date.UTC(y + 1, 0, 1));
    if (b > a) out.push({ year: y, lo: a, hi: b });
    y += 1;
  }
  return out;
}

function baseCfg(over = {}) {
  let cfg = {
    ...INTRADAY_PRO_LIQ_CORE_15M,
    ...over,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    riskPerTrade: 2.5,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
  };
  return materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
}

async function load() {
  const pad = 21 * 864e5;
  const candles = await readCandles(SYMBOL, TF, fromMs - pad, toMs, { market: "futures" });
  const funding = await readFundingRates(SYMBOL, fromMs - pad, toMs).catch(() => []);
  return { candles, funding };
}

async function runSim(candles, funding, over = {}) {
  clearIntradayAdapterCache?.();
  const cfg = baseCfg(over);
  const adapter = buildIntradayBacktestAdapter(candles, cfg, TF);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: 100,
    timeframe: TF,
    adapters: { SR_INTRADAY: adapter, INTRADAY_PRO: adapter },
    symbol: SYMBOL,
  });
  return (sim.trades ?? []).filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

function summarizeDist(vals) {
  const a = vals.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return null;
  const q = (p) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
  const mean = a.reduce((s, v) => s + v, 0) / a.length;
  return { n: a.length, mean: +mean.toFixed(4), p25: +q(0.25).toFixed(4), p50: +q(0.5).toFixed(4), p75: +q(0.75).toFixed(4) };
}

function rateBy(rows, keyFn, minN = 8) {
  const m = {};
  for (const r of rows) {
    const k = keyFn(r);
    m[k] ??= { n: 0, pnl: 0, wins: 0 };
    m[k].n += 1;
    m[k].pnl += r.pnl;
    if (r.win) m[k].wins += 1;
  }
  return Object.entries(m)
    .map(([k, v]) => ({
      k,
      n: v.n,
      pnl: +v.pnl.toFixed(2),
      wr: +((v.wins / v.n) * 100).toFixed(1),
      avg: +(v.pnl / v.n).toFixed(3),
    }))
    .filter((x) => x.n >= minN)
    .sort((a, b) => b.avg - a.avg);
}

function softKeep(rows, label, pred) {
  const keep = rows.filter(pred);
  const drop = rows.length - keep.length;
  const pnl = keep.reduce((s, r) => s + r.pnl, 0);
  const base = rows.reduce((s, r) => s + r.pnl, 0);
  const wins = keep.filter((r) => r.win).length;
  const keepPct = (100 * keep.length) / Math.max(1, rows.length);
  // Pseudo PF on kept subset
  let gp = 0;
  let gl = 0;
  for (const r of keep) {
    if (r.pnl > 0) gp += r.pnl;
    else gl += Math.abs(r.pnl);
  }
  const pf = gl > 0 ? gp / gl : gp > 0 ? 99 : 0;
  return {
    label,
    keep: keep.length,
    keepPct: +keepPct.toFixed(1),
    drop,
    pnl: +pnl.toFixed(2),
    basePnl: +base.toFixed(2),
    wr: +((100 * wins) / Math.max(1, keep.length)).toFixed(1),
    pf: +pf.toFixed(3),
  };
}

function enrichTrades(trades, candles, pre, cfg) {
  const opts = {
    ...buildIntradayOptsFromCfg(cfg),
    _liqPre: pre,
    intradayLiqHarvestMode: true, // feature rebuild without re-gating
  };
  const rows = [];
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const idx = findIdx(candles, t.entryBarTs ?? t.entryTs);
    if (idx < 0) continue;
    const dir =
      t.direction === -1 || t.direction === "SELL" || t.direction === "short" ? "SELL" : "BUY";
    const pnl = Number(t.netPnl ?? 0);
    const reason = String(t.entryReason || t.reason || "");
    let level =
      /pdh/.test(reason) ? "pdh"
      : /pdl/.test(reason) ? "pdl"
      : /session_high/.test(reason) ? "session_high"
      : /session_low/.test(reason) ? "session_low"
      : "other";

    let dayType = "range";
    if (isBreakdownDay(candles, idx, pre)) dayType = "breakdown";
    else if (isBreakoutDay(candles, idx, pre)) dayType = "breakout";

    const narrative = resolveSessionNarrative(Number(t.entryTs));
    const hour = new Date(Number(t.entryTs)).getUTCHours();
    const htfUp = !!pre.htfUp?.[idx];
    const htfDown = !!pre.htfDown?.[idx];
    const htfAlign = (dir === "BUY" && htfUp) || (dir === "SELL" && htfDown);
    const htfAgainst = (dir === "BUY" && htfDown) || (dir === "SELL" && htfUp);

    let feat = {
      sweepVelAtr: null,
      sweepExt: null,
      sweepAttempts: null,
      absorption: null,
      exhaustion: null,
      dispImpulseAtr: null,
      dispBodyEff: null,
      contOppR: null,
      contRangeUsed: null,
      contPassed: null,
      scoreV2: null,
      sameBar: null,
      sweepBars: null,
    };

    try {
      const setups = listSessionLiquiditySetups(candles, idx, dir, pre, opts);
      const match =
        setups.find((s) => String(s.levelType || "").includes(level.replace("session_", "session"))) ||
        setups[0];
      if (match) {
        level = String(match.levelType || level);
        const sq = match.liqContext?.sweepQuality || match.sweepQuality;
        const disp = match.liqContext?.displacementV2 || match.displacementV2;
        const cont = match.liqContext?.continuationRoom || match.continuationRoom;
        const score = match.liqContext?.entryScoreV2 || match.entryScoreV2 || match.score;
        feat.sweepVelAtr = Number(sq?.sweepVelocityAtr ?? NaN);
        feat.sweepExt = Number(sq?.extension ?? match.extension ?? NaN);
        feat.sweepAttempts = Number(sq?.attemptCount ?? match.attemptCount ?? NaN);
        feat.absorption = Number(sq?.absorptionProxy ?? NaN);
        feat.exhaustion = Number(sq?.exhaustionScore ?? NaN);
        feat.dispImpulseAtr = Number(disp?.impulseAtr ?? NaN);
        feat.dispBodyEff = Number(disp?.bodyEfficiency ?? NaN);
        feat.contOppR = Number(cont?.distanceToOpposingR ?? NaN);
        feat.contRangeUsed = Number(cont?.dailyRangeUsedPct ?? NaN);
        feat.contPassed = cont?.passed === true;
        feat.scoreV2 = Number(typeof score === "object" ? score.total ?? score.score : score);
        const reclaimIdx = Number(match.reclaimIdx ?? NaN);
        const sweepStart = Number(match.sweepStartIdx ?? NaN);
        feat.sameBar = Number.isFinite(reclaimIdx) && reclaimIdx === sweepStart;
        feat.sweepBars =
          Number.isFinite(reclaimIdx) && Number.isFinite(sweepStart) ? reclaimIdx - sweepStart : null;
      }
    } catch {
      /* feature attach best-effort */
    }

    const slDist =
      Math.abs(Number(t.entryPrice) - Number(t.slPrice || t.initialSlPrice || 0)) /
      Math.max(Number(t.entryPrice), 1e-9);

    rows.push({
      pnl,
      win: pnl > 0,
      dir,
      level,
      dayType,
      narrative,
      hour,
      htfAlign,
      htfAgainst,
      mfe: Number(t.mfePct ?? 0),
      mae: Number(t.maePct ?? 0),
      bars: Number(t.barsHeld ?? 0),
      exit: String(t.exitReason || "?"),
      fail: failClass(t),
      slDist,
      adx: Number(pre.adxSeries?.[idx] ?? NaN),
      atrPct:
        Number(pre.atrSeries?.[idx] ?? 0) > 0 && Number(candles[idx]?.close) > 0
          ? Number(pre.atrSeries[idx]) / Number(candles[idx].close)
          : NaN,
      ...feat,
    });
  }
  return rows;
}

function printRate(title, rows) {
  console.log(`\n--- ${title} ---`);
  for (const r of rows) console.log(r);
}

const { candles, funding } = await load();
console.log(`candles=${candles.length} window=${FROM}→${TO} holdFrom=${HOLD_FROM}`);

console.log("\n========== 1) BNB 3Y BASELINE (CORE X4+T1+P1) ==========");
const cfg0 = baseCfg({});
const trades0 = await runSim(candles, funding, {});
const full = metrics(trades0, fromMs, toMs);
const train = metrics(trades0, fromMs, holdFromMs);
const hold = metrics(trades0, holdFromMs, toMs);
console.log("FULL ", full);
console.log("TRAIN", train);
console.log("HOLD ", hold);
const byYear = {};
for (const y of yearSlices(fromMs, toMs)) {
  byYear[y.year] = metrics(trades0, y.lo, y.hi);
  console.log(`Y${y.year}`, byYear[y.year]);
}

console.log("\n========== 2) LIQUIDITY FEATURE AUTOPSY ==========");
const pre = precomputeIntraday(candles);
const enriched = enrichTrades(trades0, candles, pre, cfg0);
const W = enriched.filter((r) => r.win);
const L = enriched.filter((r) => !r.win);
console.log(`enriched n=${enriched.length} W=${W.length} L=${L.length}`);

const contKeys = [
  "mfe",
  "mae",
  "bars",
  "slDist",
  "adx",
  "atrPct",
  "sweepVelAtr",
  "sweepExt",
  "sweepAttempts",
  "absorption",
  "exhaustion",
  "dispImpulseAtr",
  "dispBodyEff",
  "contOppR",
  "contRangeUsed",
  "scoreV2",
  "sweepBars",
];
const distW = {};
const distL = {};
for (const k of contKeys) {
  distW[k] = summarizeDist(W.map((r) => r[k]));
  distL[k] = summarizeDist(L.map((r) => r[k]));
  const wm = distW[k]?.mean;
  const lm = distL[k]?.mean;
  if (wm != null && lm != null) {
    console.log(`${k.padEnd(16)} W_mean=${wm} L_mean=${lm} delta=${(wm - lm).toFixed(4)}`);
  }
}

printRate("level", rateBy(enriched, (r) => r.level, 5));
printRate("narrative", rateBy(enriched, (r) => r.narrative, 5));
printRate("dayType x side", rateBy(enriched, (r) => `${r.dir}|${r.dayType}`, 5));
printRate("HTF", rateBy(enriched, (r) => (r.htfAlign ? "align" : r.htfAgainst ? "against" : "flat"), 5));
printRate("fail class", rateBy(enriched, (r) => r.fail, 1));
printRate(
  "contOppR buckets",
  rateBy(
    enriched,
    (r) => {
      const v = r.contOppR;
      if (!Number.isFinite(v)) return "na";
      if (v < 1) return "oppR<1";
      if (v < 1.5) return "oppR_1_1.5";
      if (v < 2.5) return "oppR_1.5_2.5";
      return "oppR>=2.5";
    },
    5,
  ),
);
printRate(
  "dispImpulseAtr buckets",
  rateBy(
    enriched,
    (r) => {
      const v = r.dispImpulseAtr;
      if (!Number.isFinite(v)) return "na";
      if (v < 0.5) return "imp<0.5";
      if (v < 1) return "imp_0.5_1";
      if (v < 1.5) return "imp_1_1.5";
      return "imp>=1.5";
    },
    5,
  ),
);
printRate(
  "sweepVelAtr buckets",
  rateBy(
    enriched,
    (r) => {
      const v = r.sweepVelAtr;
      if (!Number.isFinite(v)) return "na";
      if (v < 0.05) return "vel<0.05";
      if (v < 0.15) return "vel_0.05_0.15";
      if (v < 0.3) return "vel_0.15_0.3";
      return "vel>=0.3";
    },
    5,
  ),
);
printRate(
  "rangeUsed buckets",
  rateBy(
    enriched,
    (r) => {
      const v = r.contRangeUsed;
      if (!Number.isFinite(v)) return "na";
      if (v < 0.4) return "range<40%";
      if (v < 0.7) return "range_40_70";
      return "range>=70%";
    },
    5,
  ),
);
printRate(
  "scoreV2 buckets",
  rateBy(
    enriched,
    (r) => {
      const v = r.scoreV2;
      if (!Number.isFinite(v)) return "na";
      if (v < 45) return "score<45";
      if (v < 55) return "score_45_55";
      if (v < 65) return "score_55_65";
      return "score>=65";
    },
    5,
  ),
);
printRate("sameBar", rateBy(enriched, (r) => (r.sameBar === true ? "sameBar" : r.sameBar === false ? "multiBar" : "na"), 5));

const soft = [
  softKeep(enriched, "all", () => true),
  softKeep(enriched, "not_toxic_trend", (r) => !((r.dir === "BUY" && r.dayType === "breakdown") || (r.dir === "SELL" && r.dayType === "breakout"))),
  softKeep(enriched, "htf_not_against", (r) => !r.htfAgainst),
  softKeep(enriched, "oppR_ge_1.5", (r) => Number.isFinite(r.contOppR) && r.contOppR >= 1.5),
  softKeep(enriched, "oppR_ge_2", (r) => Number.isFinite(r.contOppR) && r.contOppR >= 2),
  softKeep(enriched, "rangeUsed_lt_70", (r) => !Number.isFinite(r.contRangeUsed) || r.contRangeUsed < 0.7),
  softKeep(enriched, "disp_imp_ge_1", (r) => Number.isFinite(r.dispImpulseAtr) && r.dispImpulseAtr >= 1),
  softKeep(enriched, "disp_imp_ge_0.75", (r) => Number.isFinite(r.dispImpulseAtr) && r.dispImpulseAtr >= 0.75),
  softKeep(enriched, "vel_lt_0.3", (r) => !Number.isFinite(r.sweepVelAtr) || r.sweepVelAtr < 0.3),
  softKeep(enriched, "score_ge_55", (r) => Number.isFinite(r.scoreV2) && r.scoreV2 >= 55),
  softKeep(enriched, "multiBar_reclaim", (r) => r.sameBar !== true),
  softKeep(enriched, "pdh_pdl_only", (r) => r.level === "pdh" || r.level === "pdl"),
  softKeep(
    enriched,
    "combo_oppR1.5_range70",
    (r) =>
      Number.isFinite(r.contOppR) &&
      r.contOppR >= 1.5 &&
      (!Number.isFinite(r.contRangeUsed) || r.contRangeUsed < 0.7),
  ),
  softKeep(
    enriched,
    "combo_disp075_oppR15",
    (r) =>
      Number.isFinite(r.dispImpulseAtr) &&
      r.dispImpulseAtr >= 0.75 &&
      Number.isFinite(r.contOppR) &&
      r.contOppR >= 1.5,
  ),
];
console.log("\n--- soft keep (informational) ---");
for (const s of soft) console.log(s);

console.log("\n========== 3) FULL-SIM A/B (BNB 3Y) ==========");
const variants = [
  ["H0_core", {}],
  // Liquidity-concept enhances suggested by soft autopsy (one change each)
  ["L1_contRoom_minR15", { intradayLiqContinuationGate: true, intradayLiqMinContinuationR: 1.5 }],
  ["L2_contRoom_minR12", { intradayLiqContinuationGate: true, intradayLiqMinContinuationR: 1.2 }],
  ["L3_maxRange70", { intradayLiqContinuationGate: true, intradayLiqMaxDailyRangeUsedPct: 0.7 }],
  ["L4_disp_req_075", { intradayLiqRequireSweepDisplacement: true, intradayLiqSweepDisplacementMinAtrMult: 0.75 }],
  ["L5_disp_req_1", { intradayLiqRequireSweepDisplacement: true, intradayLiqSweepDisplacementMinAtrMult: 1.0 }],
  ["L6_sweepQ_maxVel03", { intradayLiqSweepQualityGate: true, intradayLiqMaxSweepVelocityAtr: 0.3 }],
  ["L7_score55", { intradayLiqUseEntryScoreV2: true, intradayLiqMinEntryScore: 55 }],
  ["L8_noSameBar", { intradayLiqRejectSameBarReclaim: true }],
  ["L9_pdhPdlOnly", { intradayLiqSessionExtreme: false }],
  ["L10_noToxic", { intradayLiqBreakdownDayBias: true }],
  // Exit / path (known class) on 3y
  ["E1_hold3", { intradayLiqReclaimHoldBars: 3 }],
  ["E2_maxTpRr15", { intradayLiqMaxTpRr: 1.5 }],
  ["E3_maxTpRr25", { intradayLiqMaxTpRr: 2.5 }],
  // Best soft combo candidates as hard gates
  ["X1_cont15_range70", {
    intradayLiqContinuationGate: true,
    intradayLiqMinContinuationR: 1.5,
    intradayLiqMaxDailyRangeUsedPct: 0.7,
  }],
  ["X2_disp075_cont15", {
    intradayLiqRequireSweepDisplacement: true,
    intradayLiqSweepDisplacementMinAtrMult: 0.75,
    intradayLiqContinuationGate: true,
    intradayLiqMinContinuationR: 1.5,
  }],
];

const ab = [];
const baseTw = full.tw;
const basePf = full.pf;
const baseRet = full.ret;
for (const [id, over] of variants) {
  process.stderr.write(`${id}\n`);
  try {
    const trades = await runSim(candles, funding, over);
    const f = metrics(trades, fromMs, toMs);
    const h = metrics(trades, holdFromMs, toMs);
    const freqOk = f.tw >= baseTw * 0.6;
    const better = f.pf > basePf && f.ret > baseRet;
    const holdBetter = h.pf >= hold.pf && h.ret >= hold.ret;
    ab.push({ id, full: f, hold: h, freqOk, better, holdBetter });
    console.log(
      `${id.padEnd(22)} n=${String(f.n).padStart(4)} tw=${f.tw} ret=${String(f.ret).padStart(8)} pf=${f.pf} | HOLD pf=${h.pf} ret=${h.ret} | freqOk=${freqOk} better=${better}`,
    );
  } catch (e) {
    console.log(`${id} ERROR ${e.message}`);
    ab.push({ id, error: e.message });
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  symbol: SYMBOL,
  window: { FROM, TO, HOLD_FROM },
  baseline: { full, train, hold, byYear },
  featureDists: { W: distW, L: distL },
  soft,
  ab,
};
const out = path.join(__dirname, ".liq-core-bnb-3y-optimize.json");
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.error(`wrote ${out}`);
await closePool?.();
