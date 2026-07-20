#!/usr/bin/env node
/**
 * ETH VP FREQ — 2021–22 regime autopsy (process-compliant).
 *
 * Follows docs/VP_FREQ_REGIME_OPTIMIZATION_PROCESS.md:
 *   Phase 0–2 only — market character + physics vs trained years.
 *   Does NOT lock knobs. Harvest CFs are hypothesis seeds only.
 *
 * Baseline = ABC adaptive stack that already works on 2022–26
 * (surgical bull60 flags FORCED OFF so we see true year physics
 * against the successfully optimized setup — not residual after a patch).
 *
 * Usage (from backend/):
 *   node scripts/research-vp-freq-eth-2021-22-regime.mjs
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
  const a = candles[idx - bars]?.close;
  const b = candles[idx]?.close;
  if (!(a > 0)) return null;
  return (b - a) / a;
}
function summarize(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.win);
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  const avg = (k) => {
    const xs = rows.map((r) => r[k]).filter((x) => Number.isFinite(x));
    return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
  };
  return {
    n,
    wr: n ? (wins.length / n) * 100 : 0,
    net,
    avgPrior5d: avg("prior5d"),
    avgPrior20d: avg("prior20d"),
    avgPrior60d: avg("prior60d"),
    avgHtfSep: avg("htfSep"),
    avgPath: avg("pathPct"),
    avgMfe: avg("mfe"),
    avgMae: avg("mae"),
    avgBars: avg("bars"),
  };
}
function bucket(rows, key, edges) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const sub = rows.filter((r) => Number.isFinite(r[key]) && r[key] >= lo && r[key] < hi);
    out.push({ bucket: `[${lo},${hi})`, ...summarize(sub) });
  }
  return out;
}
function wlDelta(rows, key) {
  const wins = rows.filter((r) => r.win);
  const losses = rows.filter((r) => !r.win);
  const avg = (xs) => {
    const a = xs.map((r) => r[key]).filter((x) => Number.isFinite(x));
    return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  };
  return { win: avg(wins), loss: avg(losses), nW: wins.length, nL: losses.length };
}
function cf(rows, pred, label) {
  const kept = rows.filter((r) => !pred(r));
  const dropped = rows.filter(pred);
  return {
    label,
    droppedN: dropped.length,
    droppedNet: dropped.reduce((s, r) => s + r.pnl, 0),
    kept: summarize(kept),
  };
}
function fmt(s) {
  if (!s || !s.n) return "—";
  return `${s.n}t / $${s.net.toFixed(1)} / WR${s.wr.toFixed(0)}%`;
}

function attach(t, candles, pre, cfg) {
  const ts = Number(t.entryTs ?? t.entry_time);
  const idx = findIdx(candles, ts);
  if (idx < 1) return null;
  const bar = candles[idx];
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || t.vpSetup;
  const vp = buildVolumeProfile(candles, idx, {
    mode: cfg.vpProfileMode ?? "rolling",
    lookback: cfg.vpLookbackBars ?? 384,
    bins: 50,
    includePriorSession: true,
  });
  const path = vp ? pathToNextHvn(bar.close, side, vp) : null;
  const prior5d = priorPct(candles, idx, 96 * 5);
  const prior20d = priorPct(candles, idx, 96 * 20);
  const prior60d = priorPct(candles, idx, 96 * 60);
  const htfSep = pre.htfSep[idx] ?? 0;
  const macroBull =
    pre.macroAboveEma20d?.[idx] === true ||
    (pre.macroEma5dSlope?.[idx] ?? 0) > 0 ||
    prior20d > (cfg.vpSellMacroPrior20dBullPct ?? 0.02);
  const chop = Number.isFinite(prior60d) && Math.abs(prior60d) < 0.05;
  const vacuum = (path?.distPct ?? 0) >= 0.02;
  const structured = (path?.distPct ?? 0) >= 0.01 && (path?.distPct ?? 0) < 0.02;
  const bull60 = Number.isFinite(prior60d) && prior60d > 0.05;
  const bear60 = Number.isFinite(prior60d) && prior60d < -0.05;
  const dump20 = Number.isFinite(prior20d) && prior20d <= -0.05;
  const up20 = Number.isFinite(prior20d) && prior20d > 0;
  return {
    tag: t._tag,
    setup,
    side,
    pnl: Number(t.netPnl ?? 0),
    win: Number(t.netPnl ?? 0) > 0,
    lossPat: String(t.lossPattern ?? ""),
    prior5d,
    prior20d,
    prior60d,
    prior4h: priorTrendMovePct(candles, idx, 16),
    htfSep,
    htfUp: pre.htfUp[idx],
    htfDown: pre.htfDown[idx],
    macroBull,
    chop,
    vacuum,
    structured,
    bull60,
    bear60,
    dump20,
    up20,
    pathPct: path?.distPct ?? null,
    mfe: Number(t.mfePct ?? 0),
    mae: Number(t.maePct ?? 0),
    bars: Number(t.barsHeld ?? 0),
  };
}

async function runWindow(w) {
  const fromMs = Date.parse(w.from), toMs = Date.parse(w.to);
  // Trained ABC stack — surgical 2021–22 patches OFF for clean physics read.
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    vpValSellBlockBull60: false,
    vpValSellBlockBull60Dump: false,
    vpValSellBlockBull60NonVac: false,
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
    t._tag = w.tag;
    const f = attach(t, candles, pre, cfg);
    if (f) rows.push(f);
  }
  return { tag: w.tag, rows, summary: summarize(rows) };
}

const data = {};
for (const w of WINDOWS) {
  console.error(`running ${w.tag}…`);
  data[w.tag] = await runWindow(w);
}

const report = {
  generatedAt: new Date().toISOString(),
  baselineNote:
    "ABC adaptive ETH FREQ with surgical bull60 flags OFF — physics vs trained 22–26 stack",
  years: {},
  crossYear: {},
  hypotheses: [],
};

for (const [tag, { rows, summary }] of Object.entries(data)) {
  const val = rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL");
  const vah = rows.filter((r) => r.setup === "vah_breakout" && r.side === "BUY");
  const rej = rows.filter((r) => r.setup === "va_rejection");
  const bySetup = {};
  for (const r of rows) {
    const k = `${r.side}:${r.setup}`;
    (bySetup[k] ??= []).push(r);
  }

  report.years[tag] = {
    summary,
    bySetup: Object.fromEntries(Object.entries(bySetup).map(([k, v]) => [k, summarize(v)])),
    entryContext: {
      pctMacroBull: rows.length ? (rows.filter((r) => r.macroBull).length / rows.length) * 100 : 0,
      pctBull60: rows.length ? (rows.filter((r) => r.bull60).length / rows.length) * 100 : 0,
      pctBear60: rows.length ? (rows.filter((r) => r.bear60).length / rows.length) * 100 : 0,
      pctChop: rows.length ? (rows.filter((r) => r.chop).length / rows.length) * 100 : 0,
      avgPrior60d: summary.avgPrior60d,
      avgPrior20d: summary.avgPrior20d,
    },
    vah_buy: {
      all: summarize(vah),
      vacuum: summarize(vah.filter((r) => r.vacuum)),
      structured: summarize(vah.filter((r) => r.structured)),
      byPrior5d: bucket(vah, "prior5d", [-1, -0.05, 0, 0.01, 0.04, 0.08, 1]),
      byPath: bucket(vah, "pathPct", [0, 0.01, 0.02, 0.03, 1]),
      wl: { prior5d: wlDelta(vah, "prior5d"), prior60d: wlDelta(vah, "prior60d"), pathPct: wlDelta(vah, "pathPct") },
    },
    val_sell: {
      all: summarize(val),
      macroBull: summarize(val.filter((r) => r.macroBull)),
      macroBear: summarize(val.filter((r) => !r.macroBull)),
      bull60: summarize(val.filter((r) => r.bull60)),
      bear60: summarize(val.filter((r) => r.bear60)),
      flat60: summarize(val.filter((r) => r.chop)),
      bull60_vacuum: summarize(val.filter((r) => r.bull60 && r.vacuum)),
      bull60_nonVac: summarize(val.filter((r) => r.bull60 && !r.vacuum)),
      bull60_dump20: summarize(val.filter((r) => r.bull60 && r.dump20)),
      bull60_up20: summarize(val.filter((r) => r.bull60 && r.up20)),
      shallowHtf: summarize(val.filter((r) => r.htfSep < 0.005)),
      strongHtf: summarize(val.filter((r) => r.htfSep >= 0.005)),
      byPrior60d: bucket(val, "prior60d", [-1, -0.15, -0.05, 0, 0.05, 0.15, 1]),
      byPrior20d: bucket(val, "prior20d", [-1, -0.1, -0.05, 0, 0.05, 0.1, 1]),
      byHtfSep: bucket(val, "htfSep", [0, 0.0025, 0.005, 0.008, 0.012, 1]),
      byPath: bucket(val, "pathPct", [0, 0.01, 0.02, 0.03, 1]),
      wl: {
        prior20d: wlDelta(val, "prior20d"),
        prior60d: wlDelta(val, "prior60d"),
        htfSep: wlDelta(val, "htfSep"),
        pathPct: wlDelta(val, "pathPct"),
        mfe: wlDelta(val, "mfe"),
      },
    },
    va_rej: {
      all: summarize(rej),
      buy: summarize(rej.filter((r) => r.side === "BUY")),
      sell: summarize(rej.filter((r) => r.side === "SELL")),
    },
    // Harvest CFs — seeds only; must confirm with full-sim one-change A/B later
    cfSeeds: [
      cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.bull60, "VAL + bull60"),
      cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.bull60 && r.dump20, "VAL + bull60 + dump20"),
      cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.bull60 && !r.vacuum, "VAL + bull60 + nonVac"),
      cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.bull60 && r.vacuum, "VAL + bull60 + vacuum"),
      cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.macroBull && r.htfSep < 0.005, "VAL + macroBull + shallow HTF"),
      cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.up20, "VAL + prior20d>0"),
      cf(rows, (r) => r.setup === "vah_breakout" && r.side === "BUY" && r.vacuum, "VAH vacuum"),
      cf(rows, (r) => r.setup === "va_rejection" && r.side === "BUY", "BUY va_rejection"),
      cf(rows, (r) => r.setup === "va_rejection" && r.side === "SELL", "SELL va_rejection"),
    ],
  };
}

// Cross-year: is a slice UNIVERSAL (bad in 21-22 AND net≤0 or weak in good years)?
function sliceNet(tag, picker) {
  const rows = data[tag].rows.filter(picker);
  return summarize(rows);
}
const slices = [
  { id: "VAL_bull60", pick: (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.bull60 },
  { id: "VAL_bull60_vac", pick: (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.bull60 && r.vacuum },
  { id: "VAL_bull60_nonVac", pick: (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.bull60 && !r.vacuum },
  { id: "VAL_bull60_dump", pick: (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.bull60 && r.dump20 },
  { id: "VAL_prior20_up", pick: (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.up20 },
  { id: "VAL_macroBull_shallow", pick: (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.macroBull && r.htfSep < 0.005 },
  { id: "VAH_vacuum", pick: (r) => r.setup === "vah_breakout" && r.side === "BUY" && r.vacuum },
  { id: "BUY_va_rej", pick: (r) => r.setup === "va_rejection" && r.side === "BUY" },
  { id: "SELL_va_rej", pick: (r) => r.setup === "va_rejection" && r.side === "SELL" },
];

for (const s of slices) {
  const byY = {};
  for (const tag of Object.keys(data)) byY[tag] = sliceNet(tag, s.pick);
  const y2122 = byY["2021-22"];
  const goodYears = ["2022-23", "2023-24", "2024-25", "2025-26"];
  const goodNets = goodYears.map((y) => byY[y].net);
  const goodPos = goodNets.filter((n) => n > 1).length;
  const goodNeg = goodNets.filter((n) => n < -1).length;
  const fullNet = goodNets.reduce((a, b) => a + b, 0) + y2122.net;
  let verdict = "year_specific_or_thin";
  if (y2122.n >= 3 && y2122.net < -3 && goodNeg >= goodPos && fullNet <= 5) {
    verdict = "UNIVERSAL_BLEED_candidate";
  } else if (y2122.n >= 3 && y2122.net < -3 && goodPos > goodNeg && byY["2025-26"].net > 5) {
    verdict = "YEAR_SPECIFIC_do_not_blanket";
  } else if (y2122.n >= 3 && y2122.net < -3 && byY["2025-26"].net > 10) {
    verdict = "YEAR_SPECIFIC_protect_good_year";
  }
  report.crossYear[s.id] = { byYear: byY, fullNetApprox: fullNet, verdict };
}

// Human summary
console.log("\n========== PHASE 1 — YEAR HEADLINES (ABC stack, no surgical) ==========");
for (const tag of WINDOWS.map((w) => w.tag)) {
  const y = report.years[tag];
  console.log(
    `${tag}: ${fmt(y.summary)} | macroBull ${y.entryContext.pctMacroBull.toFixed(0)}% bull60 ${y.entryContext.pctBull60.toFixed(0)}% bear60 ${y.entryContext.pctBear60.toFixed(0)}% | avg prior60d=${((y.entryContext.avgPrior60d ?? 0) * 100).toFixed(1)}%`,
  );
  const setups = Object.entries(y.bySetup).sort((a, b) => a[1].net - b[1].net);
  for (const [k, s] of setups) {
    console.log(`    ${k.padEnd(28)} ${fmt(s)}`);
  }
}

console.log("\n========== PHASE 2 — 2021-22 VAL / VAH PHYSICS ==========");
{
  const v = report.years["2021-22"].val_sell;
  console.log("VAL all:", fmt(v.all));
  console.log("  bull60:", fmt(v.bull60), "| bear60:", fmt(v.bear60), "| flat60:", fmt(v.flat60));
  console.log("  bull60 vacuum:", fmt(v.bull60_vacuum), "| nonVac:", fmt(v.bull60_nonVac));
  console.log("  bull60 dump20:", fmt(v.bull60_dump20), "| up20:", fmt(v.bull60_up20));
  console.log("  macroBull:", fmt(v.macroBull), "| macroBear:", fmt(v.macroBear));
  console.log("  shallowHtf:", fmt(v.shallowHtf), "| strongHtf:", fmt(v.strongHtf));
  console.log("  WL prior60d win/loss:", v.wl.prior60d);
  console.log("  WL prior20d win/loss:", v.wl.prior20d);
  console.log("  WL htfSep win/loss:", v.wl.htfSep);
  console.log("VAH all:", fmt(report.years["2021-22"].vah_buy.all));
  console.log("  vacuum:", fmt(report.years["2021-22"].vah_buy.vacuum), "| structured:", fmt(report.years["2021-22"].vah_buy.structured));
  console.log("va_rej buy/sell:", fmt(report.years["2021-22"].va_rej.buy), "/", fmt(report.years["2021-22"].va_rej.sell));
}

console.log("\n========== CROSS-YEAR SLICE VERDICTS ==========");
for (const [id, x] of Object.entries(report.crossYear)) {
  const parts = Object.entries(x.byYear)
    .map(([y, s]) => `${y}:${s.n}/${s.net.toFixed(0)}`)
    .join(" ");
  console.log(`${x.verdict.padEnd(32)} ${id.padEnd(24)} ${parts}`);
}

const outPath = path.resolve(__dirname, ".vp-freq-eth-2021-22-regime.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.error("\nwrote", outPath);
await closePool?.();
