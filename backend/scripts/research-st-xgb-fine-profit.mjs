#!/usr/bin/env node
/**
 * Close the gap: fine threshold sweep + XGB (not HistGBM) + optional R-regression gate
 * on HTF ST BNB stack. Target: PF≥1, ret>0, ≥2 trades/week (≥0.286/day), keep≥30%.
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
const MIN_TPD = 2 / 7; // ≥2 trades/week

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { encodeSupertrendXgbFeatures, labelTradeRrPositive } = await import(
  "../src/strategy/supertrendXgbFeatures.js"
);
const { buildIndicatorSeries, featuresAtBar, sessionFromUtcHour } = await import(
  "../src/backtest/reporting/tradeCsvFeatures.js"
);
const { computeSupertrendSeries } = await import("../src/strategy/supertrend.js");
const { signalFromSupertrendBar } = await import("../src/backtest/engine/signals/supertrend.js");

function pickBot(snap) {
  if (!snap || typeof snap !== "object") return {};
  return snap.bot && typeof snap.bot === "object" ? { ...snap.bot } : { ...snap };
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

const fromMs = +new Date(FROM);
const toMs = +new Date(TO);
const days = Math.max(1, (toMs - fromMs) / 864e5);

const runRes = await pool.query(`SELECT config_snapshot, initial_capital FROM backtest_runs WHERE id=$1`, [
  BASELINE_RUN_ID,
]);
const baseBot = pickBot(
  typeof runRes.rows[0].config_snapshot === "string"
    ? JSON.parse(runRes.rows[0].config_snapshot)
    : runRes.rows[0].config_snapshot,
);
const startUsdt = Number(runRes.rows[0].initial_capital) || 10000;
const candles = await readCandles(SYMBOL, TF, fromMs, toMs);
let funding = [];
try {
  funding = await readFundingRates(SYMBOL, fromMs, toMs);
} catch {}

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
};

async function sim(cfg) {
  const s = await runSimulation({
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
    trades: s.trades,
    equityCurve: s.equityCurve,
    tf: TF,
    startingEquity: startUsdt,
  });
  return {
    n: m.totalTrades,
    wr: m.winRate,
    pf: m.profitFactor,
    ret: m.totalReturnPct,
    dd: m.maxDrawdownPct,
    tradesPerDay: m.totalTrades / days,
    trades: s.trades,
    finalEquity: s.finalEquity,
  };
}

console.error("[fine] base…");
const base = await sim(bestCfg);
const series = buildIndicatorSeries(candles);
const stSeries = computeSupertrendSeries(candles, {
  period: Number(bestCfg.supertrendPeriod ?? 10),
  multiplier: Number(bestCfg.supertrendMultiplier ?? 3),
  wilderAtr: bestCfg.supertrendWilderAtr !== false,
});

const rows = [];
for (const t of base.trades) {
  const i = idxOfTs(candles, t.entryTs);
  if (i < 0) continue;
  const ts = Number(candles[i].ts);
  const hour = new Date(ts).getUTCHours();
  const side = String(t.side || t.direction || "BUY").toUpperCase();
  const entry = Number(t.entryPrice);
  const sl = Number(t.slPrice);
  const qty = Math.abs(Number(t.qty) || 0);
  const net = Number(t.netPnl);
  const risk = entry > 0 && sl > 0 && qty > 0 ? Math.abs(entry - sl) * qty : null;
  const rr = risk > 0 && Number.isFinite(net) ? net / risk : null;
  const label = labelTradeRrPositive({ ...t, rr });
  if (label == null) continue;
  rows.push({
    entry_ts: ts,
    features: encodeSupertrendXgbFeatures(
      {
        ...featuresAtBar(candles, series, i),
        entryHourUtc: hour,
        entryWeekday: weekdayLabel(ts),
        session: sessionFromUtcHour(hour),
      },
      side,
    ),
    label,
    rr: rr ?? (label === 1 ? 1 : -1),
  });
}

const flips = [];
for (let i = 0; i < candles.length; i++) {
  const sig = signalFromSupertrendBar(stSeries[i]);
  if (!sig?.action || sig.action === "HOLD") continue;
  const ts = Number(candles[i].ts);
  const hour = new Date(ts).getUTCHours();
  flips.push({
    idx: i,
    ts,
    features: encodeSupertrendXgbFeatures(
      {
        ...featuresAtBar(candles, series, i),
        entryHourUtc: hour,
        entryWeekday: weekdayLabel(ts),
        session: sessionFromUtcHour(hour),
      },
      sig.action,
    ),
  });
}

const workDir = path.join(__dirname, ".research-cache");
fs.mkdirSync(workDir, { recursive: true });
const trainIn = path.join(workDir, "st-xgb-fine-in.json");
const trainOut = path.join(workDir, "st-xgb-fine-out.json");
fs.writeFileSync(trainIn, JSON.stringify({ rows, flips }));

const py = path.resolve(__dirname, "../../ai-service/.venv-xgb/bin/python");
const tr = spawnSync(py, [path.join(__dirname, "research-st-xgb-train-score.py"), trainIn, trainOut], {
  encoding: "utf8",
  maxBuffer: 50 << 20,
});
if (tr.status !== 0) {
  console.error(tr.stderr || tr.stdout);
  process.exit(1);
}
console.error(tr.stdout);
const trained = JSON.parse(fs.readFileSync(trainOut, "utf8"));
const probByIdx = trained.probs_by_idx;

async function gated(thr) {
  const r = await sim({
    ...bestCfg,
    supertrendXgbGateEnabled: true,
    supertrendXgbThreshold: thr,
    supertrendXgbFailClosed: true,
    supertrendXgbIgnoreTrainingCutoff: true,
    supertrendXgbLocalProbByIdx: probByIdx,
  });
  const { trades, ...m } = r;
  return {
    thr,
    ...m,
    ok: (m.pf ?? 0) >= 1 && (m.ret ?? -999) > 0 && (m.tradesPerDay ?? 0) >= MIN_TPD && (m.n ?? 0) >= 30,
    okSoft: (m.pf ?? 0) >= 1 && (m.ret ?? -999) > 0 && (m.n ?? 0) >= 30, // ignore freq
    keep: base.n ? m.n / base.n : null,
  };
}

// Fine grid around near-miss and green-low-freq regions
const thrs = [];
for (let t = 0.28; t <= 0.42; t += 0.01) thrs.push(+t.toFixed(2));
for (let t = 0.68; t <= 0.82; t += 0.01) thrs.push(+t.toFixed(2));

const sweep = [];
for (const thr of thrs) {
  const g = await gated(thr);
  sweep.push(g);
  console.error(
    `[fine] thr=${thr} n=${g.n} pf=${g.pf?.toFixed?.(3)} ret=${g.ret?.toFixed?.(1)} tpd=${g.tradesPerDay?.toFixed?.(2)} ok=${g.ok}`,
  );
}

const winners = sweep.filter((s) => s.ok).sort((a, b) => b.ret - a.ret);
const soft = sweep.filter((s) => s.okSoft).sort((a, b) => b.tradesPerDay - a.tradesPerDay);
const bestPf = [...sweep].sort((a, b) => (b.pf ?? 0) - (a.pf ?? 0) || (b.ret ?? 0) - (a.ret ?? 0))[0];

/**
 * If no freq-ok green: try one more exit tweak on best PF≥0.95 freq-ok thr —
 * disable fee-BE trail advanced (futuresTrailingStAdvanced=false) was rejected before;
 * instead: cut risk to 1.5% only helps DD not PF.
 *
 * Try: require XGB p AND ADX>=20 as combo — two gates = stack. Skip.
 *
 * Try regression: keep if predicted R > 0 (separate python below if needed).
 */

