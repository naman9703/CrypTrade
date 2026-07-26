#!/usr/bin/env node
/**
 * DOGE F3 — 2024-25 never-green feature discriminator under current stack.
 * Soft probes on NEW features (ADX/ATR/vol/wick/hour/prior) → ONE hard A/B.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-doge-f3-2425-feature-discrim.mjs
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

function atrPct(candles, idx, n = 14) {
  if (idx < n) return null;
  let sum = 0;
  for (let i = idx - n + 1; i <= idx; i++) {
    const h = Number(candles[i].high);
    const l = Number(candles[i].low);
    const pc = Number(candles[i - 1]?.close ?? candles[i].close);
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const c = Number(candles[idx].close);
  return c > 0 ? sum / n / c : null;
}

function barVolRatio(candles, idx, n = 20) {
  if (idx < n) return null;
  let sum = 0;
  for (let i = idx - n; i < idx; i++) sum += Number(candles[i].volume ?? 0);
  const avg = sum / n;
  if (!(avg > 0)) return null;
  return Number(candles[idx].volume ?? 0) / avg;
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
    console.log(`  ${String(k).padEnd(40)} n=${String(s.n).padStart(2)} net=${String(s.net).padStart(7)} wr=${s.wr}%`);
  }
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, STACK);
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);

const baseTrades = await run(candles, funding);
const h0 = metricsFor(baseTrades);
console.log(`\n══ STACK baseline ══`);
console.log(`n=${h0.trades} tw=${h0.tw} ret=${h0.ret}% pf=${h0.pf} cal=${h0.calmar}`);
console.log(
  `years ${Object.entries(h0.years)
    .map(([y, s]) => `${y}:${s.n}/${s.retPct}%`)
    .join(" ")}`,
);

const pre = precomputeVolumeProfile(candles);
const rows = [];
for (const t of baseTrades) {
  const ts = Number(t.entryTs);
  const idx = findIdx(candles, ts);
  if (idx < 1) continue;
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || "va_rejection";
  const vp = buildVolumeProfile(candles, idx, {
    mode: "rolling",
    lookback: 384,
    bins: 50,
    includePriorSession: true,
  });
  const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const cell = describeVpConditionCell(pre, idx, side, setup, path, STACK);
  const bar = candles[idx];
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
    prior5d: priorPct(candles, idx, 96 * 5),
    prior20d: priorPct(candles, idx, 96 * 20),
    prior60d: priorPct(candles, idx, 96 * 60),
    htfSep: Number(pre?.htfSep?.[idx] ?? NaN),
    adx: Number(pre?.adxSeries?.[idx] ?? NaN),
    atr: atrPct(candles, idx, 14),
    volRatio: barVolRatio(candles, idx, 20),
    wick: wickRatio(bar, side),
    body: bodyRatio(bar),
    hour: new Date(ts).getUTCHours(),
  });
}

const bad = rows.filter((r) => r.year === BAD);
const good = rows.filter((r) => r.year !== BAD);
const badNg = bad.filter((r) => r.neverGreen || (!r.win && r.mfePct < 0.01));
const goodWin = good.filter((r) => r.win);

console.log(`\n══ 2024-25 vs good ══`);
console.log("bad", summarize(bad), "neverGreenish", badNg.length);
console.log("good", summarize(good));

const feats = ["prior5d", "prior20d", "prior60d", "pathPct", "htfSep", "adx", "atr", "volRatio", "wick", "body"];
console.log("\nfeature means badNG vs goodWin vs goodAll:");
for (const k of feats) {
  console.log(
    `  ${k.padEnd(10)} badNG=${fmt(avg(badNg.map((r) => r[k])))} goodW=${fmt(avg(goodWin.map((r) => r[k])))} goodAll=${fmt(avg(good.map((r) => r[k])))}`,
  );
}

bucket("2024-25 cells", bad, (r) => r.cell);
bucket("2024-25 hour", bad, (r) => `h${String(r.hour).padStart(2, "0")}`);
bucket("2024-25 ADX band", bad, (r) => {
  if (!Number.isFinite(r.adx)) return "unk";
  if (r.adx < 15) return "adx<15";
  if (r.adx < 20) return "15-20";
  if (r.adx < 25) return "20-25";
  if (r.adx < 35) return "25-35";
  return "adx≥35";
});
bucket("2024-25 ATR%", bad, (r) => {
  if (!Number.isFinite(r.atr)) return "unk";
  if (r.atr < 0.004) return "atr<0.4%";
  if (r.atr < 0.006) return "0.4-0.6%";
  if (r.atr < 0.01) return "0.6-1%";
  return "atr≥1%";
});
bucket("2024-25 volRatio", bad, (r) => {
  if (!Number.isFinite(r.volRatio)) return "unk";
  if (r.volRatio < 0.7) return "vol<0.7";
  if (r.volRatio < 1.0) return "0.7-1.0";
  if (r.volRatio < 1.5) return "1.0-1.5";
  return "vol≥1.5";
});
bucket("2024-25 wick", bad, (r) => {
  if (!Number.isFinite(r.wick)) return "unk";
  if (r.wick < 0.25) return "wick<0.25";
  if (r.wick < 0.4) return "0.25-0.4";
  return "wick≥0.4";
});

// Same-cell contrast: cells that bled in 24-25 — how did they do in good years?
console.log("\n══ Same-cell contrast (bled in 24-25) ══");
const bleedCells = [...new Set(bad.filter((r) => r.pnl < 0).map((r) => r.cell))];
for (const cell of bleedCells) {
  const b = summarize(bad.filter((r) => r.cell === cell));
  const g = summarize(good.filter((r) => r.cell === cell));
  console.log(`  ${cell.padEnd(48)} bad n=${b.n} net=${b.net} | good n=${g.n} net=${g.net}`);
}

console.log("\n══ Soft probes (full tagged book) ══");
const probes = [
  { id: "drop_adx_lt_18", pred: (r) => Number.isFinite(r.adx) && r.adx < 18 },
  { id: "drop_adx_lt_20", pred: (r) => Number.isFinite(r.adx) && r.adx < 20 },
  { id: "drop_adx_lt_22", pred: (r) => Number.isFinite(r.adx) && r.adx < 22 },
  { id: "drop_adx_gte_35", pred: (r) => Number.isFinite(r.adx) && r.adx >= 35 },
  { id: "drop_atr_lt_004", pred: (r) => Number.isFinite(r.atr) && r.atr < 0.004 },
  { id: "drop_atr_lt_005", pred: (r) => Number.isFinite(r.atr) && r.atr < 0.005 },
  { id: "drop_atr_lt_006", pred: (r) => Number.isFinite(r.atr) && r.atr < 0.006 },
  { id: "drop_vol_lt_070", pred: (r) => Number.isFinite(r.volRatio) && r.volRatio < 0.7 },
  { id: "drop_vol_lt_085", pred: (r) => Number.isFinite(r.volRatio) && r.volRatio < 0.85 },
  { id: "drop_vol_lt_100", pred: (r) => Number.isFinite(r.volRatio) && r.volRatio < 1.0 },
  { id: "drop_wick_lt_025", pred: (r) => Number.isFinite(r.wick) && r.wick < 0.25 },
  { id: "drop_wick_lt_030", pred: (r) => Number.isFinite(r.wick) && r.wick < 0.3 },
  { id: "drop_body_lt_015", pred: (r) => Number.isFinite(r.body) && r.body < 0.15 },
  { id: "drop_body_lt_020", pred: (r) => Number.isFinite(r.body) && r.body < 0.2 },
  { id: "drop_hour_0_6", pred: (r) => r.hour >= 0 && r.hour < 6 },
  { id: "drop_hour_12_16", pred: (r) => r.hour >= 12 && r.hour < 16 },
  { id: "drop_BUY_atr_lt_006", pred: (r) => r.side === "BUY" && Number.isFinite(r.atr) && r.atr < 0.006 },
  { id: "drop_BUY_adx_lt_20", pred: (r) => r.side === "BUY" && Number.isFinite(r.adx) && r.adx < 20 },
  { id: "drop_BUY_vol_lt_100", pred: (r) => r.side === "BUY" && Number.isFinite(r.volRatio) && r.volRatio < 1.0 },
  {
    id: "drop_low_vol_low_atr",
    pred: (r) => Number.isFinite(r.atr) && r.atr < 0.006 && Number.isFinite(r.volRatio) && r.volRatio < 1.0,
  },
];

for (const p of probes) {
  const kept = rows.filter((r) => !p.pred(r));
  const sAll = summarize(kept);
  const sBad = summarize(kept.filter((r) => r.year === BAD));
  const sGood = summarize(kept.filter((r) => r.year !== BAD));
  const dropped = rows.length - kept.length;
  console.log(
    `${p.id.padEnd(28)} drop=${String(dropped).padStart(2)} ALL n=${sAll.n} net=${sAll.net} | 24-25 ${sBad.net} (n=${sBad.n}) | good ${sGood.net}`,
  );
}

// Hard A/B — only features that soft-look universal (improve 24-25 without crushing good)
const variants = [
  { id: "H0_stack", over: {} },
  { id: "minAdx_18", over: { vpMinAdx: 18 } },
  { id: "minAdx_20", over: { vpMinAdx: 20 } },
  { id: "minAdx_22", over: { vpMinAdx: 22 } },
  { id: "minAtr_004", over: { vpMinAtrPct: 0.004 } },
  { id: "minAtr_005", over: { vpMinAtrPct: 0.005 } },
  { id: "minAtr_006", over: { vpMinAtrPct: 0.006 } },
  { id: "minVol_085", over: { vpMinBarVolRatio: 0.85 } },
  { id: "minVol_100", over: { vpMinBarVolRatio: 1.0 } },
  { id: "wick_030", over: { vpRejectionMinWickRatio: 0.3 } },
  { id: "buy_body_20", over: { vpBuyRejectionMinBody: 0.2 } },
  { id: "minAdx_20+minAtr_005", over: { vpMinAdx: 20, vpMinAtrPct: 0.005 } },
  { id: "minAtr_005+minVol_100", over: { vpMinAtrPct: 0.005, vpMinBarVolRatio: 1.0 } },
];

console.log(`\n══ Hard A/B ══`);
const ab = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  const red = Object.entries(m.years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  const allNonNeg = red.length === 0;
  const keepGood = ["2020-21", "2021-22", "2022-23", "2023-24", "2025-26"].every((y) => {
    const a = m.years[y]?.retPct;
    const b = h0.years[y]?.retPct;
    if (a == null || b == null) return true;
    return a >= b - 12;
  });
  const fix2425 = (m.years[BAD]?.retPct ?? -999) > (h0.years[BAD]?.retPct ?? 0) + 5;
  ab.push({ id: v.id, ...m, red, allNonNeg, keepGood, fix2425 });
  console.log(
    `${v.id}\n  FULL n=${m.trades} tw=${m.tw} ret=${m.ret} pf=${m.pf} cal=${m.calmar}\n  years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}\n  RED: ${red.join(" ") || "none"} | all≥0=${allNonNeg} keepGood=${keepGood} fix2425=${fix2425}`,
  );
}

ab.sort(
  (a, b) =>
    Number(b.allNonNeg) - Number(a.allNonNeg) ||
    Number(b.fix2425 && b.keepGood) - Number(a.fix2425 && a.keepGood) ||
    b.ret - a.ret,
);
console.log("\n══ Ranked ══");
for (const r of ab) {
  console.log(
    `${r.id.padEnd(28)} all≥0=${r.allNonNeg} fix=${r.fix2425} keep=${r.keepGood} ret=${r.ret}% | 24-25=${r.years[BAD]?.retPct} 20-21=${r.years["2020-21"]?.retPct} 21-22=${r.years["2021-22"]?.retPct} 22-23=${r.years["2022-23"]?.retPct} 25-26=${r.years["2025-26"]?.retPct}`,
  );
}

const outPath = path.join(__dirname, ".vp-freq-doge-f3-2425-feature-discrim.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), h0, ab }, null, 2));
console.error("wrote", outPath);
await closePool?.();
