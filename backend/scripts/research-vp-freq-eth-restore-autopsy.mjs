#!/usr/bin/env node
/**
 * ETH VP FREQ — restore ABC lock edge, then ETH-native 2021–22 autopsy.
 *
 * User reference: ~164t / ~+483% / DD~25% on the research lock window.
 * That is the ABC + vacuum-prior5d preset on 2022-06→2026-05 — NOT BTC
 * prepared-regime allowlist (which crushed that path).
 *
 * Steps:
 *   1) Confirm restored preset matches lock-window class (~487%/166t)
 *   2) Measure 2021–22 under that same preset
 *   3) Autopsy 2021–22 losers by setup/side/features (ETH character)
 *   4) Propose ETH-native one-change candidates (no BTC cell copy)
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "ETHUSDT";
const TF = "15m";
const START = 100;

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
const { buildVolumeProfile, pathToNextHvn } = await import("../src/strategy/techniques/volumeProfile.js");
const {
  VOLUME_PROFILE_FREQ_ETH_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

function yearBucket(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}

function findIdx(candles, ts) {
  let lo = 0, hi = candles.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = Number(candles[mid].ts);
    if (t === ts) return mid;
    if (t < ts) { best = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function priorPct(candles, idx, bars) {
  if (idx < bars) return null;
  const a = candles[idx - bars]?.close, b = candles[idx]?.close;
  if (!(a > 0)) return null;
  return (b - a) / a;
}

function atrPct(candles, idx, n = 14) {
  if (idx < n) return null;
  let sum = 0;
  for (let i = idx - n + 1; i <= idx; i++) {
    const h = Number(candles[i].high), l = Number(candles[i].low);
    const pc = Number(candles[i - 1]?.close ?? candles[i].close);
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const atr = sum / n;
  const c = Number(candles[idx].close);
  return c > 0 ? atr / c : null;
}

async function load(from, to) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const padFrom = volumeProfilePadFromMs(fromMs, TF, VOLUME_PROFILE_FREQ_ETH_15M);
  const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
  let funding = [];
  try { funding = await readFundingRates(SYMBOL, padFrom, toMs); } catch { funding = []; }
  return { candles, funding, fromMs, toMs };
}

async function runWindow(from, to, patch = {}) {
  const { candles, funding, fromMs, toMs } = await load(from, to);
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
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
    backtestSignalStartMs: fromMs,
    // Explicitly clear any leftover prepared-regime knobs
    vpPreparedAllowlistOnly: false,
    vpPreparedBlockCellKeys: [],
    vpPreparedCellKeys: [],
    vpPreparedRegimeOnly: false,
    ...patch,
  };
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE", candles, cfg, gateMode: "off", fundingRates: funding,
    startingUsdt: START, timeframe: TF, adapters, symbol: SYMBOL,
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const years = {};
  let eq = START;
  for (const t of closed) {
    const pnl = Number(t.netPnl ?? 0);
    const y = yearBucket(t.entryTs ?? t.entry_time);
    years[y] ??= { n: 0, net: 0, start: eq };
    years[y].n += 1; years[y].net += pnl; eq += pnl; years[y].end = eq;
  }
  for (const r of Object.values(years)) r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  return { closed, m, years, candles, cfg, fromMs, toMs };
}

function summarize(rows) {
  const n = rows.length;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  const wins = rows.filter((r) => r.pnl > 0).length;
  return { n, net, wr: n ? (wins / n) * 100 : 0, avg: n ? net / n : 0 };
}

const fmt = (n, d = 1) => (Number.isFinite(n) ? Number(n).toFixed(d) : "—");

console.log("\n=== 1) RESTORE CONFIRM — lock window 2022-06→2026-05 ===\n");
const lock = await runWindow("2022-06-01", "2026-05-31");
console.log(
  `LOCK  N=${lock.closed.length} ret=${fmt(lock.m.totalReturnPct)}% DD=${fmt(lock.m.maxDrawdownPct)}% Calmar=${fmt(lock.m.calmar, 2)}`,
);
console.log(`  years: ${Object.entries(lock.years).map(([y, v]) => `${y}=${fmt(v.retPct)}%/${v.n}`).join("  ")}`);
const restoreOk = lock.closed.length >= 150 && lock.m.totalReturnPct >= 400 && lock.m.maxDrawdownPct <= 35;
console.log(`  restore_class_ok=${restoreOk} (target ~164t/~+483%/DD~25%)`);

console.log("\n=== 2) 2021–22 under restored baseline ===\n");
const oos = await runWindow("2021-06-01", "2022-05-31");
console.log(
  `OOS21-22  N=${oos.closed.length} ret=${fmt(oos.m.totalReturnPct)}% DD=${fmt(oos.m.maxDrawdownPct)}%`,
);

console.log("\n=== 3) FULL 2020–26 under restored baseline ===\n");
const full = await runWindow("2020-01-01", "2026-05-31");
console.log(
  `FULL  N=${full.closed.length} ret=${fmt(full.m.totalReturnPct)}% DD=${fmt(full.m.maxDrawdownPct)}%`,
);
console.log(`  years: ${Object.entries(full.years).map(([y, v]) => `${y}=${fmt(v.retPct)}%/${v.n}`).join("  ")}`);

// Autopsy 2021-22 trades from full run (same equity path) + isolated
const candles = full.candles;
const pre = precomputeVolumeProfile(candles);
const rows = [];
for (const t of full.closed) {
  const ts = Number(t.entryTs ?? t.entry_time);
  const y = yearBucket(ts);
  if (y !== "2021-22") continue;
  const idx = findIdx(candles, ts);
  if (idx < 1) continue;
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || "?";
  const prior5d = priorPct(candles, idx, 96 * 5);
  const prior20d = priorPct(candles, idx, 96 * 20);
  const prior60d = priorPct(candles, idx, 96 * 60);
  const atr = atrPct(candles, idx, 14);
  const vp = buildVolumeProfile(candles, idx, {
    mode: full.cfg.vpProfileMode ?? "rolling",
    lookback: full.cfg.vpLookbackBars ?? 384,
    bins: 50,
    includePriorSession: true,
  });
  const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const pathPct = Number(path?.distPct ?? 0);
  const isVacuum = pathPct >= 0.02;
  rows.push({
    side, setup, pnl: Number(t.netPnl ?? 0), prior5d, prior20d, prior60d, atr, pathPct, isVacuum,
    key: `${side}|${setup}|vac=${isVacuum ? 1 : 0}`,
  });
}

console.log("\n=== 4) 2021–22 AUTOPSY (restored baseline, from full run) ===\n");
console.log("baseline 21-22 rows", summarize(rows));

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
    console.log(`  ${String(k).padEnd(36)} n=${String(s.n).padStart(2)} net=${s.net.toFixed(1).padStart(7)} wr=${s.wr.toFixed(0)}%`);
  }
}

bucket("side|setup", (r) => `${r.side}|${r.setup}`);
bucket("vacuum path", (r) => (r.isVacuum ? "vacuum" : "non_vacuum"));
bucket("prior60d regime", (r) => {
  if (!(Number.isFinite(r.prior60d))) return "unk";
  if (r.prior60d > 0.05) return "bull60";
  if (r.prior60d <= -0.05) return "bear60";
  return "chop60";
});
bucket("prior20d", (r) => {
  if (!(Number.isFinite(r.prior20d))) return "unk";
  if (r.prior20d > 0.1) return "p20_hi";
  if (r.prior20d > 0) return "p20_up";
  if (r.prior20d < -0.1) return "p20_deep";
  return "p20_mild_dn";
});
bucket("ATR% regime", (r) => {
  if (!(Number.isFinite(r.atr))) return "unk";
  if (r.atr >= 0.02) return "atr_ge_2pct";
  if (r.atr >= 0.012) return "atr_1.2_2";
  return "atr_lt_1.2";
});
bucket("SELL VAL × prior60", (r) => {
  if (!(r.side === "SELL" && r.setup === "val_breakdown")) return "other";
  if (!(Number.isFinite(r.prior60d))) return "SELL_VAL|unk60";
  if (r.prior60d > -0.05 && r.prior60d <= 0.05) return "SELL_VAL|weak_chop60";
  if (r.prior60d > 0.05) return "SELL_VAL|bull60";
  return "SELL_VAL|bear60";
});
bucket("BUY VAH × vacuum × prior5d", (r) => {
  if (!(r.side === "BUY" && r.setup === "vah_breakout")) return "other";
  if (!r.isVacuum) return "BUY_VAH|structured";
  if (!(Number.isFinite(r.prior5d))) return "BUY_VAH|vac|unk5d";
  if (r.prior5d > 0.01) return "BUY_VAH|vac|chase5d";
  return "BUY_VAH|vac|pullback5d";
});

// Counterfactual harvests — candidates must be confirmed in full sim next
function cf(pred, label) {
  const drop = rows.filter(pred);
  const keep = rows.filter((r) => !pred(r));
  console.log(
    `\nCF ${label}: drop n=${drop.length} net=${summarize(drop).net.toFixed(1)} → keep n=${keep.length} net=${summarize(keep).net.toFixed(1)}`,
  );
}

cf((r) => r.side === "SELL" && r.setup === "val_breakdown" && Number(r.prior60d) > -0.05, "drop SELL VAL unless prior60d<=-5% (bear only)");
cf((r) => r.side === "SELL" && r.setup === "val_breakdown" && Number(r.prior60d) > -0.05 && Number(r.prior60d) <= 0.05, "drop SELL VAL in weak/chop60 only");
cf((r) => r.side === "BUY" && r.setup === "va_rejection", "drop BUY va_rejection");
cf((r) => r.side === "BUY" && r.setup === "vah_breakout" && r.isVacuum, "drop BUY vacuum VAH");
cf((r) => Number(r.atr) >= 0.02, "drop all when ATR%>=2%");
cf((r) => r.side === "SELL" && Number(r.prior20d) > 0.05, "drop SELL when prior20d>5%");
cf((r) => r.side === "SELL" && r.setup === "val_breakdown" && r.isVacuum && Number(r.prior60d) > -0.05, "drop SELL vacuum VAL outside bear60");

const report = {
  generatedAt: new Date().toISOString(),
  restore: {
    window: "2022-06-01→2026-05-31",
    n: lock.closed.length,
    ret: lock.m.totalReturnPct,
    dd: lock.m.maxDrawdownPct,
    calmar: lock.m.calmar,
    years: lock.years,
    restoreOk,
  },
  oos2122: {
    n: oos.closed.length,
    ret: oos.m.totalReturnPct,
    dd: oos.m.maxDrawdownPct,
  },
  full: {
    n: full.closed.length,
    ret: full.m.totalReturnPct,
    dd: full.m.maxDrawdownPct,
    years: full.years,
  },
  autopsy2122: summarize(rows),
};

fs.writeFileSync(path.resolve(__dirname, ".vp-freq-eth-restore-autopsy.json"), JSON.stringify(report, null, 2));
console.log("\nwrote .vp-freq-eth-restore-autopsy.json");
await closePool?.();