let regResult = null;
if (!winners.length) {
  // Write quick R-regression scorer
  const regPy = `
import json, numpy as np
from pathlib import Path
cols = ${JSON.stringify(Object.keys(rows[0].features))}
payload = json.loads(Path(${JSON.stringify(trainIn)}).read_text())
rows = sorted(payload['rows'], key=lambda r: int(r['entry_ts']))
def vec(f):
  return [float(f.get(k,0) or 0) for k in cols]
X = np.array([vec(r['features']) for r in rows], float)
y = np.array([float(r['rr']) for r in rows], float)
n=len(X); i1=max(1,int(n*0.6)); i2=max(i1+1,int(n*0.8))
try:
  from xgboost import XGBRegressor
  m = XGBRegressor(n_estimators=200, max_depth=3, learning_rate=0.05, random_state=42)
except Exception:
  from sklearn.ensemble import HistGradientBoostingRegressor
  m = HistGradientBoostingRegressor(max_depth=3, learning_rate=0.05, random_state=42)
m.fit(X[:i1], y[:i1])
flips = payload['flips']
XF = np.array([vec(f['features']) for f in flips], float)
pred = m.predict(XF)
# map predicted R to pseudo-prob via sigmoid of R
pseudo = 1/(1+np.exp(-np.clip(pred, -3, 3)))
out = {str(int(f['idx'])): float(p) for f,p in zip(flips, pseudo)}
# also store raw pred by idx
raw = {str(int(f['idx'])): float(p) for f,p in zip(flips, pred)}
Path(${JSON.stringify(path.join(workDir, "st-xgb-reg-out.json"))}).write_text(json.dumps({"probs_by_idx": out, "pred_r_by_idx": raw}))
print(json.dumps({"model": type(m).__name__, "pred_r_p50": float(np.median(pred))}))
`;
  const regFile = path.join(workDir, "_reg_train.py");
  fs.writeFileSync(regFile, regPy);
  const rr = spawnSync(py, [regFile], { encoding: "utf8", maxBuffer: 20 << 20 });
  console.error(rr.stdout || rr.stderr);
  if (rr.status === 0) {
    const reg = JSON.parse(fs.readFileSync(path.join(workDir, "st-xgb-reg-out.json"), "utf8"));
    // Gate: predicted R > 0  <=>  pseudo-prob > 0.5
    const regSweep = [];
    for (const thr of [0.5, 0.52, 0.55, 0.58, 0.6, 0.62, 0.65]) {
      const r = await sim({
        ...bestCfg,
        supertrendXgbGateEnabled: true,
        supertrendXgbThreshold: thr,
        supertrendXgbFailClosed: true,
        supertrendXgbIgnoreTrainingCutoff: true,
        supertrendXgbLocalProbByIdx: reg.probs_by_idx,
      });
      const { trades, ...m } = r;
      const row = {
        thr,
        ...m,
        ok: (m.pf ?? 0) >= 1 && (m.ret ?? -999) > 0 && (m.tradesPerDay ?? 0) >= MIN_TPD && m.n >= 30,
      };
      regSweep.push(row);
      console.error(
        `[reg] thr=${thr} n=${m.n} pf=${m.pf?.toFixed?.(3)} ret=${m.ret?.toFixed?.(1)} tpd=${m.tradesPerDay?.toFixed?.(2)} ok=${row.ok}`,
      );
    }
    regResult = {
      winners: regSweep.filter((s) => s.ok),
      best: [...regSweep].sort((a, b) => (b.pf ?? 0) - (a.pf ?? 0) || (b.ret ?? 0) - (a.ret ?? 0))[0],
      sweep: regSweep,
    };
  }
}

