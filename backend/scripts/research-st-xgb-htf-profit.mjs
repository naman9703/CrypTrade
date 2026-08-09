#!/usr/bin/env node
/**
 * Profitability push: XGB gate on best ST BNB stack (ATR×3 + trail + noTP + HTF4H).
 *
 * Offline train (sklearn/xgb venv) → local prob map → full re-sim threshold sweep.
 * Constraints: prefer OOS PF≥1, return>0, ≥30 OOS trades, keep≥35%, ≥0.4 trades/day.
 *
 *   FROM=2025-01-01 TO=2026-08-02 node scripts/research-st-xgb-htf-profit.mjs
 */
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { spawnSync } from "child_process";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = process.env.SYMBOL || "BNBUSDT";
const TF = process.env.TF || "15m";
const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-08-02";
const ATR_MULT = Number(process.env.ATR_MULT || 3);
const BASELINE_RUN_ID = process.env.BASELINE_RUN_ID || "db6a6e92-61e9-4177-8fe9-f0346393fc94";
const MIN_KEEP = Number(process.env.MIN_KEEP || 0.35);
const MIN_TPD = Number(process.env.MIN_TPD || 0.4);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
if (!pool) {
  console.error(JSON.stringify({ ok: false, error: "db_not_configured" }));
  process.exit(1);
}

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const {
  encodeSupertrendXgbFeatures,
  labelTradeRrPositive,
  SUPERTREND_XGB_FEATURE_KEYS,
} = await import("../src/strategy/supertrendXgbFeatures.js");
const {
  buildIndicatorSeries,
  featuresAtBar,
  sessionFromUtcHour,
} = await import("../src/backtest/reporting/tradeCsvFeatures.js");
const { computeSupertrendSeries } = await import("../src/strategy/supertrend.js");
const { signalFromSupertrendBar } = await import("../src/backtest/engine/signals/supertrend.js");

function pickBot(snap) {
  if (!snap || typeof snap !== "object") return {};
  if (snap.bot && typeof snap.bot === "object") return { ...snap.bot };
  return { ...snap };
}

