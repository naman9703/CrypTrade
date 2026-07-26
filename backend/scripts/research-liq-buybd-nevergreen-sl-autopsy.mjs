#!/usr/bin/env node
/**
 * Residual never-green SL autopsy on BUYBD+comp≥0.75.
 *
 * Never-green = exitReason sl/stop AND peak MFE < 0.25R (entry-time risk).
 * These dominate loss $ and are not exit-saveable — find causal ENTRY-TIME
 * separators vs winners / other losers, then soft-screen only.
 *
 * Usage (backend/): SKIP_ENSURE=1 node scripts/research-liq-buybd-nevergreen-sl-autopsy.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "BNBUSDT";
const TF = "15m";
const FROM = Date.parse("2023-07-01");
const TO = Date.parse("2026-07-24");
const PAD = 150 * 864e5;
const NG_MFE_R = 0.25;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { liqRangeCompressionAt } = await import("../src/strategy/techniques/liq/marketState.js");

function rOf(t) {
  let risk = Number(t.initialRiskUsd ?? 0);
  if (!(risk > 0)) {
    const entry = Number(t.entryPrice ?? t.entryFill);
    const stop = Number(t.initialSlPrice ?? t.slPrice ?? t.stopPrice);
    const qty = Math.abs(Number(t.qty) || 0);
    if (Number.isFinite(entry) && Number.isFinite(stop) && stop > 0 && qty > 0) {
      risk = Math.abs(entry - stop) * qty;
    }
  }
  return risk > 0 ? Number(t.netPnl) / risk : null;
}

/** Peak MFE in R: runner stores mfe as fractional price move. */
function mfeR(t) {
  const entry = Number(t.entryPrice ?? t.entryFill);
  const stop = Number(t.initialSlPrice ?? t.slPrice ?? t.stopPrice);
  const mfeFrac = Number(t.mfePct ?? t.mfe);
  if (!(entry > 0 && stop > 0 && Number.isFinite(mfeFrac))) return null;
  const riskFrac = Math.abs(entry - stop) / entry;
  if (!(riskFrac > 0)) return null;
  return mfeFrac / riskFrac;
}

function halfKey(ts) {
  const d = new Date(Number(ts));
  return `${d.getUTCFullYear()}H${d.getUTCMonth() < 6 ? 1 : 2}`;
}

function buildDailySeries(candles) {
  const days = [];
  let cur = null;
  for (const c of candles) {
    const d = new Date(Number(c.ts));
    const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    if (!cur || cur.key !== key) {
      if (cur) days.push(cur);
      cur = { key, open: +c.open, high: +c.high, low: +c.low, close: +c.close };
    } else {
      cur.high = Math.max(cur.high, +c.high);
      cur.low = Math.min(cur.low, +c.low);
      cur.close = +c.close;
    }
  }
  if (cur) days.push(cur);
  return days;
}

function dayIdxAt(days, ts) {
  const d = new Date(Number(ts));
  const key = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let lo = 0;
  let hi = days.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (days[mid].key <= key) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function marketFeaturesAt(days, ts) {
  const i = dayIdxAt(days, ts) - 1;
  if (i < 40) return null;
  const closeAt = (k) => days[k].close;
  const ret = (n) => (i - n >= 0 ? (closeAt(i) - closeAt(i - n)) / closeAt(i - n) : null);
  const dRets = [];
  for (let k = Math.max(1, i - 365); k <= i; k++) {
    dRets.push((days[k].close - days[k - 1].close) / days[k - 1].close);
  }
  const std = (arr) => {
    if (arr.length < 5) return null;
    const m = arr.reduce((a, b) => a + b, 0) / arr.length;
    return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / arr.length);
  };
  const vol30 = std(dRets.slice(-30));
  const windows = [];
  for (let end = 30; end <= dRets.length; end += 5) {
    const w = std(dRets.slice(end - 30, end));
    if (w != null) windows.push(w);
  }
  const volPctile =
    vol30 != null && windows.length > 5
      ? windows.filter((w) => w <= vol30).length / windows.length
      : null;
  const range = (k) => days[k].high - days[k].low;
  const avgRange = (n) => {
    let s = 0;
    let c = 0;
    for (let k = Math.max(0, i - n + 1); k <= i; k++) {
      s += range(k) / days[k].close;
      c++;
    }
    return c ? s / c : null;
  };
  const r14 = avgRange(14);
  const r100 = avgRange(100);
  let hi60 = -Infinity;
  let lo60 = Infinity;
  for (let k = Math.max(0, i - 59); k <= i; k++) {
    hi60 = Math.max(hi60, days[k].high);
    lo60 = Math.min(lo60, days[k].low);
  }
  const posInRange60 = hi60 > lo60 ? (closeAt(i) - lo60) / (hi60 - lo60) : null;
  return {
    ret7: ret(7),
    ret30: ret(30),
    ret90: ret(90),
    volPctile,
    compression: r14 != null && r100 != null && r100 > 0 ? r14 / r100 : null,
    posInRange60,
  };
}

