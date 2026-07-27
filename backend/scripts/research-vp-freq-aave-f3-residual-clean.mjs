#!/usr/bin/env node
/**
 * AAVE F3 round-3 — residual year-clean on sellExt+bleed lock.
 *
 * Base: sellExtDown + BLEED_SELECT cells denied.
 *   n=54 tw=0.19 +163% cal 0.89 · red only 2023-24 −8.85% / 2025-26 −7.96%
 * Autopsy residual losers → one-change cell denies / HTF/ATR on this lock.
 *
 *   SKIP_ENSURE=1 node scripts/research-vp-freq-aave-f3-residual-clean.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "AAVEUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const START = 100;
const RESIDUAL_YEARS = new Set(["2023-24", "2025-26"]);
const GOOD_YEARS = ["2020-21", "2021-22", "2022-23", "2024-25"];

const BLEED_SELECT = [
  "SELL|va_rejection|weak_bear|vacuum",
  "SELL|va_rejection|bear_trend|vacuum",
  "BUY|va_rejection|bull_chop|vacuum",
  "BUY|va_rejection|bull_chop|structured",
  "SELL|va_rejection|bull_chop|vacuum",
];

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

const LOCK = {
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
  vpRejectionSellBlockExtendedDown: true,
  vpRejectionExtendedPriorPct: 0.05,
  vpPreparedBlockCellKeys: BLEED_SELECT,
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
  const cfg = { ...LOCK, ...over, backtestSignalStartMs: fromMs };
  if (over.vpPreparedBlockCellKeys) {
    cfg.vpPreparedBlockCellKeys = [...new Set([...(LOCK.vpPreparedBlockCellKeys || []), ...over.vpPreparedBlockCellKeys])];
  }
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

function score(m, h0) {
  const red = Object.entries(m.years)
    .filter(([, s]) => s.retPct < 0)
    .map(([y, s]) => `${y}=${s.retPct}%`);
  const allNonNeg = red.length === 0;
  const keepGood = GOOD_YEARS.every((y) => {
    const a = m.years[y]?.retPct;
    const b = h0.years[y]?.retPct;
    if (a == null && b == null) return true;
    if (a == null) return false;
    if (b == null) return a >= 0;
    return a >= Math.min(0, b) - 15 || a >= b - 25;
  });
  const nOk = m.trades >= 20; // reject ultra-thin year-clean mirages
  return { red, allNonNeg, keepGood, nOk, accept: allNonNeg && keepGood && nOk };
}

const padFrom = volumeProfilePadFromMs(fromMs, TF, LOCK);
console.error(`load ${SYMBOL}…`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
const funding = await readFundingRates(SYMBOL, padFrom, toMs).catch(() => []);
const pre = precomputeVolumeProfile(candles);
console.error(`candles=${candles.length}`);

console.log(`\n══ LOCK sellExt+bleed baseline ══`);
const baseTrades = await run(candles, funding);
const h0 = metricsFor(baseTrades);
console.log(`n=${h0.trades} tw=${h0.tw} ret=${h0.ret}% cal=${h0.calmar} dd=${h0.dd}`);
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
  const vp = buildVolumeProfile(candles, idx, { mode: "rolling", lookback: 384, bins: 50, includePriorSession: true });
  const pathPct = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const cell = describeVpConditionCell(pre, idx, side, setup, pathPct, LOCK);
  rows.push({
    year: yearBucket(ts),
    side,
    cell: cell.key,
    macro: cell.macro,
    pnl: Number(t.netPnl ?? 0),
    atr: (() => {
      const atr = Number(pre?.atrSeries?.[idx]);
      const c = Number(candles[idx]?.close);
      return atr > 0 && c > 0 ? atr / c : null;
    })(),
    htfSep: Number(pre?.htfSep?.[idx] ?? NaN),
  });
}

console.log("\n══ Residual red-year cells ══");
for (const y of ["2023-24", "2025-26"]) {
  const yr = rows.filter((r) => r.year === y);
  console.log(`\n-- ${y} ${JSON.stringify(summarize(yr))} --`);
  const by = {};
  for (const r of yr) {
    by[r.cell] ??= [];
    by[r.cell].push(r);
  }
  for (const [k, list] of Object.entries(by).sort((a, b) => summarize(a[1]).net - summarize(b[1]).net)) {
    const s = summarize(list);
    const goodNet = summarize(rows.filter((r) => GOOD_YEARS.includes(r.year) && r.cell === k)).net;
    console.log(`  ${k.padEnd(48)} n=${s.n} net=${s.net} | goodNet=${goodNet}`);
  }
}

// Candidate residual denies: cells that bleed in residual years
const residualLosers = rows.filter((r) => RESIDUAL_YEARS.has(r.year) && r.pnl < 0);
const cellCandidates = [...new Set(residualLosers.map((r) => r.cell))];
console.log("\ncandidate residual denies:", cellCandidates.join(", "));

const variants = [
  { id: "H0_sellExt_bleed", over: {} },
  { id: "htf_0035", over: { vpMinHtfSepPct: 0.0035 } },
  { id: "htf_0040", over: { vpMinHtfSepPct: 0.004 } },
  { id: "htf_0045", over: { vpMinHtfSepPct: 0.0045 } },
  { id: "atr_008", over: { vpMinAtrPct: 0.008 } },
  { id: "atr_010", over: { vpMinAtrPct: 0.01 } },
  { id: "htf35+atr008", over: { vpMinHtfSepPct: 0.0035, vpMinAtrPct: 0.008 } },
  { id: "buyBody_25", over: { vpBuyRejectionMinBody: 0.25 } },
];

for (const cell of cellCandidates) {
  variants.push({ id: `deny_${cell.replace(/\|/g, "_").slice(0, 40)}`, over: { vpPreparedBlockCellKeys: [cell] } });
}

// Stack top bleeders (up to 3 worst by residual net)
const residualByCell = {};
for (const r of residualLosers) {
  residualByCell[r.cell] ??= 0;
  residualByCell[r.cell] += r.pnl;
}
const worst = Object.entries(residualByCell)
  .sort((a, b) => a[1] - b[1])
  .slice(0, 3)
  .map(([k]) => k);
if (worst.length) {
  variants.push({ id: "deny_worst2", over: { vpPreparedBlockCellKeys: worst.slice(0, 2) } });
  variants.push({ id: "deny_worst3", over: { vpPreparedBlockCellKeys: worst } });
  variants.push({
    id: "htf35+deny_worst2",
    over: { vpMinHtfSepPct: 0.0035, vpPreparedBlockCellKeys: worst.slice(0, 2) },
  });
  variants.push({
    id: "atr008+deny_worst2",
    over: { vpMinAtrPct: 0.008, vpPreparedBlockCellKeys: worst.slice(0, 2) },
  });
}

console.log(`\n══ Residual hard A/B (${variants.length}) ══`);
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
      .join(" ")}\n  RED: ${sc.red.join(" ") || "none"} | clean=${sc.allNonNeg} keep=${sc.keepGood} nOk=${sc.nOk} → ${sc.accept ? "ACCEPT" : "reject"}`,
  );
}

ab.sort(
  (a, b) =>
    Number(b.accept) - Number(a.accept) ||
    Number(b.allNonNeg) - Number(a.allNonNeg) ||
    Number(b.nOk) - Number(a.nOk) ||
    b.calmar - a.calmar ||
    b.ret - a.ret,
);

console.log("\n══ Ranked ══");
for (const r of ab) {
  console.log(
    `${r.id.padEnd(42)} accept=${r.accept} clean=${r.allNonNeg} n=${r.trades} tw=${r.tw} ret=${r.ret}% cal=${r.calmar} | ${r.red.join(",") || "none"}`,
  );
}

const best = ab.find((r) => r.accept) || ab.find((r) => r.allNonNeg && r.nOk);
const outPath = path.join(__dirname, ".vp-freq-aave-f3-residual-clean.json");
fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), h0, residualByCell, worst, ab, best: best ? { id: best.id, over: best.over, tw: best.tw, ret: best.ret, calmar: best.calmar, years: best.years } : null }, null, 2));
console.error("wrote", outPath);
console.log(`\n══ Best: ${best?.id ?? "none"} ══`);
await closePool?.();
