#!/usr/bin/env node
/**
 * ETH VP FREQ — residual 2021–22 autopsy under current ETH surgical lock
 * (bull60 dump + bull60 non-vac VAL gates; NOT BTC allowlist).
 *
 * Find measurable ETH-native slices that still bleed in 2021–22 AND
 * elsewhere, then propose one-change abstains that must not crush the
 * ~154t/+638%/DD20% lock window.
 */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2020-01-01";
const TO = process.env.TO || "2026-05-31";
const SYMBOL = "ETHUSDT";
const TF = "15m";
const MIN_N = Number(process.env.MIN_CELL_N || 4);

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
function summarize(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.pnl > 0).length;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  return { n, wr: n ? (wins / n) * 100 : 0, net, avg: n ? net / n : 0 };
}

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
};

console.error("loading…");
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
  const chase =
    Number.isFinite(prior5d) ? (prior5d > 0.08 ? "hi" : prior5d > 0.02 ? "mid" : prior5d < -0.05 ? "wash" : "flat") : "unk";
  const prior20L =
    Number.isFinite(prior20d) ? (prior20d > 0.1 ? "hi" : prior20d > 0 ? "up" : prior20d < -0.1 ? "deep" : "mild_dn") : "unk";
  rows.push({
    ts, year: yearOf(ts), side, setup, key, pnl: Number(t.netPnl ?? 0),
    macro, path: pathL, prior5d, prior20d, prior60d, chase, prior20L,
    pathPct: path?.distPct ?? null,
  });
}

const byCell = {};
for (const r of rows) {
  byCell[r.key] ??= [];
  byCell[r.key].push(r);
}

const cells = Object.entries(byCell)
  .map(([key, list]) => {
    const all = summarize(list);
    const byYear = {};
    for (const r of list) {
      byYear[r.year] ??= [];
      byYear[r.year].push(r);
    }
    const years = Object.fromEntries(Object.entries(byYear).map(([y, ys]) => [y, summarize(ys)]));
    const y2122 = years["2021-22"] ?? { n: 0, net: 0, wr: 0, avg: 0 };
    const yearNets = Object.values(years).map((y) => y.net);
    const negYears = yearNets.filter((n) => n < 0).length;
    const posYears = yearNets.filter((n) => n > 0).length;
    return { key, ...all, years, y2122, negYears, posYears };
  })
  .sort((a, b) => a.y2122.net - b.y2122.net);

const y2122Rows = rows.filter((r) => r.year === "2021-22");
const baseline2122 = summarize(y2122Rows);
const baselineAll = summarize(rows);

console.log("\n=== BASELINE (ETH surgical lock) ===");
console.log(`full n=${baselineAll.n} net=${baselineAll.net.toFixed(1)} wr=${baselineAll.wr.toFixed(0)}%`);
console.log(`2021-22 n=${baseline2122.n} net=${baseline2122.net.toFixed(1)} wr=${baseline2122.wr.toFixed(0)}%`);
console.log(
  `flags dump=${cfg.vpValSellBlockBull60Dump} nonVac=${cfg.vpValSellBlockBull60NonVac} allowlist=${cfg.vpPreparedAllowlistOnly}`,
);

console.log("\n=== 2021-22 CELLS (worst first) ===");
for (const c of cells.filter((c) => c.y2122.n > 0)) {
  const ystr = Object.entries(c.years)
    .map(([y, v]) => `${y}:${v.n}/${v.net.toFixed(1)}`)
    .join(" ");
  console.log(
    `  ${c.key.padEnd(52)} 21-22 n=${String(c.y2122.n).padStart(2)} net=${c.y2122.net.toFixed(1).padStart(6)} | FULL n=${String(c.n).padStart(3)} net=${c.net.toFixed(1).padStart(7)} +/-${c.posYears}/${c.negYears}`,
  );
  console.log(`    ${ystr}`);
}