function mean(arr) {
  const v = arr.filter((x) => x != null && Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function rMetrics(list) {
  const rs = list.map((t) => t.r).filter((x) => x != null && Number.isFinite(x));
  const pos = rs.filter((x) => x > 0).reduce((a, b) => a + b, 0);
  const neg = rs.filter((x) => x < 0).reduce((a, b) => a + b, 0);
  return {
    n: rs.length,
    meanR: rs.length ? +(rs.reduce((a, b) => a + b, 0) / rs.length).toFixed(3) : null,
    pfR: neg < 0 ? +(pos / -neg).toFixed(3) : pos > 0 ? 99 : 0,
    sumR: +rs.reduce((a, b) => a + b, 0).toFixed(2),
  };
}

const candles = await readCandles(SYMBOL, TF, FROM - PAD, TO, { market: "futures" });
const funding = await readFundingRates(SYMBOL, FROM - PAD, TO).catch(() => []);
const days = buildDailySeries(candles);

// bar index lookup for compression-at-entry
const tsToIdx = new Map();
for (let i = 0; i < candles.length; i++) tsToIdx.set(Number(candles[i].ts), i);

clearIntradayAdapterCache?.();
let cfg = {
  ...INTRADAY_PRO_LIQ_BNB_PREPARED_MIT_BUYBD_15M,
  maxDailyLoss: 0,
  riskConsecutiveLossLimit: 0,
  backtestSignalStartMs: FROM,
};
cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);
const adapter = buildIntradayBacktestAdapter(candles, cfg, TF);
process.stderr.write("FULL sim…\n");
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

const trades = (sim.trades ?? [])
  .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
  .filter((t) => Number(t.entryTs) >= FROM && Number(t.entryTs) < TO)
  .map((t) => {
    const ctx = t.liqContext || {};
    const feats = ctx.features || {};
    const ms = feats.marketState || {};
    const r = rOf(t);
    const mf = mfeR(t);
    const er = String(t.exitReason ?? "");
    const isSl = er === "sl" || er === "stop" || er === "be";
    const neverGreen = isSl && mf != null && mf < NG_MFE_R && r != null && r < 0;
    const entryIdx = tsToIdx.get(Number(t.entryBarTs ?? t.entryTs)) ?? tsToIdx.get(Number(t.entryTs));
    const engComp =
      entryIdx != null ? liqRangeCompressionAt(candles, entryIdx) : null;
    const utcH = new Date(Number(t.entryTs)).getUTCHours();
    return {
      entryTs: t.entryTs,
      half: halfKey(t.entryTs),
      side: String(t.direction || t.side || "").toUpperCase(),
      exitReason: er,
      r,
      mfeR: mf,
      neverGreen,
      cohort: neverGreen ? "never_green_sl" : r != null && r > 0 ? "winner" : "other_loser",
      levelType: ctx.levelType ?? feats.levelType ?? null,
      regime: ms.regime ?? null,
      daySituation: ms.daySituation ?? null,
      sessionNarrative: ms.sessionNarrative ?? null,
      adx: ms.adx != null ? Number(ms.adx) : null,
      atrPct: ms.atrPct != null ? Number(ms.atrPct) : null,
      impulseAtr: feats.impulseAtr ?? feats.displacement?.impulseAtr ?? null,
      momentum: feats.momentum ?? feats.displacement?.momentum ?? null,
      wickBody: feats.wickBodyRatio ?? feats.sweep?.wickBodyRatio ?? null,
      volRatio: feats.volRatio ?? feats.sweep?.volRatio ?? null,
      engComp,
      utcH,
      mkt: marketFeaturesAt(days, t.entryTs),
    };
  });

const ng = trades.filter((t) => t.cohort === "never_green_sl");
const win = trades.filter((t) => t.cohort === "winner");
const oth = trades.filter((t) => t.cohort === "other_loser");

console.log(`n=${trades.length} never_green_sl=${ng.length} winners=${win.length} other_losers=${oth.length}`);
console.log(`NG sumR=${rMetrics(ng).sumR} | win sumR=${rMetrics(win).sumR} | other sumR=${rMetrics(oth).sumR}`);
console.log(`FULL ${JSON.stringify(rMetrics(trades))}`);

const numKeys = [
  "adx",
  "atrPct",
  "impulseAtr",
  "momentum",
  "wickBody",
  "volRatio",
  "engComp",
  "utcH",
  "ret30",
  "ret90",
  "volPctile",
  "compression",
  "posInRange60",
];

function featVal(t, k) {
  if (k.startsWith("ret") || k === "volPctile" || k === "compression" || k === "posInRange60") {
    return t.mkt?.[k] ?? null;
  }
  return t[k];
}

console.log("\n══ Feature means: never-green vs winners vs other losers ══");
console.log(
  "  feature".padEnd(16) +
    "NG".padStart(10) +
    "WIN".padStart(10) +
    "OTH".padStart(10) +
    "  Δ(NG−WIN)".padStart(12),
);
for (const k of numKeys) {
  const a = mean(ng.map((t) => Number(featVal(t, k))));
  const b = mean(win.map((t) => Number(featVal(t, k))));
  const c = mean(oth.map((t) => Number(featVal(t, k))));
  const d = a != null && b != null ? a - b : null;
  console.log(
    `  ${k.padEnd(14)}${String(a != null ? a.toFixed(3) : "n/a").padStart(10)}${String(b != null ? b.toFixed(3) : "n/a").padStart(10)}${String(c != null ? c.toFixed(3) : "n/a").padStart(10)}${String(d != null ? d.toFixed(3) : "n/a").padStart(12)}`,
  );
}

// categorical
console.log("\n══ Categorical rates ══");
for (const key of ["side", "levelType", "regime", "daySituation", "sessionNarrative"]) {
  const counts = (rows) => {
    const m = new Map();
    for (const t of rows) {
      const v = String(t[key] ?? "null");
      m.set(v, (m.get(v) || 0) + 1);
    }
    return m;
  };
  const ngC = counts(ng);
  const winC = counts(win);
  const keys = new Set([...ngC.keys(), ...winC.keys()]);
  console.log(`  ${key}:`);
  for (const v of [...keys].sort()) {
    const nr = ng.length ? ((ngC.get(v) || 0) / ng.length) * 100 : 0;
    const wr = win.length ? ((winC.get(v) || 0) / win.length) * 100 : 0;
    if (nr < 5 && wr < 5) continue;
    console.log(
      `    ${String(v).padEnd(18)} NG ${nr.toFixed(0).padStart(3)}%  WIN ${wr.toFixed(0).padStart(3)}%  Δ ${ (nr - wr).toFixed(0)}pp`,
    );
  }
}

// Quintiles of features among ALL trades → never-green rate + meanR
console.log("\n══ Feature quintiles → NG rate + meanR ══");
for (const k of ["adx", "engComp", "volPctile", "ret30", "ret90", "posInRange60", "impulseAtr", "utcH"]) {
  const rows = trades
    .map((t) => ({ v: Number(featVal(t, k)), t }))
    .filter((x) => Number.isFinite(x.v));
  if (rows.length < 50) continue;
  rows.sort((a, b) => a.v - b.v);
  const q = 5;
  const parts = [];
  for (let i = 0; i < q; i++) {
    const s = rows.slice(Math.floor((i * rows.length) / q), Math.floor(((i + 1) * rows.length) / q));
    const ngRate = s.filter((x) => x.t.neverGreen).length / s.length;
    const mR = mean(s.map((x) => x.t.r));
    parts.push(
      `Q${i + 1} ng=${(ngRate * 100).toFixed(0)}% R=${mR >= 0 ? "+" : ""}${mR.toFixed(2)}(${s[0].v.toFixed(2)}..)`,
    );
  }
  console.log(`  ${k.padEnd(14)} ${parts.join("  ")}`);
}

// Soft screens: drop when rule true (causal entry-time only)
console.log("\n══ Soft stand-down (drop when true) — causal only ══");
const base = rMetrics(trades);
const rules = [
  ["adx>40", (t) => Number(t.adx ?? 0) > 40],
  ["adx>45", (t) => Number(t.adx ?? 0) > 45],
  ["adx>50", (t) => Number(t.adx ?? 0) > 50],
  ["regime=TREND_UP", (t) => t.regime === "TREND_UP"],
  ["regime=TREND_DOWN", (t) => t.regime === "TREND_DOWN"],
  ["daySit=breakdown", (t) => t.daySituation === "breakdown"],
  ["daySit=breakout", (t) => t.daySituation === "breakout"],
  ["session=off_hours", (t) => t.sessionNarrative === "off_hours"],
  ["session=asia", (t) => t.sessionNarrative === "asia_accum"],
  ["utcH<7", (t) => t.utcH < 7],
  ["utcH>=16", (t) => t.utcH >= 16],
  ["ret90<-0.20", (t) => (t.mkt?.ret90 ?? 0) < -0.2],
  ["ret30<-0.12", (t) => (t.mkt?.ret30 ?? 0) < -0.12],
  ["ret30>0.20", (t) => (t.mkt?.ret30 ?? 0) > 0.2],
  ["volPctile>0.85", (t) => (t.mkt?.volPctile ?? 0) > 0.85],
  ["volPctile<0.25", (t) => (t.mkt?.volPctile ?? 1) < 0.25],
  ["posInRange60>0.85", (t) => (t.mkt?.posInRange60 ?? 0.5) > 0.85],
  ["posInRange60<0.20", (t) => (t.mkt?.posInRange60 ?? 0.5) < 0.2],
  ["engComp>1.4", (t) => (t.engComp ?? 1) > 1.4],
  ["SELL only drop", (t) => t.side === "SELL"],
  ["BUY only drop", (t) => t.side === "BUY"],
  ["level=session*", (t) => String(t.levelType ?? "").includes("asian") || String(t.levelType ?? "").includes("session")],
];

const screen = [];
for (const [id, drop] of rules) {
  const kept = trades.filter((t) => !drop(t));
  const dropped = trades.filter((t) => drop(t));
  const m = rMetrics(kept);
  const ngKept = kept.filter((t) => t.neverGreen).length;
  const ngDrop = dropped.filter((t) => t.neverGreen).length;
  const keptPct = +((kept.length / trades.length) * 100).toFixed(0);
  const oos = rMetrics(kept.filter((t) => t.entryTs >= Date.parse("2025-07-01")));
  const hold = rMetrics(kept.filter((t) => t.entryTs < Date.parse("2024-07-01")));
  const halves = {};
  for (const h of [...new Set(kept.map((t) => t.half))].sort()) {
    halves[h] = rMetrics(kept.filter((t) => t.half === h));
  }
  const redHalves = Object.entries(halves).filter(([, x]) => x.n >= 10 && (x.meanR ?? 0) < -0.05).length;
  const ngCutPct = ng.length ? +((ngDrop / ng.length) * 100).toFixed(0) : 0;
  const interesting =
    keptPct >= 70 &&
    m.meanR != null &&
    m.meanR > base.meanR + 0.03 &&
    (oos.meanR ?? -9) > 0 &&
    (hold.meanR ?? -9) > -0.05 &&
    redHalves === 0;
  screen.push({
    id,
    keptPct,
    meanR: m.meanR,
    oosMeanR: oos.meanR,
    holdMeanR: hold.meanR,
    ngCutPct,
    redHalves,
    interesting,
  });
  console.log(
    `  ${id.padEnd(22)}${String(keptPct + "%").padStart(5)} meanR ${base.meanR}→${m.meanR} NG−${String(ngCutPct + "%").padStart(4)} OOS ${oos.meanR} HOLD ${hold.meanR} redH=${redHalves}${interesting ? " ★" : ""}`,
  );
}

const stars = screen.filter((s) => s.interesting).sort((a, b) => b.meanR - a.meanR);
console.log(`\nInteresting soft rules: ${stars.length ? stars.map((s) => s.id).join(", ") : "NONE"}`);

fs.writeFileSync(
  path.join(__dirname, ".liq-buybd-nevergreen-sl-autopsy.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      ngMfeR: NG_MFE_R,
      n: trades.length,
      cohorts: {
        never_green_sl: rMetrics(ng),
        winner: rMetrics(win),
        other_loser: rMetrics(oth),
        full: rMetrics(trades),
      },
      screen,
      stars: stars.map((s) => s.id),
      trades,
    },
    null,
    2,
  ),
);
console.log("Wrote .liq-buybd-nevergreen-sl-autopsy.json");
await closePool?.();
