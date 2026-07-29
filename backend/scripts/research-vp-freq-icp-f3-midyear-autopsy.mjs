#!/usr/bin/env node
/**
 * NEAR VP FREQ — F3 va_rejection Phase 0→1 deep start (coin-native).
 *
 * Phase 0 screen: F3 FULL +79% / OOS +54% but mid-years red:
 *   22-23 −6.5% · 23-24 −15% · 24-25 −9.8% (20-21/21-22/25-26 green)
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-icp-f3-midyear-autopsy.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "ICPUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const START = 100;
const BAD_YEARS = new Set(["2023-24", "2025-26"]);
const GOOD_YEARS = ["2022-23", "2024-25"];

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
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

/** True Phase 0 baseline — FREQ CORE + F3 only. No DOGE/ETH locks. */
const CORE = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  vpPlaybook: "CUSTOM",
  vpMinAdx: 0.0001,
  symbol: SYMBOL,
  timeframe: TF,
  vpAllowedSetups: ["va_rejection"],
  vpNoveltyEnabled: false,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: 2.5,
  riskPerTradeUnit: "PCT",
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
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
  const cfg = { ...CORE, ...over, backtestSignalStartMs: fromMs };
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

function summarize(rows) {
  const n = rows.length;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  const wins = rows.filter((r) => r.pnl > 0).length;
  return { n, net: +net.toFixed(2), wr: n ? +((wins / n) * 100).toFixed(1) : 0 };
}

function avg(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function fmt(n) {
  return Number.isFinite(n) ? n.toFixed(4) : "—";
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
    console.log(`  ${String(k).padEnd(48)} n=${String(s.n).padStart(2)} net=${String(s.net).padStart(7)} wr=${s.wr}%`);
  }
}

function score(m, h0) {
  const red = Object.entries(m.years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  const allNonNeg = red.length === 0;
  const keepGood = GOOD_YEARS.every((y) => {
    const a = m.years[y]?.retPct;
    const b = h0.years[y]?.retPct;
    if (a == null || b == null) return true;
    return a >= b - 15;
  });
  const midSum = ["2022-23", "2023-24", "2024-25"].reduce((s, y) => s + (m.years[y]?.retPct ?? 0), 0);
  const midH0 = ["2022-23", "2023-24", "2024-25"].reduce((s, y) => s + (h0.years[y]?.retPct ?? 0), 0);
  const midFix = midSum > midH0 + 10;
  const accept = allNonNeg && keepGood;
  return { red, allNonNeg, keepGood, midFix, accept };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, CORE);
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
console.error(`candles=${candles.length} funding=${funding.length}`);
const pre = precomputeVolumeProfile(candles);

console.log(`\n══ ICP F3 Phase 0 baseline ══`);
const baseTrades = await run(candles, funding);
const h0 = metricsFor(baseTrades);
console.log(`n=${h0.trades} tw=${h0.tw} ret=${h0.ret}% pf=${h0.pf} cal=${h0.calmar} dd=${h0.dd}`);
console.log(
  `years ${Object.entries(h0.years)
    .map(([y, s]) => `${y}:${s.n}/${s.retPct}%`)
    .join(" ")}`,
);

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
  const cell = describeVpConditionCell(pre, idx, side, setup, path, CORE);
  const mfePct = Number(t.mfePct ?? 0);
  rows.push({
    year: yearBucket(ts),
    side,
    setup,
    pnl: Number(t.netPnl ?? 0),
    win: Number(t.netPnl ?? 0) > 0,
    neverGreen: Number(t.netPnl ?? 0) < 0 && mfePct < 0.005,
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
    atr: atrPctFromPre(pre, candles, idx),
  });
}

const bad = rows.filter((r) => BAD_YEARS.has(r.year));
const good = rows.filter((r) => GOOD_YEARS.includes(r.year));
const badL = bad.filter((r) => !r.win);
const goodW = good.filter((r) => r.win);

console.log(`\n══ Mid-red years vs good ══`);
console.log("bad mid", summarize(bad), "neverGreen", bad.filter((r) => r.neverGreen).length);
console.log("good", summarize(good));
console.log("\nfeature means badLosers vs goodWinners:");
for (const k of ["prior5d", "prior20d", "prior60d", "pathPct", "htfSep", "adx", "atr"]) {
  console.log(`  ${k.padEnd(10)} badL=${fmt(avg(badL.map((r) => r[k])))} goodW=${fmt(avg(goodW.map((r) => r[k])))}`);
}