// Candidates: bleed in 21-22 AND (full net<=0 OR more neg years than pos OR avg<0 with n>=MIN_N)
const candidates = cells.filter((c) => {
  if (c.y2122.n < 1 || c.y2122.net >= 0) return false;
  if (c.n >= MIN_N && c.net <= 0) return true;
  if (c.n >= MIN_N && c.negYears > c.posYears) return true;
  if (c.y2122.n >= 2 && c.y2122.avg < -0.5 && c.net < 5) return true; // harsh local bleed, weak full
  return false;
});

console.log("\n=== CANDIDATE DENY (multi-year / net≤0 evidence) ===");
for (const c of candidates) {
  console.log(
    `  DENY? ${c.key} | 21-22 ${c.y2122.n}t/${c.y2122.net.toFixed(1)} | full ${c.n}t/${c.net.toFixed(1)} +/-${c.posYears}/${c.negYears}`,
  );
}

// Also feature slices inside 21-22 remaining trades
function slice(label, pred) {
  const sub = y2122Rows.filter(pred);
  const s = summarize(sub);
  console.log(`  ${label.padEnd(40)} n=${String(s.n).padStart(2)} net=${s.net.toFixed(1).padStart(7)} wr=${s.wr.toFixed(0)}%`);
  return s;
}
console.log("\n=== 2021-22 FEATURE SLICES ===");
slice("SELL", (r) => r.side === "SELL");
slice("BUY", (r) => r.side === "BUY");
slice("SELL val_breakdown", (r) => r.side === "SELL" && r.setup === "val_breakdown");
slice("BUY vah_breakout", (r) => r.side === "BUY" && r.setup === "vah_breakout");
slice("BUY va_rejection", (r) => r.side === "BUY" && r.setup === "va_rejection");
slice("macro bull_trend", (r) => r.macro === "bull_trend");
slice("macro bull_chop", (r) => r.macro === "bull_chop");
slice("macro weak_bear", (r) => r.macro === "weak_bear");
slice("macro bear_trend", (r) => r.macro === "bear_trend");
slice("path vacuum", (r) => r.path === "vacuum");
slice("path structured", (r) => r.path === "structured");
slice("path tight", (r) => r.path === "tight");
slice("SELL + prior20d<=0", (r) => r.side === "SELL" && Number(r.prior20d) <= 0);
slice("SELL + prior20d>0", (r) => r.side === "SELL" && Number(r.prior20d) > 0);
slice("SELL VAL prior60d>+5% (bull60 left)", (r) => r.side === "SELL" && r.setup === "val_breakdown" && Number(r.prior60d) > 0.05);
slice("SELL VAL prior60d flat [-5,+5]", (r) => r.side === "SELL" && r.setup === "val_breakdown" && Number(r.prior60d) >= -0.05 && Number(r.prior60d) <= 0.05);
slice("SELL VAL prior60d<-5% (bear60)", (r) => r.side === "SELL" && r.setup === "val_breakdown" && Number(r.prior60d) < -0.05);
slice("SELL VAL + prior20d>0", (r) => r.side === "SELL" && r.setup === "val_breakdown" && Number(r.prior20d) > 0);
slice("SELL VAL + prior20d<=0", (r) => r.side === "SELL" && r.setup === "val_breakdown" && Number(r.prior20d) <= 0);
slice("SELL VAL vacuum + prior20d>0", (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.path === "vacuum" && Number(r.prior20d) > 0);
slice("SELL VAL vacuum + prior20d<=0", (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.path === "vacuum" && Number(r.prior20d) <= 0);
slice("BUY chase mid/hi prior5d>2%", (r) => r.side === "BUY" && Number(r.prior5d) > 0.02);
slice("SELL bull_trend vacuum VAL", (r) => r.key === "SELL|val_breakdown|bull_trend|vacuum");
slice("SELL bull_chop vacuum VAL", (r) => r.key === "SELL|val_breakdown|bull_chop|vacuum");
slice("SELL weak_bear vacuum VAL", (r) => r.key === "SELL|val_breakdown|weak_bear|vacuum");
slice("SELL bear_trend vacuum VAL", (r) => r.key === "SELL|val_breakdown|bear_trend|vacuum");
slice("unknown-ish thin cells (n<5 full)", (r) => (byCell[r.key]?.length ?? 0) < 5);

// Counterfactuals on full history (harvest-style — must confirm with full sim A/B next)
function cf(pred, label) {
  const kept = rows.filter((r) => !pred(r));
  const dropped = rows.filter(pred);
  const byY = {};
  for (const r of kept) {
    byY[r.year] ??= [];
    byY[r.year].push(r);
  }
  const keptS = summarize(kept);
  const dropS = summarize(dropped);
  console.log(`\nCF ${label}`);
  console.log(`  drop ${dropS.n} ($${dropS.net.toFixed(1)}) → kept n=${keptS.n} net=$${keptS.net.toFixed(1)}`);
  console.log(
    "  byYear",
    Object.fromEntries(
      Object.entries(byY)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([y, ys]) => {
          const s = summarize(ys);
          return [y, `n=${s.n} net=${s.net.toFixed(1)}`];
        }),
    ),
  );
}

const candKeys = new Set(candidates.map((c) => c.key));
cf((r) => candKeys.has(r.key), "drop all candidate deny cells");
cf((r) => r.key === "SELL|val_breakdown|bull_trend|vacuum", "drop SELL bull_trend vacuum VAL");
cf((r) => r.key === "SELL|val_breakdown|bull_chop|vacuum", "drop SELL bull_chop vacuum VAL");
cf((r) => r.side === "BUY" && r.setup === "va_rejection", "drop all BUY va_rejection");
cf((r) => r.side === "SELL" && r.setup === "va_rejection" && Number(r.prior20d) <= 0, "drop SELL rej prior20d<=0");
cf((r) => (byCell[r.key]?.length ?? 0) < MIN_N, `drop thin cells n<${MIN_N}`);
cf((r) => r.side === "BUY" && r.path === "vacuum" && r.macro !== "weak_bear", "drop BUY vacuum VAH except weak_bear");
cf(
  (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.macro === "bull_chop" && r.path === "vacuum",
  "drop SELL bull_chop vacuum VAL",
);
cf(
  (r) => r.side === "SELL" && r.setup === "val_breakdown" && Number(r.prior60d) > 0.05 && Number(r.prior20d) > 0,
  "drop SELL VAL bull60 + prior20d>0 (residual bull60 vacuum)",
);
cf(
  (r) => r.side === "SELL" && r.setup === "val_breakdown" && Number(r.prior60d) > 0.05,
  "drop ALL remaining SELL VAL bull60 (should be vacuum-only now)",
);
cf(
  (r) => r.side === "SELL" && r.setup === "val_breakdown" && Number(r.prior60d) >= -0.05 && Number(r.prior60d) <= 0.05,
  "drop SELL VAL flat60",
);
cf(
  (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.path === "vacuum" && Number(r.prior20d) <= 0,
  "drop SELL VAL vacuum after 20d down",
);
cf(
  (r) => r.side === "SELL" && r.setup === "va_rejection",
  "drop all SELL va_rejection",
);
cf(
  (r) => r.side === "BUY" && r.setup === "va_rejection" && r.path === "vacuum",
  "drop BUY vacuum va_rejection",
);

const report = {
  generatedAt: new Date().toISOString(),
  baseline: { full: baselineAll, y2122: baseline2122 },
  cells,
  candidates: candidates.map((c) => ({
    key: c.key,
    full: { n: c.n, net: c.net, posYears: c.posYears, negYears: c.negYears },
    y2122: c.y2122,
  })),
  surgicalFlags: {
    vpValSellBlockBull60Dump: cfg.vpValSellBlockBull60Dump,
    vpValSellBlockBull60NonVac: cfg.vpValSellBlockBull60NonVac,
    vpPreparedAllowlistOnly: cfg.vpPreparedAllowlistOnly,
  },
};
fs.writeFileSync(path.resolve(__dirname, ".vp-freq-eth-2122-residual-autopsy.json"), JSON.stringify(report, null, 2));
console.error("\nwrote .vp-freq-eth-2122-residual-autopsy.json");
await closePool?.();
