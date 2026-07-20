#!/usr/bin/env node
/**
 * ETH VP FREQ — autopsy residual 2021-22 bleed inside the locked allowlist.
 * Find a measurable within-cell feature that separates winners from losers.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = "2020-01-01";
const TO = "2026-05-31";
const SYMBOL = "ETHUSDT";
const TF = "15m";

const ALLOW = [
  "SELL|val_breakdown|bull_chop|vacuum",
  "BUY|vah_breakout|bull_trend|structured",
  "BUY|vah_breakout|weak_bear|vacuum",
  "SELL|val_breakdown|bear_trend|tight",
  "BUY|va_rejection|bull_trend|tight",
  "SELL|val_breakdown|bull_trend|vacuum",
  "BUY|vah_breakout|bull_chop|structured",
  "SELL|val_breakdown|bear_trend|structured",
  "SELL|val_breakdown|bear_trend|vacuum",
];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const {
  buildVolumeProfileBacktestAdapter,
  precomputeVolumeProfile,
} = await import("../src/strategy/volumeProfileStrategy.js");
const {
  buildVolumeProfile,
  pathToNextHvn,
} = await import("../src/strategy/techniques/volumeProfile.js");
const {
  classifyVpMacro,
  classifyVpPath,
  buildVpConditionCellKey,
  vpMacroBullAt,
} = await import("../src/strategy/vpConditionCell.js");
const {
  VOLUME_PROFILE_FREQ_ETH_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

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
function yearOf(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  return m >= 5 ? `${y}-${String(y + 1).slice(2)}` : `${y - 1}-${String(y).slice(2)}`;
}
function hourUtc(ts) { return new Date(Number(ts)).getUTCHours(); }

const cfg = {
  ...VOLUME_PROFILE_FREQ_ETH_15M,
  symbol: SYMBOL,
  timeframe: TF,
  marketMode: "FUTURES",
  strategyMode: "MANUAL",
  manualStrategy: "VOLUME_PROFILE",
  riskPerTrade: 2.5,
  futuresLeverage: 12,
  backtestPositionSizing: "RISK_AT_SL",
  slippagePct: 0.0005,
  maxDailyLoss: 0,
  backtestSignalStartMs: fromMs,
  vpPreparedAllowlistOnly: true,
  vpPreparedCellKeys: ALLOW,
};

const candles = await readCandles(SYMBOL, TF, volumeProfilePadFromMs(fromMs, TF, cfg), toMs, { market: "futures" });
const pre = precomputeVolumeProfile(candles);
const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) };
const sim = await runSimulation({
  strategyKey: "VOLUME_PROFILE", candles, cfg, gateMode: "off", fundingRates: [],
  startingUsdt: 100, timeframe: TF, symbol: SYMBOL, adapters,
});
const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");

const rows = [];
for (const t of closed) {
  const ts = Number(t.entryTs ?? t.entry_time);
  const idx = findIdx(candles, ts);
  if (idx < 1) continue;
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || "?";
  const prior5d = priorPct(candles, idx, 96 * 5);
  const prior20d = priorPct(candles, idx, 96 * 20);
  const prior60d = priorPct(candles, idx, 96 * 60);
  const macroBull = vpMacroBullAt(pre, idx, cfg);
  const vp = buildVolumeProfile(candles, idx, {
    mode: cfg.vpProfileMode ?? "rolling", lookback: cfg.vpLookbackBars ?? 384, bins: 50, includePriorSession: true,
  });
  const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const macro = classifyVpMacro(prior60d, macroBull, -0.05);
  const pathL = classifyVpPath(path?.distPct ?? null, 0.02);
  const key = buildVpConditionCellKey(side, setup, macro, pathL);
  rows.push({
    ts, year: yearOf(ts), side, setup, key, pnl: Number(t.netPnl ?? 0),
    prior5d, prior20d, prior60d, pathPct: path?.distPct ?? null,
    hour: hourUtc(ts), atr: Number(pre?.atr?.[idx] ?? NaN),
  });
}

const bad = rows.filter((r) => r.year === "2021-22");
const good = rows.filter((r) => ["2024-25", "2025-26"].includes(r.year));

function bucket(list, fn, label) {
  const m = {};
  for (const r of list) {
    const k = fn(r);
    m[k] ??= { n: 0, net: 0, wins: 0 };
    m[k].n += 1;
    m[k].net += r.pnl;
    if (r.pnl > 0) m[k].wins += 1;
  }
  console.log(`\n== ${label} ==`);
  for (const [k, v] of Object.entries(m).sort((a, b) => a[1].net - b[1].net)) {
    console.log(`  ${String(k).padEnd(28)} n=${String(v.n).padStart(3)} net=${v.net.toFixed(1).padStart(7)} wr=${((v.wins / v.n) * 100).toFixed(0)}%`);
  }
  return m;
}

console.log(`\nallowlisted trades: total=${rows.length} bad2021-22=${bad.length} goodLate=${good.length}`);
console.log(`2021-22 net=${bad.reduce((s, r) => s + r.pnl, 0).toFixed(1)}`);

bucket(bad, (r) => r.key, "2021-22 by cell");
bucket(bad, (r) => r.side, "2021-22 by side");
bucket(bad, (r) => {
  if (!(Number.isFinite(r.prior5d))) return "p5_unk";
  if (r.prior5d > 0.05) return "p5_hi";
  if (r.prior5d > 0.01) return "p5_mid";
  if (r.prior5d < -0.05) return "p5_wash";
  return "p5_flat";
}, "2021-22 by prior5d");
bucket(bad, (r) => {
  if (!(Number.isFinite(r.prior20d))) return "p20_unk";
  if (r.prior20d > 0.1) return "p20_hi";
  if (r.prior20d > 0) return "p20_up";
  if (r.prior20d < -0.1) return "p20_deep";
  return "p20_mild_dn";
}, "2021-22 by prior20d");
bucket(bad, (r) => {
  const h = r.hour;
  if (h >= 0 && h < 8) return "asia";
  if (h >= 8 && h < 16) return "eu";
  return "us";
}, "2021-22 by session");
bucket(bad, (r) => `${r.side}|${r.setup}`, "2021-22 by side|setup");

// Compare same feature on good late years
bucket(good, (r) => {
  if (!(Number.isFinite(r.prior5d))) return "p5_unk";
  if (r.prior5d > 0.05) return "p5_hi";
  if (r.prior5d > 0.01) return "p5_mid";
  if (r.prior5d < -0.05) return "p5_wash";
  return "p5_flat";
}, "2024-26 by prior5d");
bucket(good, (r) => `${r.side}|${r.setup}`, "2024-26 by side|setup");
bucket(good, (r) => {
  if (!(Number.isFinite(r.prior20d))) return "p20_unk";
  if (r.prior20d > 0.1) return "p20_hi";
  if (r.prior20d > 0) return "p20_up";
  if (r.prior20d < -0.1) return "p20_deep";
  return "p20_mild_dn";
}, "2024-26 by prior20d");

// Counterfactual: drop feature buckets that bleed in 21-22 but keep late edge
function cf(pred, label) {
  const kept = rows.filter((r) => !pred(r));
  const byY = {};
  for (const r of kept) {
    byY[r.year] ??= { n: 0, net: 0 };
    byY[r.year].n += 1;
    byY[r.year].net += r.pnl;
  }
  const net = kept.reduce((s, r) => s + r.pnl, 0);
  console.log(`\nCF ${label}: kept n=${kept.length} net=${net.toFixed(1)}`);
  console.log("  byYear", Object.fromEntries(Object.entries(byY).map(([y, v]) => [y, `n=${v.n} net=${v.net.toFixed(1)}`])));
}

cf((r) => r.side === "BUY" && Number(r.prior5d) > 0.01, "drop BUY prior5d>1%");
cf((r) => r.side === "BUY" && Number(r.prior5d) > 0.05, "drop BUY prior5d>5%");
cf((r) => r.side === "SELL" && Number(r.prior20d) > 0.1, "drop SELL prior20d>10%");
cf((r) => r.side === "SELL" && Number(r.prior20d) > 0, "drop SELL prior20d>0");
cf((r) => r.key === "SELL|val_breakdown|bull_trend|vacuum" && Number(r.prior20d) > 0, "drop bull_trend vac VAL when prior20d>0");
cf((r) => r.side === "BUY" && r.setup === "vah_breakout" && Number(r.prior5d) > 0.01, "drop VAH BUY prior5d>1%");

const out = { generatedAt: new Date().toISOString(), n: rows.length, badN: bad.length, badNet: bad.reduce((s, r) => s + r.pnl, 0) };
fs.writeFileSync(path.resolve(__dirname, ".vp-freq-eth-residual-autopsy.json"), JSON.stringify(out, null, 2));
await closePool?.();