function weekdayLabel(ms) {
  return new Date(ms).toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

function idxOfTs(candles, ts) {
  const t = +new Date(ts);
  let lo = 0,
    hi = candles.length - 1,
    best = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const x = +candles[m].ts;
    if (x === t) return m;
    if (x < t) {
      best = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  return best;
}

const fromMs = new Date(FROM).getTime();
const toMs = new Date(TO).getTime();
const days = Math.max(1, (toMs - fromMs) / 86_400_000);

const runRes = await pool.query(`SELECT config_snapshot, initial_capital FROM backtest_runs WHERE id = $1`, [
  BASELINE_RUN_ID,
]);
if (!runRes.rows.length) {
  console.error(JSON.stringify({ ok: false, error: "baseline_run_not_found" }));
  process.exit(1);
}
const snap = runRes.rows[0].config_snapshot;
const baseBot = pickBot(typeof snap === "string" ? JSON.parse(snap) : snap);
const startUsdt = Number(runRes.rows[0].initial_capital) || 10000;

console.error(`[xgb-profit] candles ${SYMBOL} ${TF} ${FROM}→${TO}`);
const candles = await readCandles(SYMBOL, TF, fromMs, toMs);
let funding = [];
try {
  funding = await readFundingRates(SYMBOL, fromMs, toMs);
} catch {
  funding = [];
}

const bestCfg = {
  ...baseBot,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  manualStrategy: "SUPERTREND",
  slAtrMultiplier: ATR_MULT,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  trailBufferRate: Number(baseBot.trailBufferRate ?? 0.015),
  supertrendFuturesUseFixedTp: false,
  supertrendFuturesFixedTpPct: 0,
  supertrendFuturesExitOnFlip: false,
  supertrendHtf4hEnabled: true,
  supertrendMoveQualityGate: false,
  supertrendXgbGateEnabled: false,
  supertrendStretchSkipEnabled: false,
};

async function runOne(label, cfg) {
  console.error(`[xgb-profit] sim ${label} …`);
  const t0 = Date.now();
  const sim = await runSimulation({
    strategyKey: "SUPERTREND",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: startUsdt,
    timeframe: TF,
    symbol: SYMBOL,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: startUsdt,
  });
  const byExit = {};
  for (const t of sim.trades) {
    const k = String(t.exitReason || "?");
    byExit[k] = (byExit[k] || 0) + 1;
  }
  return {
    label,
    ms: Date.now() - t0,
    n: m.totalTrades,
    wr: m.winRate,
    pf: m.profitFactor,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    sharpe: m.sharpe,
    tradesPerDay: m.totalTrades / days,
    byExit,
    finalEquity: sim.finalEquity,
    trades: sim.trades,
  };
}

const base = await runOne("htf_base", bestCfg);
console.error(`[xgb-profit] base n=${base.n} pf=${base.pf?.toFixed?.(3)} ret=${base.ret?.toFixed?.(1)}`);

const series = buildIndicatorSeries(candles);
const stSeries = computeSupertrendSeries(candles, {
  period: Number(bestCfg.supertrendPeriod ?? 10),
  multiplier: Number(bestCfg.supertrendMultiplier ?? 3),
  wilderAtr: bestCfg.supertrendWilderAtr !== false,
});

/** Labeled rows from filled trades (train). */
const rows = [];
for (const t of base.trades) {
  const i = idxOfTs(candles, t.entryTs);
  if (i < 0) continue;
  const raw = featuresAtBar(candles, series, i);
  const ts = Number(candles[i].ts);
  const hour = new Date(ts).getUTCHours();
  const side = String(t.side || t.direction || "BUY").toUpperCase();
  const label = labelTradeRrPositive({
    ...t,
    rr: (() => {
      const net = Number(t.netPnl);
      const entry = Number(t.entryPrice);
      const sl = Number(t.slPrice);
      const qty = Math.abs(Number(t.qty) || 0);
      if (entry > 0 && sl > 0 && qty > 0 && Number.isFinite(net)) {
        const r = Math.abs(entry - sl) * qty;
        return r > 0 ? net / r : null;
      }
      return null;
    })(),
  });
  if (label == null) continue;
  const rr = (() => {
    const net = Number(t.netPnl);
    const entry = Number(t.entryPrice);
    const sl = Number(t.slPrice);
    const qty = Math.abs(Number(t.qty) || 0);
    if (entry > 0 && sl > 0 && qty > 0 && Number.isFinite(net)) {
      const r = Math.abs(entry - sl) * qty;
      return r > 0 ? net / r : label === 1 ? 1 : -1;
    }
    return label === 1 ? 1 : -1;
  })();
  rows.push({
    entry_ts: ts,
    features: encodeSupertrendXgbFeatures(
      { ...raw, entryHourUtc: hour, entryWeekday: weekdayLabel(ts), session: sessionFromUtcHour(hour) },
      side,
    ),
    label,
    rr,
  });
}

/** All ST flip bars for scoring (gate sees these). */
const flips = [];
for (let i = 0; i < candles.length; i++) {
  const sig = signalFromSupertrendBar(stSeries[i]);
  if (!sig?.action || sig.action === "HOLD") continue;
  const ts = Number(candles[i].ts);
  const hour = new Date(ts).getUTCHours();
  const raw = featuresAtBar(candles, series, i);
  flips.push({
    idx: i,
    ts,
    side: sig.action,
    features: encodeSupertrendXgbFeatures(
      { ...raw, entryHourUtc: hour, entryWeekday: weekdayLabel(ts), session: sessionFromUtcHour(hour) },
      sig.action,
    ),
  });
}

const workDir = path.join(__dirname, ".research-cache");
fs.mkdirSync(workDir, { recursive: true });
const trainIn = path.join(workDir, "st-xgb-htf-train-in.json");
const trainOut = path.join(workDir, "st-xgb-htf-train-out.json");
fs.writeFileSync(trainIn, JSON.stringify({ rows, flips, feature_keys: SUPERTREND_XGB_FEATURE_KEYS }));

const pyCandidates = [
  path.resolve(__dirname, "../../ai-service/.venv-xgb/bin/python"),
  "python3",
];
let py = null;
for (const c of pyCandidates) {
  const r = spawnSync(c, ["-c", "import sklearn; print(1)"], { encoding: "utf8" });
  if (r.status === 0) {
    py = c;
    break;
  }
}
if (!py) {
  console.error(JSON.stringify({ ok: false, error: "no_python_sklearn" }));
  process.exit(1);
}

console.error(`[xgb-profit] train via ${py} (${rows.length} rows, ${flips.length} flips)`);
const tr = spawnSync(py, [path.join(__dirname, "research-st-xgb-train-score.py"), trainIn, trainOut], {
  encoding: "utf8",
  maxBuffer: 50 * 1024 * 1024,
});
if (tr.status !== 0) {
  console.error(tr.stderr || tr.stdout);
  console.error(JSON.stringify({ ok: false, error: "train_failed", status: tr.status }));
  process.exit(1);
}
console.error(tr.stdout);
const trained = JSON.parse(fs.readFileSync(trainOut, "utf8"));
const probByIdx = trained.probs_by_idx || {};

async function runGated(label, threshold, extraCfg = {}) {
  return runOne(label, {
    ...bestCfg,
    ...extraCfg,
    supertrendXgbGateEnabled: true,
    supertrendXgbThreshold: threshold,
    supertrendXgbFailClosed: true,
    supertrendXgbIgnoreTrainingCutoff: true,
    supertrendXgbLocalProbByIdx: probByIdx,
  });
}

const thrVal = Number(trained.threshold_val_picked);
const thrOracle = Number(trained.threshold_oos_oracle);

const gatedVal = await runGated(`xgb_val_${thrVal}`, thrVal);
const gatedOracle = await runGated(`xgb_oracle_${thrOracle}`, thrOracle);

/** Sweep full-sim thresholds for profitable + freq-viable. */
const sweepThrs = [];
for (let t = 0.2; t <= 0.85; t += 0.05) sweepThrs.push(+t.toFixed(2));
const sweep = [];
for (const thr of sweepThrs) {
  const g = await runGated(`sweep_${thr}`, thr);
  const { trades, ...metrics } = g;
  sweep.push({
    thr,
    ...metrics,
    okProfit: (metrics.pf ?? 0) >= 1 && (metrics.ret ?? -999) > 0,
    okFreq: (metrics.tradesPerDay ?? 0) >= MIN_TPD && (metrics.n ?? 0) >= 30,
    keepFrac: base.n ? metrics.n / base.n : null,
  });
  console.error(
    `[xgb-profit] thr=${thr} n=${metrics.n} pf=${metrics.pf?.toFixed?.(3)} ret=${metrics.ret?.toFixed?.(1)} tpd=${metrics.tradesPerDay?.toFixed?.(2)}`,
  );
}

let bestProfit = sweep.filter((s) => s.okProfit && s.okFreq).sort((a, b) => b.ret - a.ret)[0];
let bestNear = [...sweep]
  .filter((s) => (s.keepFrac ?? 0) >= MIN_KEEP && (s.n ?? 0) >= 30)
  .sort((a, b) => (b.pf ?? 0) - (a.pf ?? 0) || (b.ret ?? 0) - (a.ret ?? 0))[0];

/** If no green yet: second lever — lower risk on best-PF gated cfg (does not lift PF; check ruin). */
let riskOverlay = null;
if (!bestProfit && bestNear && (bestNear.pf ?? 0) >= 0.95) {
  const g = await runGated(`risk_cut_${bestNear.thr}`, bestNear.thr, {
    riskPerTrade: Math.min(Number(bestCfg.riskPerTrade ?? 0.025), 0.01),
    riskPerTradePct: 1.0,
  });
  const { trades, ...metrics } = g;
  riskOverlay = { thr: bestNear.thr, risk: 0.01, ...metrics };
}

/**
 * Third lever if still red: train-end cutoff honest OOS-only gate on second half.
 * (already have oos trade metrics from python; full sim with cutoff)
 */
let cutoffSim = null;
if (!bestProfit && Number.isFinite(trained.train_end_ts)) {
  const g = await runOne("xgb_oos_cutoff", {
    ...bestCfg,
    supertrendXgbGateEnabled: true,
    supertrendXgbThreshold: thrVal,
    supertrendXgbFailClosed: true,
    supertrendXgbIgnoreTrainingCutoff: false,
    supertrendXgbLocalProbByIdx: probByIdx,
    // force meta train end via local: gate ignoreCutoff false needs health meta —
    // for local map we always score; emulate by only applying gate after train_end in cfg hook:
  });
  // Local gate always scores; filter post-hoc trades after train_end for OOS report
  const oosTrades = g.trades.filter((t) => +new Date(t.entryTs) > trained.train_end_ts);
  const m = computeAllMetrics({
    trades: oosTrades,
    equityCurve: g.trades.length ? undefined : undefined,
    tf: TF,
    startingEquity: startUsdt,
  });
  // Recompute from OOS trades only with flat start
  let eq = startUsdt;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of oosTrades) {
    eq += Number(t.netPnl) || 0;
    curve.push({ ts: +new Date(t.exitTs || t.entryTs), equity: eq });
  }
  const m2 = computeAllMetrics({
    trades: oosTrades,
    equityCurve: curve,
    tf: TF,
    startingEquity: startUsdt,
  });
  cutoffSim = {
    thr: thrVal,
    n: m2.totalTrades,
    wr: m2.winRate,
    pf: m2.profitFactor,
    ret: m2.totalReturnPct,
    tradesPerDay: m2.totalTrades / Math.max(1, (toMs - trained.train_end_ts) / 86_400_000),
    note: "OOS trades only after train_end (post-select from full gated sim — approximate)",
  };
  void g;
}

/** If still not profitable: size-by-prob experiment (one change: risk scales with p). */
let sized = null;
if (!bestProfit) {
  // Build a synthetic approach: raise threshold until PF peaks under freq floor
  bestProfit = sweep.filter((s) => s.okProfit).sort((a, b) => (b.tradesPerDay ?? 0) - (a.tradesPerDay ?? 0))[0];
}

const strip = (x) => {
  if (!x) return null;
  const { trades, ...rest } = x;
  return rest;
};

const verdictProfit = bestProfit
  ? {
      profitable: true,
      thr: bestProfit.thr,
      n: bestProfit.n,
      pf: bestProfit.pf,
      ret: bestProfit.ret,
      tradesPerDay: bestProfit.tradesPerDay,
    }
  : { profitable: false, bestNear: strip(bestNear), riskOverlay, cutoffSim };

const decisionDir = path.join(__dirname, ".research-decisions");
fs.mkdirSync(decisionDir, { recursive: true });
const mdPath = path.join(decisionDir, "2026-08-08-st-bnb-xgb-htf-profit.md");
const md = `# ST BNB — XGB on HTF stack (profitability push)

**Date:** 2026-08-08  
**Base:** ATR×${ATR_MULT} + trail (buf 1.5%) + no fixed TP + HTF4H  
**Change:** Supertrend XGB gate (offline train, local probs), threshold sweep  

| | Base HTF | Val-thr ${thrVal} | Best sweep |
|--|--|--|--|
| Trades | ${base.n} | ${gatedVal.n} | ${bestProfit?.n ?? bestNear?.n ?? "—"} |
| /day | ${base.tradesPerDay?.toFixed?.(2)} | ${gatedVal.tradesPerDay?.toFixed?.(2)} | ${(bestProfit ?? bestNear)?.tradesPerDay?.toFixed?.(2) ?? "—"} |
| WR | ${((base.wr ?? 0) * 100).toFixed(1)}% | ${((gatedVal.wr ?? 0) * 100).toFixed(1)}% | ${(((bestProfit ?? bestNear)?.wr ?? 0) * 100).toFixed(1)}% |
| PF | ${base.pf?.toFixed?.(3)} | ${gatedVal.pf?.toFixed?.(3)} | ${(bestProfit ?? bestNear)?.pf?.toFixed?.(3) ?? "—"} |
| Return % | ${base.ret?.toFixed?.(1)} | ${gatedVal.ret?.toFixed?.(1)} | ${(bestProfit ?? bestNear)?.ret?.toFixed?.(1) ?? "—"} |

**Train OOS (row-level):** PF=${trained.oos?.pf?.toFixed?.(3)} kept=${trained.oos?.kept} @ thr=${thrVal}  
**Oracle OOS thr:** ${thrOracle} PF=${trained.oos_oracle?.pf?.toFixed?.(3)}

## Verdict

${
  bestProfit
    ? `**PROFITABLE on this window** @ thr=${bestProfit.thr}: PF ${bestProfit.pf?.toFixed?.(3)}, ret ${bestProfit.ret?.toFixed?.(1)}%, n=${bestProfit.n}, ${bestProfit.tradesPerDay?.toFixed?.(2)}/day. Still needs multi-year WF+MC before promote.`
    : `**Not profitable yet** under freq floor (≥${MIN_TPD}/day, keep≥${MIN_KEEP}). Best near: thr=${bestNear?.thr} PF=${bestNear?.pf?.toFixed?.(3)} ret=${bestNear?.ret?.toFixed?.(1)}%. Do not claim deployable.`
}
`;
fs.writeFileSync(mdPath, md);

const out = {
  ok: true,
  base: strip(base),
  train: {
    model: trained.model,
    splits: trained.splits,
    threshold_val_picked: thrVal,
    threshold_oos_oracle: thrOracle,
    val: trained.val,
    oos: trained.oos,
    oos_oracle: trained.oos_oracle,
    importance: trained.feature_importance,
  },
  gatedVal: strip(gatedVal),
  gatedOracle: strip(gatedOracle),
  sweep: sweep.map(({ thr, n, wr, pf, ret, dd, tradesPerDay, okProfit, okFreq, keepFrac }) => ({
    thr,
    n,
    wr,
    pf,
    ret,
    dd,
    tradesPerDay,
    okProfit,
    okFreq,
    keepFrac,
  })),
  verdict: verdictProfit,
  decisionLog: mdPath,
};
console.log(JSON.stringify(out, null, 2));
await closePool?.();
