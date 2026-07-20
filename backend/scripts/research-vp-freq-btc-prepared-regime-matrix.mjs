#!/usr/bin/env node
/**
 * BTC VP FREQ — prepared-regime matrix (authorize vs abstain doctrine).
 *
 * Live markets invent NEW regimes. Optimizing year-by-year never finishes.
 * Doctrine:
 *   1. Trade ONLY condition cells with validated positive full-sim expectancy
 *   2. Unknown / thin / negative cells → ABSTAIN (default)
 *   3. Live kill-switch when realized outcomes diverge from prepared expectations
 *
 * This script:
 *   - runs locked BTC FREQ over 2020-01 → 2026-05 (env FROM/TO)
 *   - buckets trades into measurable cells
 *   - proposes prepared allow-list
 *   - fold-wise cell status + counterfactual keep-only-prepared
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2020-01-01";
const TO = process.env.TO || "2026-05-31";
const MIN_CELL_N = Number(process.env.MIN_CELL_N || 5); // below this → treat as unknown (abstain)
const FOLDS = Math.max(3, Math.floor(Number(process.env.FOLDS || 5)));

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
  VOLUME_PROFILE_FREQ_BTC_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");
const { purgedWalkForwardSplits } = await import("../src/backtest/engine/validation.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

function findIdx(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = -1;
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

function chaseLabel(prior5d) {
  if (!(Number.isFinite(prior5d))) return "unk";
  if (prior5d > 0.08) return "chase_hi";
  if (prior5d > 0.02) return "chase_mid";
  if (prior5d < -0.05) return "washout";
  return "neutral";
}

function cellKey(side, setup, macro, path) {
  return buildVpConditionCellKey(side, setup, macro, path);
}

function summarize(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.pnl > 0).length;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  const avg = n ? net / n : 0;
  return { n, wr: n ? (wins / n) * 100 : 0, net, avg };
}

function yearOf(ts) {
  const d = new Date(Number(ts));
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (m >= 5) return `${y}-${String(y + 1).slice(2)}`;
  return `${y - 1}-${String(y).slice(2)}`;
}

function classifyCell(list) {
  const all = summarize(list);
  const byYear = {};
  for (const r of list) {
    byYear[r.year] ??= [];
    byYear[r.year].push(r);
  }
  const years = Object.fromEntries(Object.entries(byYear).map(([y, ys]) => [y, summarize(ys)]));
  const yearNets = Object.values(years).map((y) => y.net);
  const positiveYears = yearNets.filter((n) => n > 0).length;
  const negativeYears = yearNets.filter((n) => n < 0).length;
  let status = "unknown_thin";
  if (all.n >= MIN_CELL_N) {
    if (all.net > 0 && all.avg > 0 && negativeYears <= positiveYears) status = "prepared";
    else if (all.net <= 0) status = "unprepared_bleed";
    else status = "fragile_positive";
  }
  return { ...all, years, positiveYears, negativeYears, status };
}

const cfg = {
  ...VOLUME_PROFILE_FREQ_BTC_15M,
  symbol: "BTCUSDT",
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

console.error("loading candles…");
const candles = await readCandles(
  "BTCUSDT",
  "15m",
  volumeProfilePadFromMs(fromMs, "15m", cfg),
  toMs,
  { market: "futures" },
);
console.error(`candles=${candles.length}`);
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
  symbol: "BTCUSDT",
  adapters,
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
    mode: cfg.vpProfileMode ?? "rolling",
    lookback: cfg.vpLookbackBars ?? 384,
    bins: 50,
    includePriorSession: true,
  });
  const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
  const macro = classifyVpMacro(prior60d, macroBull, cfg.vpValSellPrior60dBearPct ?? -0.05);
  const pathL = classifyVpPath(path?.distPct ?? null, cfg.vpPreparedVacuumPathPct ?? 0.02);
  const chase = chaseLabel(prior5d);
  const key = cellKey(side, setup, macro, pathL);
  rows.push({
    ts,
    year: yearOf(ts),
    side,
    setup,
    pnl: Number(t.netPnl ?? 0),
    macro,
    path: pathL,
    chase,
    key,
    prior5d,
    prior60d,
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
    const classified = classifyCell(list);
    return { key, ...classified };
  })
  .sort((a, b) => a.net - b.net);

const prepared = cells.filter((c) => c.status === "prepared").map((c) => c.key);
const unprepared = cells.filter((c) => c.status === "unprepared_bleed").map((c) => c.key);
const unknown = cells.filter((c) => c.status === "unknown_thin" || c.status === "fragile_positive").map((c) => c.key);

// Chronological fold-wise cell status (expanding train → classify → score test cells).
const signalStartIdx = candles.findIndex((c) => c.ts >= fromMs);
const signalBars = Math.max(0, candles.length - Math.max(0, signalStartIdx));
const stepMs = candles.length > 1 ? candles[1].ts - candles[0].ts : 900_000;
const embargo = Math.max(1, Math.round(86_400_000 / stepMs));
const splits = purgedWalkForwardSplits(signalBars, {
  folds: FOLDS,
  embargo,
  mode: "expanding",
  minTrain: Math.floor(96 * 30),
});
const foldCellReports = [];
for (const s of splits) {
  const trainEndTs = candles[signalStartIdx + s.trainEnd - 1]?.ts ?? toMs;
  const testStartTs = candles[signalStartIdx + s.testStart]?.ts ?? fromMs;
  const testEndTs = candles[signalStartIdx + s.testEnd - 1]?.ts ?? toMs;
  const trainRows = rows.filter((r) => r.ts < trainEndTs);
  const testRows = rows.filter((r) => r.ts >= testStartTs && r.ts <= testEndTs);
  const trainBy = {};
  for (const r of trainRows) {
    trainBy[r.key] ??= [];
    trainBy[r.key].push(r);
  }
  const trainStatus = Object.fromEntries(
    Object.entries(trainBy).map(([k, list]) => [k, classifyCell(list).status]),
  );
  const testByStatus = { prepared: [], unprepared_bleed: [], unknown_thin: [], fragile_positive: [], unseen: [] };
  for (const r of testRows) {
    const st = trainStatus[r.key] ?? "unseen";
    (testByStatus[st] ??= []).push(r);
  }
  foldCellReports.push({
    fold: s.fold,
    trainEnd: new Date(trainEndTs).toISOString().slice(0, 10),
    testFrom: new Date(testStartTs).toISOString().slice(0, 10),
    testTo: new Date(testEndTs).toISOString().slice(0, 10),
    byStatus: Object.fromEntries(
      Object.entries(testByStatus).map(([st, list]) => [st, summarize(list)]),
    ),
  });
}

function cf(pred, label) {
  const kept = rows.filter((r) => !pred(r));
  const dropped = rows.filter(pred);
  return {
    label,
    droppedN: dropped.length,
    droppedNet: dropped.reduce((s, r) => s + r.pnl, 0),
    kept: summarize(kept),
    keptByYear: (() => {
      const m = {};
      for (const r of kept) {
        m[r.year] ??= [];
        m[r.year].push(r);
      }
      return Object.fromEntries(Object.entries(m).map(([y, ys]) => [y, summarize(ys)]));
    })(),
  };
}

const preparedSet = new Set(prepared);
const rules = [
  cf((r) => !preparedSet.has(r.key), "abstain: keep ONLY prepared cells"),
  cf((r) => unprepared.includes(r.key), "abstain: drop unprepared_bleed cells only"),
  cf(
    (r) => r.side === "BUY" && r.setup === "vah_breakout" && r.path === "vacuum",
    "abstain: all vacuum VAH",
  ),
  cf(
    (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.path === "vacuum",
    "abstain: all vacuum VAL",
  ),
  cf(
    (r) =>
      (r.side === "BUY" && r.setup === "vah_breakout" && r.path === "vacuum") ||
      (r.side === "SELL" && r.setup === "val_breakdown" && r.path === "vacuum"),
    "abstain: vacuum VAH+VAL",
  ),
];

const baseline = summarize(rows);
const report = {
  generatedAt: new Date().toISOString(),
  doctrine: {
    principle: "Unknown regime = abstain by default. Expand prepared set only after autopsy+full-sim.",
    liveNovelty:
      "A new live regime that does not match any prepared cell is refused automatically. No need to have seen that year before.",
    killSwitch:
      "Even inside prepared cells, disable a cell if rolling live expectancy turns negative (stream monitor).",
  },
  window: { from: FROM, to: TO },
  baseline,
  minCellN: MIN_CELL_N,
  prepared,
  unprepared,
  unknown,
  cells,
  foldCellReports,
  rules,
};

const outPath = path.resolve(__dirname, ".vp-freq-btc-prepared-regime-matrix.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log("\n=== BASELINE ===");
console.log(JSON.stringify(baseline));
console.log("\n=== CELLS (status) ===");
for (const c of cells) {
  console.log(
    `${c.status.padEnd(18)} ${c.key.padEnd(48)} n=${String(c.n).padStart(3)} net=${c.net.toFixed(1).padStart(7)} avg=${c.avg.toFixed(2)} years+/${c.positiveYears} -/${c.negativeYears}`,
  );
}
console.log("\n=== COUNTERFACTUALS ===");
for (const r of rules) {
  console.log(
    `${r.label}\n  drop ${r.droppedN} ($${r.droppedNet.toFixed(1)}) → kept n=${r.kept.n} net=$${r.kept.net.toFixed(1)} wr=${r.kept.wr.toFixed(0)}%`,
  );
  console.log("  byYear", JSON.stringify(r.keptByYear));
}
console.log("\n=== FOLD CELL OOS ===");
for (const f of foldCellReports) {
  console.log(
    `fold ${f.fold} ${f.testFrom}→${f.testTo}`,
    JSON.stringify(f.byStatus),
  );
}
console.error("wrote", outPath);
await closePool?.();
