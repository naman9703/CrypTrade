#!/usr/bin/env node
/**
 * ETH — dissect SELL VAL when prior60d > 5% (bull60): when it wins vs bleeds.
 * Goal: surgical abstain that fixes 2021–22 without cutting 2025–26 edge.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const {
  buildVolumeProfileBacktestAdapter,
  precomputeVolumeProfile,
} = await import("../src/strategy/volumeProfileStrategy.js");
const { buildVolumeProfile, pathToNextHvn } = await import("../src/strategy/techniques/volumeProfile.js");
const {
  VOLUME_PROFILE_FREQ_ETH_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse("2020-01-01");
const toMs = Date.parse("2026-05-31");
const cfg = {
  ...VOLUME_PROFILE_FREQ_ETH_15M,
  symbol: "ETHUSDT",
  timeframe: "15m",
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: 2.5,
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  backtestSignalStartMs: fromMs,
};

const candles = await readCandles(
  "ETHUSDT",
  "15m",
  volumeProfilePadFromMs(fromMs, "15m", cfg),
  toMs,
  { market: "futures" },
);
const pre = precomputeVolumeProfile(candles);
const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, "15m") };
const sim = await runSimulation({
  strategyKey: "VOLUME_PROFILE",
  candles,
  cfg,
  gateMode: "off",
  fundingRates: [],
  startingUsdt: 100,
  timeframe: "15m",
  symbol: "ETHUSDT",
  adapters,
});
const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");

function findIdx(c, ts) {
  let lo = 0, hi = c.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(c[mid].ts);
    if (t === ts) return mid;
    if (t < ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}
function yearOf(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}
function priorPct(c, idx, bars) {
  if (idx < bars) return null;
  const a = c[idx - bars]?.close, b = c[idx]?.close;
  if (!(a > 0)) return null;
  return (b - a) / a;
}
function summarize(rows) {
  const n = rows.length;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  const wins = rows.filter((r) => r.pnl > 0).length;
  return { n, net, wr: n ? (wins / n) * 100 : 0 };
}

const rows = [];
for (const t of closed) {
  const ts = Number(t.entryTs ?? t.entry_time);
  const idx = findIdx(candles, ts);
  if (idx < 1) continue;
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "");
  if (!(side === "SELL" && setup === "val_breakdown")) continue;
  const prior60d = priorPct(candles, idx, 96 * 60);
  if (!(Number.isFinite(prior60d) && prior60d > 0.05)) continue; // bull60 only
  const prior5d = priorPct(candles, idx, 96 * 5);
  const prior20d = priorPct(candles, idx, 96 * 20);
  const vp = buildVolumeProfile(candles, idx, {
    mode: "rolling", lookback: cfg.vpLookbackBars ?? 384, bins: 50, includePriorSession: true,
  });
  const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const pathPct = Number(path?.distPct ?? 0);
  const htfSep = Number(pre?.htfSep?.[idx] ?? 0);
  const htfDown = pre?.htfDown?.[idx] === true;
  rows.push({
    year: yearOf(ts),
    pnl: Number(t.netPnl ?? 0),
    prior5d,
    prior20d,
    prior60d,
    pathPct,
    vacuum: pathPct >= 0.02,
    htfSep,
    htfDown,
  });
}

console.log("SELL VAL bull60 (prior60d>5%) total", summarize(rows));
const byY = {};
for (const r of rows) {
  byY[r.year] ??= [];
  byY[r.year].push(r);
}
console.log("\nby year:");
for (const [y, list] of Object.entries(byY).sort(([a], [b]) => a.localeCompare(b))) {
  console.log(`  ${y} ${JSON.stringify(summarize(list))}`);
}

function bucket(label, fn) {
  const m = {};
  for (const r of rows) {
    const k = fn(r);
    m[k] ??= [];
    m[k].push(r);
  }
  console.log(`\n-- ${label} --`);
  for (const [k, list] of Object.entries(m).sort((a, b) => summarize(a[1]).net - summarize(b[1]).net)) {
    const s = summarize(list);
    const byYear = {};
    for (const r of list) {
      byYear[r.year] ??= { n: 0, net: 0 };
      byYear[r.year].n += 1;
      byYear[r.year].net += r.pnl;
    }
    console.log(
      `  ${String(k).padEnd(28)} n=${String(s.n).padStart(3)} net=${s.net.toFixed(1).padStart(7)} wr=${s.wr.toFixed(0)}%  years=${JSON.stringify(byYear)}`,
    );
  }
}

bucket("vacuum", (r) => (r.vacuum ? "vacuum" : "non_vac"));
bucket("htfDown", (r) => (r.htfDown ? "htf_down" : "htf_not_down"));
bucket("htfSep", (r) => {
  if (r.htfSep >= 0.005) return "sep_ge_0.5%";
  if (r.htfSep >= 0.0025) return "sep_0.25_0.5";
  return "sep_lt_0.25%";
});
bucket("prior20d", (r) => {
  if (!(Number.isFinite(r.prior20d))) return "unk";
  if (r.prior20d > 0.05) return "p20_gt_5%";
  if (r.prior20d > 0) return "p20_0_5%";
  if (r.prior20d > -0.05) return "p20_-5_0";
  return "p20_lt_-5%";
});
bucket("prior5d", (r) => {
  if (!(Number.isFinite(r.prior5d))) return "unk";
  if (r.prior5d > 0.02) return "p5_up";
  if (r.prior5d < -0.02) return "p5_down";
  return "p5_flat";
});
bucket("prior60 buckets", (r) => {
  if (r.prior60d > 0.15) return "p60_gt_15%";
  if (r.prior60d > 0.10) return "p60_10_15%";
  return "p60_5_10%";
});

// Combined candidates
function cf(pred, label) {
  const drop = rows.filter(pred);
  const keepAll = closed.length; // just report bull60 slice impact
  const sDrop = summarize(drop);
  const sKeep = summarize(rows.filter((r) => !pred(r)));
  const byYDrop = {};
  for (const r of drop) {
    byYDrop[r.year] ??= { n: 0, net: 0 };
    byYDrop[r.year].n += 1;
    byYDrop[r.year].net += r.pnl;
  }
  console.log(`\nCF ${label}`);
  console.log(`  drop bull60-subset n=${sDrop.n} net=${sDrop.net.toFixed(1)} byYear=${JSON.stringify(byYDrop)}`);
  console.log(`  keep other bull60 n=${sKeep.n} net=${sKeep.net.toFixed(1)}`);
}

cf((r) => !r.htfDown, "drop bull60 VAL without HTF down");
cf((r) => r.htfSep < 0.005, "drop bull60 VAL when htfSep<0.5%");
cf((r) => Number(r.prior20d) > 0, "drop bull60 VAL when prior20d>0");
cf((r) => Number(r.prior5d) > 0.02, "drop bull60 VAL when prior5d>2%");
cf((r) => !r.vacuum, "drop bull60 VAL non-vacuum");
cf((r) => r.vacuum && Number(r.prior20d) > 0, "drop bull60 vacuum VAL when prior20d>0");
cf((r) => !r.htfDown || r.htfSep < 0.005, "drop bull60 VAL unless strong HTF down (sep>=0.5%)");
cf((r) => r.prior60d > 0.10, "drop bull60 VAL when prior60d>10%");

fs.writeFileSync(
  path.resolve(__dirname, ".vp-freq-eth-bull60-dissect.json"),
  JSON.stringify({ n: rows.length, total: summarize(rows), byYear: Object.fromEntries(Object.entries(byY).map(([y, xs]) => [y, summarize(xs)])) }, null, 2),
);
await closePool?.();
