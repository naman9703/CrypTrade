#!/usr/bin/env node
/**
 * DOGE F3 — escalate ATR floor for 2024-25 year-clean, then residual autopsy.
 *
 * Prior discrim: soft fill-bar vol is INVALID (va_rejection already requires
 * vpRejectionMinVolRatio≥1.0). Hard minVol no-ops. Hard minAtr_006 best partial
 * (−4.87% still red). ATR band autopsy: only atr≥1% paid in 24-25.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-doge-f3-2425-atr-residual.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "DOGEUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const START = 100;
const BAD = "2024-25";
const GOOD_YEARS = ["2020-21", "2021-22", "2022-23", "2023-24", "2025-26"];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const {
  buildVolumeProfileBacktestAdapter,
  precomputeVolumeProfile,
} = await import("../src/strategy/volumeProfileStrategy.js");
const { describeVpConditionCell } = await import("../src/strategy/vpConditionCell.js");
const { buildVolumeProfile, pathToNextHvn } = await import("../src/strategy/techniques/volumeProfile.js");
const {
  VOLUME_PROFILE_BASE,
  VOLUME_PROFILE_FREQ_CORE,
  VOLUME_PROFILE_FREQ_DOGE_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const STACK = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  ...VOLUME_PROFILE_FREQ_DOGE_15M,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  vpNoveltyEnabled: false,
};

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function findIdx(candles, ts) {
  let lo = 0,
    hi = candles.length - 1,
    best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(candles[mid].ts);
    if (t === ts) return mid;
    if (t < ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

function priorPct(candles, idx, bars) {
  if (idx < bars) return null;
  const a = candles[idx - bars]?.close;
  const b = candles[idx]?.close;
  if (!(a > 0)) return null;
  return (b - a) / a;
}

function atrPctFromPre(pre, candles, idx) {
  const atr = Number(pre?.atrSeries?.[idx]);
  const c = Number(candles[idx]?.close);
  if (!(atr > 0) || !(c > 0)) return null;
  return atr / c;
}

function engineVolRatio(pre, idx, n = 20) {
  if (!pre?.volumes || idx < 1) return null;
  const volSlice = pre.volumes.slice(Math.max(0, idx - n), idx);
  const volAvg = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  if (!(volAvg > 0)) return null;
  return pre.volumes[idx] / volAvg;
}

function wickRatio(bar, side) {
  const h = Number(bar.high);
  const l = Number(bar.low);
  const o = Number(bar.open);
  const c = Number(bar.close);
  const range = h - l;
  if (!(range > 0)) return null;
  if (side === "BUY") return (Math.min(o, c) - l) / range;
  return (h - Math.max(o, c)) / range;
}

function bodyRatio(bar) {
  const h = Number(bar.high);
  const l = Number(bar.low);
  const range = h - l;
  if (!(range > 0)) return null;
  return Math.abs(Number(bar.close) - Number(bar.open)) / range;
}

function metricsFor(trades) {
  let eq = START;
  const curve = [{ ts: fromMs, equity: eq }];
  for (const t of trades) {
    eq += Number(t.netPnl ?? 0);
    curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
  }
  const m = computeAllMetrics({ trades, equityCurve: curve, tf: TF, startingEquity: START });
  const years = {};
  eq = START;
  for (const t of trades) {
    const y = yearBucket(t.entryTs);
    years[y] ??= { n: 0, start: eq };
    years[y].n += 1;
    eq += Number(t.netPnl ?? 0);
    years[y].end = eq;
  }
  for (const y of Object.values(years)) {
    y.retPct = y.start ? +(((y.end - y.start) / y.start) * 100).toFixed(2) : 0;
  }
  const weeks = Math.max(1, (toMs - fromMs) / (7 * 864e5));
  return {
    trades: trades.length,
    tw: +(trades.length / weeks).toFixed(2),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    years,
  };
}

async function run(candles, funding, over = {}) {
  const cfg = { ...STACK, ...over, backtestSignalStartMs: fromMs };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) },
    symbol: SYMBOL,
  });
  return (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
}

function avg(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(4) : "—";
}

function summarize(rows) {
  const n = rows.length;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  const wins = rows.filter((r) => r.pnl > 0).length;
  return { n, net: +net.toFixed(2), wr: n ? +((wins / n) * 100).toFixed(1) : 0 };
}

function scoreVariant(m, h0) {
  const red = Object.entries(m.years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  const allNonNeg = red.length === 0;
  const keepGood = GOOD_YEARS.every((y) => {
    const a = m.years[y]?.retPct;
    const b = h0.years[y]?.retPct;
    if (a == null || b == null) return true;
    return a >= b - 12;
  });
  const fix2425 = (m.years[BAD]?.retPct ?? -999) > (h0.years[BAD]?.retPct ?? 0) + 5;
  return { red, allNonNeg, keepGood, fix2425 };
}

function tagRows(trades, candles, pre) {
  const rows = [];
  for (const t of trades) {
    const ts = Number(t.entryTs);
    const idx = findIdx(candles, ts);
    if (idx < 1) continue;
    // Prefer signal bar (= entry bar or prior) where engine ATR/vol gates apply.
    const sigIdx = idx;
    const side = String(t.direction ?? t.side).toUpperCase();
    const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || "va_rejection";
    const vp = buildVolumeProfile(candles, sigIdx, {
      mode: "rolling",
      lookback: 384,
      bins: 50,
      includePriorSession: true,
    });
    const path = vp ? pathToNextHvn(candles[sigIdx].close, side, vp) : null;
    const cell = describeVpConditionCell(pre, sigIdx, side, setup, path, STACK);
    const bar = candles[sigIdx];
    const mfePct = Number(t.mfePct ?? 0);
    const neverGreen = Number(t.netPnl ?? 0) < 0 && mfePct < 0.005;
    rows.push({
      year: yearBucket(ts),
      side,
      pnl: Number(t.netPnl ?? 0),
      win: Number(t.netPnl ?? 0) > 0,
      neverGreen,
      mfePct,
      cell: cell.key,
      macro: cell.macro,
      pathLabel: cell.path,
      isVacuum: Number(path?.distPct ?? 0) >= 0.02,
      pathPct: Number(path?.distPct ?? 0),
      prior5d: priorPct(candles, sigIdx, 96 * 5),
      prior20d: priorPct(candles, sigIdx, 96 * 20),
      prior60d: priorPct(candles, sigIdx, 96 * 60),
      htfSep: Number(pre?.htfSep?.[sigIdx] ?? NaN),
      adx: Number(pre?.adxSeries?.[sigIdx] ?? NaN),
      atr: atrPctFromPre(pre, candles, sigIdx),
      volRatio: engineVolRatio(pre, sigIdx),
      wick: wickRatio(bar, side),
      body: bodyRatio(bar),
      hour: new Date(ts).getUTCHours(),
      exitReason: String(t.exitReason ?? ""),
    });
  }
  return rows;
}

function bucket(label, rows, fn) {
  const m = {};
  for (const r of rows) {
    const k = fn(r);
    m[k] ??= [];
    m[k].push(r);
  }
  console.log(`\n-- ${label} --`);
  for (const [k, list] of Object.entries(m).sort((a, b) => summarize(a[1]).net - summarize(b[1]).net)) {
    const s = summarize(list);
    console.log(`  ${String(k).padEnd(44)} n=${String(s.n).padStart(2)} net=${String(s.net).padStart(7)} wr=${s.wr}%`);
  }
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, STACK);
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);
const pre = precomputeVolumeProfile(candles);

const atrLadder = [
  { id: "H0_stack", over: {} },
  { id: "minAtr_006", over: { vpMinAtrPct: 0.006 } },
  { id: "minAtr_007", over: { vpMinAtrPct: 0.007 } },
  { id: "minAtr_008", over: { vpMinAtrPct: 0.008 } },
  { id: "minAtr_009", over: { vpMinAtrPct: 0.009 } },
  { id: "minAtr_010", over: { vpMinAtrPct: 0.01 } },
  { id: "minAtr_012", over: { vpMinAtrPct: 0.012 } },
];

console.log(`\n══ ATR ladder hard A/B ══`);
const ab = [];
let h0 = null;
let bestClean = null;
let bestPartial = null;

for (const v of atrLadder) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  if (!h0) h0 = m;
  const sc = scoreVariant(m, h0);
  const row = { id: v.id, over: v.over, ...m, ...sc };
  ab.push(row);
  console.log(
    `${v.id}\n  FULL n=${m.trades} tw=${m.tw} ret=${m.ret} pf=${m.pf} cal=${m.calmar}\n  years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}\n  RED: ${sc.red.join(" ") || "none"} | all≥0=${sc.allNonNeg} keepGood=${sc.keepGood}`,
  );
  if (sc.allNonNeg && sc.keepGood && (!bestClean || m.ret > bestClean.ret)) bestClean = row;
  if (!sc.allNonNeg && sc.fix2425 && sc.keepGood && (!bestPartial || (m.years[BAD]?.retPct ?? -999) > (bestPartial.years[BAD]?.retPct ?? -999))) {
    bestPartial = row;
  }
}

ab.sort(
  (a, b) =>
    Number(b.allNonNeg) - Number(a.allNonNeg) ||
    Number(b.keepGood) - Number(a.keepGood) ||
    (b.years[BAD]?.retPct ?? -999) - (a.years[BAD]?.retPct ?? -999) ||
    b.ret - a.ret,
);

console.log("\n══ Ranked ATR ladder ══");
for (const r of ab) {
  console.log(
    `${r.id.padEnd(14)} all≥0=${r.allNonNeg} keep=${r.keepGood} ret=${r.ret}% | 24-25=${r.years[BAD]?.retPct}% n=${r.years[BAD]?.n} | tw=${r.tw}`,
  );
}

const residualBase = bestClean ?? bestPartial ?? ab.find((r) => r.id === "minAtr_006") ?? ab[0];
console.log(`\n══ Residual autopsy under ${residualBase.id} ══`);
const residualTrades = await run(candles, funding, residualBase.over ?? {});
const rows = tagRows(residualTrades, candles, pre);
const bad = rows.filter((r) => r.year === BAD);
const good = rows.filter((r) => r.year !== BAD);
const badNg = bad.filter((r) => r.neverGreen || (!r.win && r.mfePct < 0.01));
const goodWin = good.filter((r) => r.win);

console.log("bad", summarize(bad), "neverGreenish", badNg.length);
console.log("good", summarize(good));
console.log("\nfeature means badNG vs goodWin vs goodAll (engine ATR/vol):");
for (const k of ["prior5d", "prior20d", "prior60d", "pathPct", "htfSep", "adx", "atr", "volRatio", "wick", "body"]) {
  console.log(
    `  ${k.padEnd(10)} badNG=${fmt(avg(badNg.map((r) => r[k])))} goodW=${fmt(avg(goodWin.map((r) => r[k])))} goodAll=${fmt(avg(good.map((r) => r[k])))}`,
  );
}

bucket("2024-25 cells", bad, (r) => r.cell);
bucket("2024-25 side×macro", bad, (r) => `${r.side}|${r.macro}|${r.pathLabel}`);
bucket("2024-25 ATR%", bad, (r) => {
  if (!Number.isFinite(r.atr)) return "unk";
  if (r.atr < 0.008) return "atr<0.8%";
  if (r.atr < 0.01) return "0.8-1%";
  if (r.atr < 0.012) return "1-1.2%";
  return "atr≥1.2%";
});
bucket("2024-25 engine vol", bad, (r) => {
  if (!Number.isFinite(r.volRatio)) return "unk";
  if (r.volRatio < 1.2) return "vol<1.2";
  if (r.volRatio < 1.5) return "1.2-1.5";
  if (r.volRatio < 2.0) return "1.5-2.0";
  return "vol≥2.0";
});
bucket("2024-25 exit", bad, (r) => r.exitReason || "unk");

console.log("\n══ Same-cell contrast (bled in 24-25 under residual base) ══");
const bleedCells = [...new Set(bad.filter((r) => r.pnl < 0).map((r) => r.cell))];
for (const cell of bleedCells) {
  const b = summarize(bad.filter((r) => r.cell === cell));
  const g = summarize(good.filter((r) => r.cell === cell));
  console.log(`  ${cell.padEnd(48)} bad n=${b.n} net=${b.net} | good n=${g.n} net=${g.net}`);
}

console.log("\n══ Soft probes on residual book (engine features) ══");
const probes = [
  { id: "drop_BUY", pred: (r) => r.side === "BUY" },
  { id: "drop_BUY_bull_trend", pred: (r) => r.side === "BUY" && r.macro === "bull_trend" },
  { id: "drop_BUY_vacuum", pred: (r) => r.side === "BUY" && r.isVacuum },
  { id: "drop_SELL_bull", pred: (r) => r.side === "SELL" && String(r.macro).startsWith("bull") },
  { id: "drop_SELL_bear_struct", pred: (r) => r.cell === "SELL|va_rejection|bear_trend|structured" },
  { id: "drop_BUY_bear_tight", pred: (r) => r.cell === "BUY|va_rejection|bear_trend|tight" },
  { id: "drop_path_lt_02", pred: (r) => Number.isFinite(r.pathPct) && r.pathPct < 0.02 },
  { id: "drop_path_lt_025", pred: (r) => Number.isFinite(r.pathPct) && r.pathPct < 0.025 },
  { id: "drop_htf_lt_004", pred: (r) => Number.isFinite(r.htfSep) && Math.abs(r.htfSep) < 0.004 },
  { id: "drop_htf_lt_005", pred: (r) => Number.isFinite(r.htfSep) && Math.abs(r.htfSep) < 0.005 },
  { id: "drop_prior20_neg", pred: (r) => Number.isFinite(r.prior20d) && r.prior20d < 0 },
  { id: "drop_BUY_prior20_neg", pred: (r) => r.side === "BUY" && Number.isFinite(r.prior20d) && r.prior20d < 0 },
  { id: "drop_vol_lt_15", pred: (r) => Number.isFinite(r.volRatio) && r.volRatio < 1.5 },
  { id: "drop_vol_lt_20", pred: (r) => Number.isFinite(r.volRatio) && r.volRatio < 2.0 },
  { id: "drop_wick_gte_04", pred: (r) => Number.isFinite(r.wick) && r.wick >= 0.4 },
  { id: "drop_body_lt_03", pred: (r) => Number.isFinite(r.body) && r.body < 0.3 },
  { id: "drop_hour_12_16", pred: (r) => r.hour >= 12 && r.hour < 16 },
  {
    id: "drop_BUY_bull_vac",
    pred: (r) => r.side === "BUY" && r.macro === "bull_trend" && r.isVacuum,
  },
  {
    id: "drop_low_path_BUY",
    pred: (r) => r.side === "BUY" && Number.isFinite(r.pathPct) && r.pathPct < 0.025,
  },
];

const soft = [];
for (const p of probes) {
  const kept = rows.filter((r) => !p.pred(r));
  const sAll = summarize(kept);
  const sBad = summarize(kept.filter((r) => r.year === BAD));
  const sGood = summarize(kept.filter((r) => r.year !== BAD));
  const dropped = rows.length - kept.length;
  const flipsBad = sBad.net >= 0 && summarize(bad).net < 0;
  soft.push({ id: p.id, dropped, sAll, sBad, sGood, flipsBad });
  console.log(
    `${p.id.padEnd(28)} drop=${String(dropped).padStart(2)} ALL n=${sAll.n} net=${sAll.net} | 24-25 ${sBad.net} (n=${sBad.n}) | good ${sGood.net}${flipsBad ? " ★FLIP" : ""}`,
  );
}

// Hard follow-ups: only soft probes that flip 24-25 without crushing good net >25%
const hardFollow = [{ id: `${residualBase.id}_base`, over: { ...(residualBase.over ?? {}) } }];
const flipSoft = soft.filter((s) => s.flipsBad && s.sGood.net >= summarize(good).net * 0.75);
for (const s of flipSoft.slice(0, 6)) {
  // Map soft ids to hard knobs where we have them
  if (s.id === "drop_BUY_bull_trend" || s.id === "drop_BUY_bull_vac") {
    hardFollow.push({
      id: `${residualBase.id}+buyRejBlockBullTrend`,
      over: { ...(residualBase.over ?? {}), vpBuyRejectionBlockBullTrend: true },
    });
  }
  if (s.id === "drop_vol_lt_15") {
    hardFollow.push({
      id: `${residualBase.id}+rejVol_15`,
      over: { ...(residualBase.over ?? {}), vpRejectionMinVolRatio: 1.5 },
    });
  }
  if (s.id === "drop_vol_lt_20") {
    hardFollow.push({
      id: `${residualBase.id}+rejVol_20`,
      over: { ...(residualBase.over ?? {}), vpRejectionMinVolRatio: 2.0 },
    });
  }
  if (s.id === "drop_htf_lt_004") {
    hardFollow.push({
      id: `${residualBase.id}+htf_004`,
      over: { ...(residualBase.over ?? {}), vpMinHtfSepPct: 0.004 },
    });
  }
  if (s.id === "drop_htf_lt_005") {
    hardFollow.push({
      id: `${residualBase.id}+htf_005`,
      over: { ...(residualBase.over ?? {}), vpMinHtfSepPct: 0.005 },
    });
  }
  if (s.id === "drop_path_lt_02" || s.id === "drop_path_lt_025" || s.id === "drop_low_path_BUY") {
    hardFollow.push({
      id: `${residualBase.id}+breakoutPath_025`,
      over: { ...(residualBase.over ?? {}), vpBreakoutMinPathPct: 0.025 },
    });
  }
  if (s.id === "drop_BUY") {
    hardFollow.push({
      id: `${residualBase.id}+sellOnly`,
      over: { ...(residualBase.over ?? {}), vpAllowedSides: ["SELL"] },
    });
  }
}

// Always test a few residual-targeted hard knobs regardless of soft
hardFollow.push(
  {
    id: `${residualBase.id}+buyRejBlockBullTrend`,
    over: { ...(residualBase.over ?? {}), vpBuyRejectionBlockBullTrend: true },
  },
  {
    id: `${residualBase.id}+rejVol_15`,
    over: { ...(residualBase.over ?? {}), vpRejectionMinVolRatio: 1.5 },
  },
  {
    id: `${residualBase.id}+rejVol_18`,
    over: { ...(residualBase.over ?? {}), vpRejectionMinVolRatio: 1.8 },
  },
  {
    id: `${residualBase.id}+buyBody_25`,
    over: { ...(residualBase.over ?? {}), vpBuyRejectionMinBody: 0.25 },
  },
  {
    id: `${residualBase.id}+buyCloseStr_55`,
    over: { ...(residualBase.over ?? {}), vpBuyRejectionMinCloseStrength: 0.55 },
  },
  {
    id: `${residualBase.id}+sellBearHtf_006`,
    over: { ...(residualBase.over ?? {}), vpRejectionSellBearMinHtfSepPct: 0.006 },
  },
);

// Dedupe by id
const seen = new Set();
const hardUnique = hardFollow.filter((v) => {
  if (seen.has(v.id)) return false;
  seen.add(v.id);
  return true;
});

console.log(`\n══ Hard residual A/B under ${residualBase.id} ══`);
const hardAb = [];
for (const v of hardUnique) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  const sc = scoreVariant(m, h0);
  hardAb.push({ id: v.id, ...m, ...sc });
  console.log(
    `${v.id}\n  FULL n=${m.trades} tw=${m.tw} ret=${m.ret} pf=${m.pf} cal=${m.calmar}\n  years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}\n  RED: ${sc.red.join(" ") || "none"} | all≥0=${sc.allNonNeg} keepGood=${sc.keepGood}`,
  );
}

hardAb.sort(
  (a, b) =>
    Number(b.allNonNeg) - Number(a.allNonNeg) ||
    Number(b.keepGood) - Number(a.keepGood) ||
    (b.years[BAD]?.retPct ?? -999) - (a.years[BAD]?.retPct ?? -999) ||
    b.ret - a.ret,
);

console.log("\n══ Ranked hard residual ══");
for (const r of hardAb) {
  console.log(
    `${r.id.padEnd(36)} all≥0=${r.allNonNeg} keep=${r.keepGood} ret=${r.ret}% | 24-25=${r.years[BAD]?.retPct}% | RED:${r.red.join(",") || "none"}`,
  );
}

const yearClean = [...ab, ...hardAb].filter((r) => r.allNonNeg);
console.log(`\n══ Year-clean candidates: ${yearClean.length} ══`);
for (const r of yearClean) {
  console.log(`  ${r.id} ret=${r.ret}% tw=${r.tw} cal=${r.calmar}`);
}

const outPath = path.join(__dirname, ".vp-freq-doge-f3-2425-atr-residual.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note: "Vol soft from prior discrim invalid — rejection already minVol≥1.0 at signal",
      h0,
      atrLadder: ab,
      residualBaseId: residualBase.id,
      soft,
      hardAb,
      yearClean: yearClean.map((r) => ({ id: r.id, ret: r.ret, tw: r.tw, calmar: r.calmar, years: r.years })),
    },
    null,
    2,
  ),
);
console.error("wrote", outPath);
await closePool?.();