for (const y of ["2022-23", "2023-24", "2024-25", "2025-26", "2021-22"]) {
  const yr = rows.filter((r) => r.year === y);
  console.log(`\n══ ${y} cells ══`, summarize(yr));
  bucket(`${y} cells`, yr, (r) => r.cell);
  bucket(`${y} side×macro`, yr, (r) => `${r.side}|${r.macro}`);
}

console.log("\n══ Same-cell contrast (bled in mid-red) ══");
const bleedCells = [...new Set(bad.filter((r) => r.pnl < 0).map((r) => r.cell))];
for (const cell of bleedCells) {
  const b = summarize(bad.filter((r) => r.cell === cell));
  const g = summarize(good.filter((r) => r.cell === cell));
  if (b.n < 2 && b.net > -5) continue;
  console.log(`  ${cell.padEnd(48)} bad n=${b.n} net=${b.net} | good n=${g.n} net=${g.net}`);
}

console.log("\n══ Soft probes (full book) ══");
const probes = [
  { id: "drop_BUY", pred: (r) => r.side === "BUY" },
  { id: "drop_SELL", pred: (r) => r.side === "SELL" },
  { id: "drop_BUY_bull", pred: (r) => r.side === "BUY" && String(r.macro).startsWith("bull") },
  { id: "drop_SELL_bull", pred: (r) => r.side === "SELL" && String(r.macro).startsWith("bull") },
  { id: "drop_vacuum", pred: (r) => r.isVacuum },
  { id: "drop_BUY_vacuum", pred: (r) => r.side === "BUY" && r.isVacuum },
  { id: "drop_SELL_vacuum", pred: (r) => r.side === "SELL" && r.isVacuum },
  { id: "drop_atr_lt_006", pred: (r) => Number.isFinite(r.atr) && r.atr < 0.006 },
  { id: "drop_atr_lt_008", pred: (r) => Number.isFinite(r.atr) && r.atr < 0.008 },
  { id: "drop_atr_lt_010", pred: (r) => Number.isFinite(r.atr) && r.atr < 0.01 },
  { id: "drop_htf_lt_002", pred: (r) => Number.isFinite(r.htfSep) && Math.abs(r.htfSep) < 0.002 },
  { id: "drop_htf_lt_0035", pred: (r) => Number.isFinite(r.htfSep) && Math.abs(r.htfSep) < 0.0035 },
  { id: "drop_htf_lt_005", pred: (r) => Number.isFinite(r.htfSep) && Math.abs(r.htfSep) < 0.005 },
  { id: "drop_prior60_gt_100", pred: (r) => Number.isFinite(r.prior60d) && r.prior60d > 1.0 },
  { id: "drop_BUY_prior60_gt_50", pred: (r) => r.side === "BUY" && Number.isFinite(r.prior60d) && r.prior60d > 0.5 },
  { id: "drop_BUY_prior60_gt_100", pred: (r) => r.side === "BUY" && Number.isFinite(r.prior60d) && r.prior60d > 1.0 },
  { id: "drop_prior20_neg", pred: (r) => Number.isFinite(r.prior20d) && r.prior20d < 0 },
  { id: "drop_SELL_ext_down", pred: (r) => r.side === "SELL" && Number.isFinite(r.prior20d) && r.prior20d < -0.05 },
  { id: "drop_adx_lt_20", pred: (r) => Number.isFinite(r.adx) && r.adx < 20 },
  { id: "drop_neverGreen", pred: (r) => r.neverGreen },
];

const soft = [];
for (const p of probes) {
  const kept = rows.filter((r) => !p.pred(r));
  const sAll = summarize(kept);
  const mid = summarize(kept.filter((r) => BAD_YEARS.has(r.year)));
  const g = summarize(kept.filter((r) => GOOD_YEARS.includes(r.year)));
  // soft year path
  let eq = START;
  const yRet = {};
  for (const r of kept) {
    yRet[r.year] ??= { start: eq, end: eq };
    eq += r.pnl;
    yRet[r.year].end = eq;
  }
  const redY = Object.entries(yRet)
    .filter(([, s]) => s.start && (s.end - s.start) / s.start < 0)
    .map(([y]) => y);
  soft.push({ id: p.id, drop: rows.length - kept.length, sAll, mid, g, redY });
  console.log(
    `${p.id.padEnd(28)} drop=${String(rows.length - kept.length).padStart(2)} ALL net=${sAll.net} mid=${mid.net} good=${g.net} redY=${redY.join(",") || "none"}`,
  );
}

