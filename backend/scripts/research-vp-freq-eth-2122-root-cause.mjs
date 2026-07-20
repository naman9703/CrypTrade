#!/usr/bin/env node
/**
 * ETH 2021–22 ROOT CAUSE + prepared-only counterfactual.
 *
 * Baseline: H1 dump + H2 bull60-nonVac (current lock).
 * Doctrine: only trade conditions with multi-year prepared edge;
 *           abstain everything else (incl. ambiguous) until optimized.
 *
 * Usage (from backend/):
 *   node scripts/research-vp-freq-eth-2122-root-cause.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const WINDOWS = [
  { tag: "2021-22", from: "2021-06-01", to: "2022-05-31" },
  { tag: "2022-23", from: "2022-06-01", to: "2023-05-31" },
  { tag: "2023-24", from: "2023-06-01", to: "2024-05-31" },
  { tag: "2024-25", from: "2024-06-01", to: "2025-05-31" },
  { tag: "2025-26", from: "2025-06-01", to: "2026-05-31" },
];

const MIN_PREPARED_N = 5; // min full-history trades to call a cell prepared
const MIN_PREPARED_NET = 5; // min full-history $ net

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
function summarize(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.pnl > 0).length;
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  return { n, wr: n ? (wins / n) * 100 : 0, net };
}
function fmt(s) {
  if (!s?.n) return "—";
  return `${s.n}t / $${s.net.toFixed(1)} / WR${s.wr.toFixed(0)}%`;
}

const H12 = {
  vpValSellBlockBull60Dump: true,
  vpValSellBull60Pct: 0.05,
  vpValSellBull60DumpPrior20dPct: -0.05,
  vpValSellBlockBull60NonVac: true,
};

async function runWindow(w) {
  const fromMs = Date.parse(w.from), toMs = Date.parse(w.to);
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    ...H12,
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
  const pad = volumeProfilePadFromMs(fromMs, "15m", cfg);
  const candles = await readCandles("ETHUSDT", "15m", pad, toMs, { market: "futures" });
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
      mode: "rolling", lookback: 384, bins: 50, includePriorSession: true,
    });
    const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
    const macro = classifyVpMacro(prior60d, macroBull, -0.05);
    const pathL = classifyVpPath(path?.distPct ?? null, 0.02);
    const key = buildVpConditionCellKey(side, setup, macro, pathL);
    const bull60 = Number.isFinite(prior60d) && prior60d > 0.05;
    const bear60 = Number.isFinite(prior60d) && prior60d < -0.05;
    rows.push({
      tag: w.tag,
      side,
      setup,
      key,
      macro,
      path: pathL,
      pathPct: path?.distPct ?? null,
      prior5d,
      prior20d,
      prior60d,
      bull60,
      bear60,
      macroBull,
      pnl: Number(t.netPnl ?? 0),
      lossPat: String(t.lossPattern ?? ""),
      mfe: Number(t.mfePct ?? 0),
    });
  }
  return rows;
}

const byYear = {};
for (const w of WINDOWS) {
  console.error(`running ${w.tag}…`);
  byYear[w.tag] = await runWindow(w);
}

const all = Object.values(byYear).flat();
const report = { generatedAt: new Date().toISOString(), baseline: "H1+H2", years: {}, rootCause2122: {}, cells: [], prepared: [], unprepared: [], ambiguous: [] };

console.log("\n========== ROOT CAUSE — 2021-22 under H1+H2 ==========");
{
  const rows = byYear["2021-22"];
  const s = summarize(rows);
  report.years["2021-22"] = { summary: s };
  console.log(`Headline: ${fmt(s)}`);

  const slices = [
    ["SELL val_breakdown", (r) => r.side === "SELL" && r.setup === "val_breakdown"],
    ["BUY vah_breakout", (r) => r.side === "BUY" && r.setup === "vah_breakout"],
    ["BUY va_rejection", (r) => r.side === "BUY" && r.setup === "va_rejection"],
    ["BUY other", (r) => r.side === "BUY" && r.setup !== "vah_breakout" && r.setup !== "va_rejection"],
    ["SELL other", (r) => r.side === "SELL" && r.setup !== "val_breakdown"],
    ["VAL + bull60", (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.bull60],
    ["VAL + bear60", (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.bear60],
    ["VAL + flat60", (r) => r.side === "SELL" && r.setup === "val_breakdown" && !r.bull60 && !r.bear60],
    ["VAL + vacuum", (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.path === "vacuum"],
    ["VAL + structured/tight", (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.path !== "vacuum"],
    ["VAL vacuum + bull60", (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.bull60 && r.path === "vacuum"],
    ["macro bull_trend", (r) => r.macro === "bull_trend"],
    ["macro bull_chop", (r) => r.macro === "bull_chop"],
    ["macro weak_bear", (r) => r.macro === "weak_bear"],
    ["macro bear_trend", (r) => r.macro === "bear_trend"],
  ];
  console.log("\nPnL attribution:");
  for (const [label, pred] of slices) {
    const sub = summarize(rows.filter(pred));
    report.rootCause2122[label] = sub;
    console.log(`  ${label.padEnd(28)} ${fmt(sub)}`);
  }

  // Cell breakdown worst first
  const cellMap = {};
  for (const r of rows) {
    (cellMap[r.key] ??= []).push(r);
  }
  console.log("\n2021-22 cells (worst first):");
  const cellList = Object.entries(cellMap)
    .map(([key, list]) => ({ key, ...summarize(list) }))
    .sort((a, b) => a.net - b.net);
  for (const c of cellList) {
    console.log(`  ${c.key.padEnd(48)} ${fmt(c)}`);
  }
  report.rootCause2122.cells = cellList;
}

// Multi-year cell matrix + classification
console.log("\n========== CELL MATRIX → PREPARED / UNPREPARED / AMBIGUOUS ==========");
const cellKeys = [...new Set(all.map((r) => r.key))];
for (const key of cellKeys) {
  const years = {};
  for (const tag of WINDOWS.map((w) => w.tag)) {
    years[tag] = summarize(byYear[tag].filter((r) => r.key === key));
  }
  const full = summarize(all.filter((r) => r.key === key));
  const y21 = years["2021-22"];
  const trained = ["2022-23", "2023-24", "2024-25", "2025-26"];
  const trainedNet = trained.reduce((s, y) => s + years[y].net, 0);
  const trainedN = trained.reduce((s, y) => s + years[y].n, 0);
  const posYears = trained.filter((y) => years[y].net > 1).length;
  const negYears = trained.filter((y) => years[y].net < -1).length;
  const bleeds21 = y21.n > 0 && y21.net < -1;

  let klass = "thin";
  // Prepared: enough N, positive on trained window, not dominated by single year fluke
  if (trainedN >= MIN_PREPARED_N && trainedNet >= MIN_PREPARED_NET && posYears >= negYears) {
    klass = "prepared";
  } else if (full.n >= 3 && (trainedNet <= 0 || (bleeds21 && trainedNet < 10 && negYears >= posYears))) {
    klass = "unprepared";
  } else if (bleeds21 && trainedNet > MIN_PREPARED_NET && posYears > 0) {
    // pays in trained years but bleeds in 21-22 — ambiguous under coarse cell
    klass = "ambiguous";
  } else if (full.n < MIN_PREPARED_N) {
    klass = "thin_unproven";
  } else if (trainedNet <= 0) {
    klass = "unprepared";
  } else {
    klass = "ambiguous";
  }

  const row = { key, klass, full, trainedNet, trainedN, posYears, negYears, years, bleeds21 };
  report.cells.push(row);
  if (klass === "prepared") report.prepared.push(key);
  else if (klass === "unprepared" || klass === "thin_unproven") report.unprepared.push(key);
  else report.ambiguous.push(key);
}

for (const klass of ["prepared", "unprepared", "ambiguous", "thin_unproven"]) {
  const list = report.cells.filter((c) => c.klass === klass).sort((a, b) => a.years["2021-22"].net - b.years["2021-22"].net);
  console.log(`\n--- ${klass} (${list.length}) ---`);
  for (const c of list) {
    const ystr = WINDOWS.map((w) => `${w.tag}:${c.years[w.tag].n}/${c.years[w.tag].net.toFixed(0)}`).join(" ");
    console.log(`  ${c.key.padEnd(48)} trained $${c.trainedNet.toFixed(0)}/${c.trainedN}t | 21 $${c.years["2021-22"].net.toFixed(1)} | ${ystr}`);
  }
}

// Counterfactuals aligned with doctrine
function cfYears(pred, label) {
  console.log(`\nCF ${label}`);
  const out = {};
  for (const tag of WINDOWS.map((w) => w.tag)) {
    const kept = byYear[tag].filter((r) => !pred(r));
    const dropped = byYear[tag].filter(pred);
    const ks = summarize(kept);
    const ds = summarize(dropped);
    out[tag] = { kept: ks, dropped: ds };
    console.log(`  ${tag}: drop ${ds.n}/$${ds.net.toFixed(1)} → kept ${fmt(ks)}`);
  }
  return out;
}

const preparedSet = new Set(report.prepared);
const unpreparedSet = new Set([...report.unprepared, ...report.ambiguous, ...report.cells.filter((c) => c.klass === "thin_unproven").map((c) => c.key)]);

report.cf = {
  // Doctrine strict: only prepared cells
  preparedOnly: cfYears((r) => !preparedSet.has(r.key), "PREPARED-ONLY (abstain unprepared+ambiguous+thin)"),
  // Abstain unprepared+thin but KEEP ambiguous (old stance)
  abstainUnpreparedKeepAmbiguous: cfYears(
    (r) => report.unprepared.includes(r.key) || report.cells.find((c) => c.key === r.key)?.klass === "thin_unproven",
    "abstain unprepared+thin, KEEP ambiguous",
  ),
  // Abstain ambiguous too (user doctrine for reliability)
  abstainUnpreparedAndAmbiguous: cfYears(
    (r) => !preparedSet.has(r.key),
    "abstain all non-prepared (= prepared-only)",
  ),
  // Physics: abstain VAL when bull60 (remaining vacuum after H2)
  abstainValBull60: cfYears(
    (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.bull60,
    "abstain remaining VAL bull60 (vacuum)",
  ),
  // Abstain all bull_trend macro trades
  abstainBullTrend: cfYears((r) => r.macro === "bull_trend", "abstain macro=bull_trend"),
  // Abstain BUY va_rejection
  abstainBuyRej: cfYears((r) => r.side === "BUY" && r.setup === "va_rejection", "abstain BUY va_rejection"),
  // Combined: no VAL bull60 + no BUY rej + no thin unprepared cells from 21-22 bleeders
  abstainValBull60AndBuyRej: cfYears(
    (r) =>
      (r.side === "SELL" && r.setup === "val_breakdown" && r.bull60) ||
      (r.side === "BUY" && r.setup === "va_rejection"),
    "abstain VAL bull60 + BUY va_rejection",
  ),
};

// Root cause narrative numbers
const y21 = byYear["2021-22"];
const valNet = summarize(y21.filter((r) => r.side === "SELL" && r.setup === "val_breakdown")).net;
const buyRejNet = summarize(y21.filter((r) => r.side === "BUY" && r.setup === "va_rejection")).net;
const vahNet = summarize(y21.filter((r) => r.side === "BUY" && r.setup === "vah_breakout")).net;
const prepared21 = summarize(y21.filter((r) => preparedSet.has(r.key)));
const unprep21 = summarize(y21.filter((r) => !preparedSet.has(r.key)));

console.log("\n========== ROOT CAUSE SUMMARY ==========");
console.log(`Total 2021-22: ${fmt(summarize(y21))}`);
console.log(`  of which PREPARED cells: ${fmt(prepared21)}`);
console.log(`  of which NON-PREPARED:   ${fmt(unprep21)}`);
console.log(`  VAL net $${valNet.toFixed(1)} | BUY rej $${buyRejNet.toFixed(1)} | VAH $${vahNet.toFixed(1)}`);
console.log(`Prepared cell count: ${report.prepared.length}`);
console.log(`Unprepared+thin: ${report.unprepared.length}`);
console.log(`Ambiguous: ${report.ambiguous.length}`);

report.rootCauseNarrative = {
  total: summarize(y21),
  preparedOnly: prepared21,
  nonPrepared: unprep21,
  valNet,
  buyRejNet,
  vahNet,
  preparedKeys: report.prepared,
  ambiguousKeys: report.ambiguous,
  unpreparedKeys: report.unprepared,
};

const out = path.resolve(__dirname, ".vp-freq-eth-2122-root-cause.json");
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.error("\nwrote", out);
await closePool?.();
