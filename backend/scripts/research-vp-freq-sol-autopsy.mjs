#!/usr/bin/env node
/**
 * SOL VP FREQ — Phase 1 autopsy on FREQ-core baseline.
 * Cell / feature buckets for VAH + VAL (main PnL drivers).
 *
 * Usage: SKIP_ENSURE=1 node scripts/research-vp-freq-sol-autopsy.mjs
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "SOLUSDT";
const TF = "15m";
const FROM = process.env.FROM || "2021-01-01";
const TO = process.env.TO || "2026-05-31";

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
  classifyVpMacro,
  classifyVpPath,
  buildVpConditionCellKey,
  vpMacroBullAt,
} = await import("../src/strategy/vpConditionCell.js");
const {
  VOLUME_PROFILE_BASE,
  VOLUME_PROFILE_FREQ_CORE,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const cfg = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: SYMBOL,
  timeframe: TF,
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: 2.5,
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  backtestSignalStartMs: Date.parse(FROM),
};

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const padFrom = volumeProfilePadFromMs(fromMs, TF, cfg);

process.stderr.write(`Loading candles…\n`);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
process.stderr.write(`candles=${candles.length} simulating…\n`);
const pre = precomputeVolumeProfile(candles, cfg);
const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) };
const sim = await runSimulation({
  strategyKey: "VOLUME_PROFILE",
  candles,
  cfg,
  gateMode: "off",
  fundingRates: [],
  startingUsdt: 100,
  timeframe: TF,
  symbol: SYMBOL,
  adapters,
  costModelOverride: {
    leverage: 12,
    openFeeRate: 0.0004,
    closeFeeRate: 0.0004,
    slippagePct: 0.0005,
  },
});

function findIdx(c, ts) {
  let lo = 0,
    hi = c.length - 1,
    best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(c[mid].ts);
    if (t === ts) return mid;
    if (t < ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}
function yearOf(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear(),
    m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}
function priorPct(c, idx, bars) {
  if (idx < bars) return null;
  const a = c[idx - bars]?.close,
    b = c[idx]?.close;
  if (!(a > 0)) return null;
  return (b - a) / a;
}
function summarize(rows) {
  const n = rows.length;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  const wins = rows.filter((r) => r.pnl > 0).length;
  return { n, net: +net.toFixed(2), wr: n ? +((wins / n) * 100).toFixed(1) : 0 };
}

const closed = (sim.trades ?? []).filter((t) => {
  const ts = Number(t.entryTs ?? t.entry_time);
  return String(t.exitReason ?? "") !== "tp1_partial" && ts >= fromMs && ts < toMs;
});

const rows = [];
for (const t of closed) {
  const ts = Number(t.entryTs ?? t.entry_time);
  const idx = findIdx(candles, ts);
  if (idx < 1) continue;
  const side = String(t.direction ?? t.side ?? "").toUpperCase();
  const setup = String(t.vpSetup || t.entryReason || t.reason || "").replace(/^vp_/, "");
  const prior5d = priorPct(candles, idx, 96 * 5);
  const prior20d = priorPct(candles, idx, 96 * 20);
  const prior60d = priorPct(candles, idx, 96 * 60);
  const vp = buildVolumeProfile(candles, idx, {
    mode: "rolling",
    lookback: cfg.vpLookbackBars ?? 384,
    bins: 50,
    includePriorSession: true,
  });
  const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const pathPct = Number(path?.distPct ?? 0);
  const vacuum = pathPct >= 0.02;
  const macroBull = vpMacroBullAt(pre, idx, 0.02);
  const macro = classifyVpMacro(prior60d, macroBull, -0.05);
  const pathL = classifyVpPath(pathPct, 0.02);
  const cell = buildVpConditionCellKey(side, setup, macro, pathL);
  const htfSep = Number(pre?.htfSep?.[idx] ?? NaN);
  rows.push({
    year: yearOf(ts),
    side,
    setup,
    pnl: Number(t.netPnl ?? 0),
    prior5d,
    prior20d,
    prior60d,
    pathPct,
    vacuum,
    macro,
    cell,
    htfSep,
    mfe: Number(t.mfePct ?? t.maxFavorableExcursionPct ?? NaN),
    mae: Number(t.maePct ?? t.maxAdverseExcursionPct ?? NaN),
  });
}

console.log(`\n══ SOL autopsy ══ ${FROM}→${TO}  trades=${rows.length}\n`);
console.log("by setup:", JSON.stringify(
  Object.fromEntries(
    [...new Set(rows.map((r) => r.setup))].map((s) => [s, summarize(rows.filter((r) => r.setup === s))]),
  ),
));

function printBuckets(label, subset, fn) {
  const m = {};
  for (const r of subset) {
    const k = fn(r);
    m[k] ??= [];
    m[k].push(r);
  }
  console.log(`\n-- ${label} (n=${subset.length} net=${summarize(subset).net}) --`);
  const sorted = Object.entries(m).sort((a, b) => summarize(a[1]).net - summarize(b[1]).net);
  for (const [k, list] of sorted) {
    const s = summarize(list);
    const byY = {};
    for (const r of list) {
      byY[r.year] ??= [];
      byY[r.year].push(r);
    }
    const yStr = Object.entries(byY)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([y, ys]) => `${y}:${summarize(ys).n}/${summarize(ys).net}`)
      .join(" ");
    console.log(`  ${k.padEnd(42)} n=${String(s.n).padStart(3)} net=${String(s.net).padStart(8)} wr=${s.wr}% | ${yStr}`);
  }
}

const vah = rows.filter((r) => r.setup === "vah_breakout" || r.setup.includes("vah"));
const val = rows.filter((r) => r.setup === "val_breakdown" || r.setup.includes("val"));

printBuckets("ALL cells", rows, (r) => r.cell);
printBuckets("VAH by cell", vah, (r) => r.cell);
printBuckets("VAL by cell", val, (r) => r.cell);

printBuckets("VAH path", vah, (r) => (r.vacuum ? "vacuum≥2%" : "structured<2%"));
printBuckets("VAH prior5d", vah, (r) => {
  const p = r.prior5d;
  if (!Number.isFinite(p)) return "na";
  if (p > 0.08) return "chase>8%";
  if (p > 0.01) return "mild>1%";
  if (p > -0.01) return "flat±1%";
  return "pullback<-1%";
});
printBuckets("VAH prior60d", vah, (r) => {
  const p = r.prior60d;
  if (!Number.isFinite(p)) return "na";
  if (p > 0.05) return "bull60>5%";
  if (p > -0.05) return "flat60±5%";
  return "bear60<-5%";
});

printBuckets("VAL path", val, (r) => (r.vacuum ? "vacuum≥2%" : "structured<2%"));
printBuckets("VAL prior5d", val, (r) => {
  const p = r.prior5d;
  if (!Number.isFinite(p)) return "na";
  if (p > 0.05) return "rally>5%";
  if (p > 0.01) return "mild>1%";
  if (p > -0.01) return "flat±1%";
  return "down<-1%";
});
printBuckets("VAL prior20d", val, (r) => {
  const p = r.prior20d;
  if (!Number.isFinite(p)) return "na";
  if (p > 0.02) return "up>2%";
  if (p > -0.05) return "mid";
  if (p > -0.1) return "weak_bear -5..-10";
  return "extended<-10%";
});
printBuckets("VAL prior60d", val, (r) => {
  const p = r.prior60d;
  if (!Number.isFinite(p)) return "na";
  if (p > 0.05) return "bull60>5%";
  if (p > -0.05) return "flat60±5%";
  return "bear60<-5%";
});
printBuckets("VAL macro", val, (r) => r.macro);

const out = {
  from: FROM,
  to: TO,
  n: rows.length,
  bySetup: Object.fromEntries(
    [...new Set(rows.map((r) => r.setup))].map((s) => [s, summarize(rows.filter((r) => r.setup === s))]),
  ),
  rows: rows.map((r) => ({
    ...r,
    prior5d: r.prior5d != null ? +r.prior5d.toFixed(4) : null,
    prior20d: r.prior20d != null ? +r.prior20d.toFixed(4) : null,
    prior60d: r.prior60d != null ? +r.prior60d.toFixed(4) : null,
    pathPct: +r.pathPct.toFixed(4),
    htfSep: Number.isFinite(r.htfSep) ? +r.htfSep.toFixed(5) : null,
  })),
};
const outPath = path.join(__dirname, ".vp-freq-sol-autopsy.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nWrote ${outPath}`);
await closePool?.();
