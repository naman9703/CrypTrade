#!/usr/bin/env node
/**
 * ETH residual 2021–22 under H1+H2+H3 (extending) lock.
 * Find relative patterns in remaining losers vs good-year winners.
 * Priority: raise WR / cut bleed subtypes without crushing N or lock return.
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
  priorTrendMovePct,
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
function avg(xs) {
  const a = xs.filter((x) => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
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
function cf(rows, pred) {
  const dropped = rows.filter(pred);
  const kept = rows.filter((r) => !pred(r));
  return { dropped: summarize(dropped), kept: summarize(kept) };
}

async function runWindow(w) {
  const fromMs = Date.parse(w.from), toMs = Date.parse(w.to);
  // Current locked preset as-is (H1+H2+H3 extending)
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
  const pad = volumeProfilePadFromMs(fromMs, "15m", cfg);
  const candles = await readCandles("ETHUSDT", "15m", pad, toMs, { market: "futures" });
  const pre = precomputeVolumeProfile(candles);
  const adapters = { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, "15m") };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE", candles, cfg, gateMode: "off", fundingRates: [],
    startingUsdt: 100, timeframe: "15m", symbol: "ETHUSDT", adapters,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const rows = [];
  for (const t of closed) {
    const ts = Number(t.entryTs ?? t.entry_time);
    const idx = findIdx(candles, ts);
    if (idx < 1) continue;
    const side = String(t.direction ?? t.side).toUpperCase();
    const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || "?";
    const vp = buildVolumeProfile(candles, idx, {
      mode: "rolling", lookback: 384, bins: 50, includePriorSession: true,
    });
    const path = vp ? pathToNextHvn(candles[idx].close, side, vp) : null;
    const prior5d = priorPct(candles, idx, 96 * 5);
    const prior20d = priorPct(candles, idx, 96 * 20);
    const prior60d = priorPct(candles, idx, 96 * 60);
    const prior120d = priorPct(candles, idx, 96 * 120);
    const macroBull = vpMacroBullAt(pre, idx, cfg);
    const macro = classifyVpMacro(prior60d, macroBull, -0.05);
    const pathL = classifyVpPath(path?.distPct ?? null, 0.02);
    const key = buildVpConditionCellKey(side, setup, macro, pathL);
    const htfSep = pre.htfSep?.[idx] ?? 0;
    const ext =
      Number.isFinite(prior20d) && Number.isFinite(prior60d) && Math.abs(prior60d) > 0.01
        ? prior20d / prior60d
        : null;
    const bar = candles[idx];
    const range = Math.max(bar.high - bar.low, 1e-12);
    const upperWick = (bar.high - Math.max(bar.open, bar.close)) / range;
    const lowerWick = (Math.min(bar.open, bar.close) - bar.low) / range;
    const closeStr = (bar.close - bar.low) / range;
    rows.push({
      tag: w.tag,
      side,
      setup,
      key,
      macro,
      path: pathL,
      pathPct: path?.distPct ?? null,
      pnl: Number(t.netPnl ?? 0),
      win: Number(t.netPnl ?? 0) > 0,
      mfe: Number(t.mfePct ?? 0),
      mae: Number(t.maePct ?? 0),
      lossPat: String(t.lossPattern ?? ""),
      prior5d,
      prior20d,
      prior60d,
      prior120d,
      ext,
      htfSep,
      htfDown: pre.htfDown?.[idx] === true,
      prior4h: priorTrendMovePct(candles, idx, 16),
      upperWick,
      lowerWick,
      closeStr,
      bull60: Number.isFinite(prior60d) && prior60d > 0.05,
      // cycle stretch: multi-month bull still on
      cycleBull: Number.isFinite(prior120d) && prior120d > 0.15,
      // weak_bear vacuum VAL
      weakBearVac:
        side === "SELL" && setup === "val_breakdown" && macro === "weak_bear" && pathL === "vacuum",
      // BUY rej in bull_trend
      buyRejBullTrend:
        side === "BUY" && setup === "va_rejection" && macro === "bull_trend",
      // BUY rej weak wick / weak close (quality)
      buyRejWeakQuality:
        side === "BUY" &&
        setup === "va_rejection" &&
        (lowerWick < 0.35 || closeStr < 0.55),
      // VAL in cycle bull (prior120 elevated) even if not extending-20
      valCycleBull:
        side === "SELL" && setup === "val_breakdown" && Number.isFinite(prior120d) && prior120d > 0.25,
      // VAL weak_bear with shallow HTF
      weakBearShallowHtf:
        side === "SELL" &&
        setup === "val_breakdown" &&
        macro === "weak_bear" &&
        htfSep < 0.008,
      // INSTANT/WHIPSAW loss pattern cluster
      instantOrWhip: ["INSTANT_SL", "WHIPSAW_GAVE_BACK", "FAST_FAIL"].includes(String(t.lossPattern ?? "")),
    });
  }
  return rows;
}

const byYear = {};
for (const w of WINDOWS) {
  console.error(`running ${w.tag}…`);
  byYear[w.tag] = await runWindow(w);
}

const report = { generatedAt: new Date().toISOString(), baseline: "H1+H2+H3", years: {}, cells21: [], candidates: [] };

console.log("\n========== HEADLINES (current lock) ==========");
for (const tag of WINDOWS.map((w) => w.tag)) {
  const s = summarize(byYear[tag]);
  report.years[tag] = s;
  console.log(`${tag}: ${fmt(s)}`);
}

{
  const rows = byYear["2021-22"];
  console.log("\n========== 2021-22 ATTRIBUTION ==========");
  const slices = [
    ["SELL val", (r) => r.side === "SELL" && r.setup === "val_breakdown"],
    ["BUY vah", (r) => r.side === "BUY" && r.setup === "vah_breakout"],
    ["BUY va_rej", (r) => r.side === "BUY" && r.setup === "va_rejection"],
    ["BUY other", (r) => r.side === "BUY" && !["vah_breakout", "va_rejection"].includes(r.setup)],
    ["macro bull_trend", (r) => r.macro === "bull_trend"],
    ["macro bull_chop", (r) => r.macro === "bull_chop"],
    ["macro weak_bear", (r) => r.macro === "weak_bear"],
    ["macro bear_trend", (r) => r.macro === "bear_trend"],
    ["weakBearVac VAL", (r) => r.weakBearVac],
    ["buyRejBullTrend", (r) => r.buyRejBullTrend],
    ["valCycleBull p120>25%", (r) => r.valCycleBull],
    ["instant/whip losses", (r) => !r.win && r.instantOrWhip],
  ];
  for (const [label, pred] of slices) {
    console.log(`  ${label.padEnd(28)} ${fmt(summarize(rows.filter(pred)))}`);
  }

  const cellMap = {};
  for (const r of rows) (cellMap[r.key] ??= []).push(r);
  console.log("\n2021-22 cells (worst first):");
  const cells = Object.entries(cellMap)
    .map(([key, list]) => ({ key, ...summarize(list) }))
    .sort((a, b) => a.net - b.net);
  report.cells21 = cells;
  for (const c of cells) console.log(`  ${c.key.padEnd(48)} ${fmt(c)}`);
}

// Losers vs winners feature compare for remaining VAL
console.log("\n========== REMAINING VAL losers 21-22 vs VAL winners 25-26 ==========");
{
  const L = byYear["2021-22"].filter((r) => r.side === "SELL" && r.setup === "val_breakdown" && !r.win);
  const W = byYear["2025-26"].filter((r) => r.side === "SELL" && r.setup === "val_breakdown" && r.win);
  const keys = ["prior5d", "prior20d", "prior60d", "prior120d", "ext", "pathPct", "htfSep", "mfe", "mae", "prior4h"];
  console.log(`n L=${L.length} W=${W.length}`);
  for (const k of keys) {
    const a = avg(L.map((r) => r[k])), b = avg(W.map((r) => r[k]));
    console.log(`  ${k.padEnd(12)} L=${a?.toFixed(4) ?? "—"} W=${b?.toFixed(4) ?? "—"} Δ=${a != null && b != null ? (a - b).toFixed(4) : "—"}`);
  }
}

const rules = [
  {
    id: "S1_weak_bear_vac",
    label: "abstain VAL weak_bear vacuum",
    pred: (r) => r.weakBearVac,
  },
  {
    id: "S2_weak_bear_shallow_htf",
    label: "abstain VAL weak_bear when htfSep < 0.8%",
    pred: (r) => r.weakBearShallowHtf,
  },
  {
    id: "S3_val_cycle_bull_p120",
    label: "abstain VAL when prior120d > +25% (sustained cycle bull)",
    pred: (r) => r.valCycleBull,
  },
  {
    id: "S4_buy_rej_bull_trend",
    label: "abstain BUY va_rejection in bull_trend",
    pred: (r) => r.buyRejBullTrend,
  },
  {
    id: "S5_buy_rej_weak_quality",
    label: "abstain BUY va_rejection weak wick/close",
    pred: (r) => r.buyRejWeakQuality,
  },
  {
    id: "S6_S1_plus_S4",
    label: "weak_bear vac + BUY rej bull_trend",
    pred: (r) => r.weakBearVac || r.buyRejBullTrend,
  },
  {
    id: "S7_S2_plus_S4",
    label: "weak_bear shallow HTF + BUY rej bull_trend",
    pred: (r) => r.weakBearShallowHtf || r.buyRejBullTrend,
  },
  {
    id: "S8_val_p120_gt_40",
    label: "abstain VAL when prior120d > +40%",
    pred: (r) =>
      r.side === "SELL" && r.setup === "val_breakdown" && Number(r.prior120d) > 0.4,
  },
  {
    id: "S9_bull_trend_vac_val_remaining",
    label: "abstain remaining SELL|val|bull_trend|vacuum",
    pred: (r) => r.key === "SELL|val_breakdown|bull_trend|vacuum",
  },
];

console.log("\n========== CANDIDATES (harvest; confirm full sim) ==========");
const lockTags = ["2022-23", "2023-24", "2024-25", "2025-26"];
const baseLock = lockTags.reduce((s, t) => s + report.years[t].net, 0);
const base21 = report.years["2021-22"].net;
const baseNLock = lockTags.reduce((s, t) => s + byYear[t].length, 0);

for (const rule of rules) {
  const byY = {};
  for (const tag of WINDOWS.map((w) => w.tag)) byY[tag] = cf(byYear[tag], rule.pred);
  const keep21 = byY["2021-22"].kept.net;
  const keepLock = lockTags.reduce((s, t) => s + byY[t].kept.net, 0);
  const keepNLock = lockTags.reduce((s, t) => s + byY[t].kept.n, 0);
  const drop25 = byY["2025-26"].dropped.net;
  const d21 = keep21 - base21;
  const dLock = keepLock - baseLock;
  const dN = keepNLock - baseNLock;
  const dropN21 = byY["2021-22"].dropped.n;
  let verdict = "mixed";
  if (d21 > 4 && dLock >= -20 && Math.abs(dN) <= 12 && drop25 < 20) verdict = "PROMISING";
  else if (d21 > 4 && dLock < -40) verdict = "HURTS_LOCK";
  else if (d21 > 4 && Math.abs(dN) > 20) verdict = "CRUSHES_N";
  else if (d21 <= 2) verdict = "WEAK_2122";
  report.candidates.push({
    id: rule.id, label: rule.label, verdict, d21, dLock, dN, drop25, dropN21,
    byYear: Object.fromEntries(
      Object.entries(byY).map(([y, c]) => [
        y,
        { dropN: c.dropped.n, dropNet: c.dropped.net, keptN: c.kept.n, keptNet: c.kept.net, keptWr: c.kept.wr },
      ]),
    ),
  });
  console.log(
    `${verdict.padEnd(12)} ${rule.id.padEnd(32)} Δ21=$${d21.toFixed(1)} Δlock≈$${dLock.toFixed(1)} ΔNlock=${dN} drop25=$${drop25.toFixed(1)} dropN21=${dropN21}`,
  );
}

const out = path.resolve(__dirname, ".vp-freq-eth-2122-residual-h3.json");
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.error("\nwrote", out);
await closePool?.();