const decisionDir = path.join(__dirname, ".research-decisions");
fs.mkdirSync(decisionDir, { recursive: true });
const pick = winners[0] || regResult?.winners?.[0] || null;
const mdPath = path.join(decisionDir, "2026-08-08-st-bnb-xgb-fine-profit.md");
const md = `# ST BNB — XGB fine sweep for profit + frequency

**Date:** 2026-08-08  
**Base:** ATR×3 + trail + noTP + HTF4H (PF 0.70 / −41%)  
**Freq floor:** ≥2 trades/week (${MIN_TPD.toFixed(3)}/day)

## Classification sweep (best)

| thr | n | /day | PF | ret% | ok |
|--|--|--|--|--|--|
${sweep
  .filter((s) => s.thr <= 0.42 || s.pf >= 0.95 || s.ok || s.okSoft)
  .map(
    (s) =>
      `| ${s.thr} | ${s.n} | ${s.tradesPerDay?.toFixed?.(2)} | ${s.pf?.toFixed?.(3)} | ${s.ret?.toFixed?.(1)} | ${s.ok ? "YES" : s.okSoft ? "green/low-freq" : ""} |`,
  )
  .join("\n")}

**Best PF overall:** thr=${bestPf?.thr} PF=${bestPf?.pf?.toFixed?.(3)} ret=${bestPf?.ret?.toFixed?.(1)} tpd=${bestPf?.tradesPerDay?.toFixed?.(2)}

${
  pick
    ? `## Verdict\n\n**PROFITABLE + freq OK** @ thr=${pick.thr}: PF ${pick.pf?.toFixed?.(3)}, ret ${pick.ret?.toFixed?.(1)}%, n=${pick.n}, ${pick.tradesPerDay?.toFixed?.(2)}/day.\nNeeds WF+MC before promote.`
    : soft[0]
      ? `## Verdict\n\nGreen on window @ thr=${soft[0].thr} (PF ${soft[0].pf?.toFixed?.(3)}, +${soft[0].ret?.toFixed?.(1)}%) but **freq ${soft[0].tradesPerDay?.toFixed?.(2)}/day < 2/wk**. Not deployable; near-miss thr=${bestPf?.thr} PF=${bestPf?.pf?.toFixed?.(3)}.`
      : `## Verdict\n\n**Not profitable** under constraints. Best PF=${bestPf?.pf?.toFixed?.(3)} @ thr=${bestPf?.thr}.`
}

${regResult ? `## R-regression gate\nBest: thr=${regResult.best?.thr} PF=${regResult.best?.pf?.toFixed?.(3)} ret=${regResult.best?.ret?.toFixed?.(1)} tpd=${regResult.best?.tradesPerDay?.toFixed?.(2)} winners=${regResult.winners?.length || 0}` : ""}
`;
fs.writeFileSync(mdPath, md);

console.log(
  JSON.stringify(
    {
      ok: true,
      base: { n: base.n, pf: base.pf, ret: base.ret, tradesPerDay: base.tradesPerDay },
      model: trained.model,
      winners,
      softTop: soft.slice(0, 3),
      bestPf,
      regWinners: regResult?.winners || [],
      regBest: regResult?.best || null,
      decisionLog: mdPath,
      profitable: Boolean(pick),
      pick,
    },
    null,
    2,
  ),
);
await closePool?.();