// Hard A/B — coin-native first levers (do NOT copy DOGE locks wholesale)
const variants = [
  { id: "H0_F3", over: {} },
  { id: "htfAlign_0015", over: { vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0015 } },
  { id: "htfAlign_0035", over: { vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0035 } },
  { id: "htfAlign_005", over: { vpRequireHtfAlign: true, vpMinHtfSepPct: 0.005 } },
  { id: "minAtr_006", over: { vpMinAtrPct: 0.006 } },
  { id: "minAtr_008", over: { vpMinAtrPct: 0.008 } },
  { id: "minAtr_010", over: { vpMinAtrPct: 0.01 } },
  { id: "buyPrior60_100", over: { vpBuyRejectionMaxPrior60dPct: 1.0 } },
  { id: "buyPrior60_050", over: { vpBuyRejectionMaxPrior60dPct: 0.5 } },
  { id: "sellExtDown", over: { vpRejectionSellBlockExtendedDown: true, vpRejectionExtendedPriorPct: 0.05 } },
  { id: "buyBody_20", over: { vpBuyRejectionMinBody: 0.2 } },
  { id: "buyBody_25", over: { vpBuyRejectionMinBody: 0.25 } },
  { id: "sellBearHtf_005", over: { vpRejectionSellBearMinHtfSepPct: 0.005 } },
  { id: "minAdx_18", over: { vpMinAdx: 18 } },
  { id: "minAdx_22", over: { vpMinAdx: 22 } },
  // Stacks only after single-change evidence — light candidates from soft
  {
    id: "htf15+minAtr008",
    over: { vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0015, vpMinAtrPct: 0.008 },
  },
  {
    id: "htf15+buyPrior60_100",
    over: { vpRequireHtfAlign: true, vpMinHtfSepPct: 0.0015, vpBuyRejectionMaxPrior60dPct: 1.0 },
  },
  {
    id: "htf15+atr008+buyP60",
    over: {
      vpRequireHtfAlign: true,
      vpMinHtfSepPct: 0.0015,
      vpMinAtrPct: 0.008,
      vpBuyRejectionMaxPrior60dPct: 1.0,
    },
  },
];

console.log(`\n══ Hard A/B ══`);
const ab = [];
for (const v of variants) {
  console.error(`run ${v.id}`);
  const trades = await run(candles, funding, v.over);
  const m = metricsFor(trades);
  const sc = score(m, h0);
  ab.push({ id: v.id, over: v.over, ...m, ...sc });
  console.log(
    `${v.id}\n  n=${m.trades} tw=${m.tw} ret=${m.ret}% cal=${m.calmar} pf=${m.pf}\n  years ${Object.entries(m.years)
      .map(([y, s]) => `${y}:${s.retPct}%/${s.n}`)
      .join(" ")}\n  RED: ${sc.red.join(" ") || "none"} | yearClean=${sc.allNonNeg} keepGood=${sc.keepGood} midFix=${sc.midFix} → ${sc.accept ? "ACCEPT" : "reject"}`,
  );
}

ab.sort(
  (a, b) =>
    Number(b.accept) - Number(a.accept) ||
    Number(b.allNonNeg) - Number(a.allNonNeg) ||
    Number(b.keepGood && b.midFix) - Number(a.keepGood && a.midFix) ||
    b.ret - a.ret,
);

console.log("\n══ Ranked ══");
for (const r of ab) {
  console.log(
    `${r.id.padEnd(24)} accept=${r.accept} clean=${r.allNonNeg} keep=${r.keepGood} midFix=${r.midFix} tw=${r.tw} ret=${r.ret}% cal=${r.calmar} | ${r.red.join(",") || "none"}`,
  );
}

const best = ab.find((r) => r.accept) || ab.find((r) => r.allNonNeg && r.keepGood) || ab.find((r) => r.midFix && r.keepGood);

const outPath = path.join(__dirname, ".vp-freq-icp-f3-midyear-autopsy.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      symbol: SYMBOL,
      h0,
      soft: soft.map((s) => ({ id: s.id, drop: s.drop, all: s.sAll, mid: s.mid, good: s.g, redY: s.redY })),
      ab,
      best: best
        ? { id: best.id, over: best.over, tw: best.tw, ret: best.ret, calmar: best.calmar, years: best.years, red: best.red }
        : null,
    },
    null,
    2,
  ),
);
console.error("wrote", outPath);
console.log(`\n══ Best: ${best?.id ?? "none yet — continue residual"} ══`);
await closePool?.();
