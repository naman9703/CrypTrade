#!/usr/bin/env node
/**
 * ETH H3 residual — under H1 dump lock, dissect remaining 2021–22 bleed.
 *
 * Focus: VAL + bull60 + vacuum (pays 2025–26, bleeds 2021–22).
 * Goal: measurable discriminator OR prove we must abstain the unprepared subtype.
 *
 * Baseline patch: H1 dump ON, nonVac OFF (current locked preset intent).
 *
 * Usage (from backend/):
 *   node scripts/research-vp-freq-eth-2122-h3-residual.mjs
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
function avg(xs) {
  const a = xs.filter((x) => Number.isFinite(x));
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
function summarize(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.win);
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  return {
    n,
    wr: n ? (wins.length / n) * 100 : 0,
    net,
    avgPrior5d: avg(rows.map((r) => r.prior5d)),
    avgPrior20d: avg(rows.map((r) => r.prior20d)),
    avgPrior60d: avg(rows.map((r) => r.prior60d)),
    avgPrior120d: avg(rows.map((r) => r.prior120d)),
    avgHtfSep: avg(rows.map((r) => r.htfSep)),
    avgPath: avg(rows.map((r) => r.pathPct)),
    avgDistFrom60High: avg(rows.map((r) => r.distFrom60High)),
    avgBullDaysFrac60: avg(rows.map((r) => r.bullDaysFrac60)),
    avgMfe: avg(rows.map((r) => r.mfe)),
    avgMae: avg(rows.map((r) => r.mae)),
  };
}
function fmt(s) {
  if (!s?.n) return "—";
  return `${s.n}t / $${s.net.toFixed(1)} / WR${s.wr.toFixed(0)}%`;
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
function cf(rows, pred, label) {
  const dropped = rows.filter(pred);
  const kept = rows.filter((r) => !pred(r));
  return {
    label,
    droppedN: dropped.length,
    droppedNet: dropped.reduce((s, r) => s + r.pnl, 0),
    kept: summarize(kept),
  };
}

/** Fraction of last `days` UTC days with close > open (crude sustained-bull proxy). */
function bullDaysFrac(candles, idx, days) {
  const barsPerDay = 96;
  const need = days * barsPerDay;
  if (idx < need) return null;
  let bull = 0;
  for (let d = 0; d < days; d++) {
    const end = idx - d * barsPerDay;
    const start = end - barsPerDay;
    if (start < 0) return null;
    const a = candles[start].close;
    const b = candles[end].close;
    if (a > 0 && b > a) bull += 1;
  }
  return bull / days;
}

function distFromRollingHigh(candles, idx, bars) {
  if (idx < bars) return null;
  let hi = -Infinity;
  for (let i = idx - bars; i <= idx; i++) hi = Math.max(hi, Number(candles[i].high));
  const px = Number(candles[idx].close);
  if (!(hi > 0) || !(px > 0)) return null;
  return (px - hi) / hi; // 0 at highs, negative below
}

function attach(t, candles, pre) {
  const ts = Number(t.entryTs ?? t.entry_time);
  const idx = findIdx(candles, ts);
  if (idx < 1) return null;
  const bar = candles[idx];
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || "?";
  const vp = buildVolumeProfile(candles, idx, {
    mode: "rolling",
    lookback: 384,
    bins: 50,
    includePriorSession: true,
  });
  const path = vp ? pathToNextHvn(bar.close, side, vp) : null;
  const prior5d = priorPct(candles, idx, 96 * 5);
  const prior20d = priorPct(candles, idx, 96 * 20);
  const prior60d = priorPct(candles, idx, 96 * 60);
  const prior120d = priorPct(candles, idx, 96 * 120);
  const pathPct = path?.distPct ?? null;
  const vacuum = (pathPct ?? 0) >= 0.02;
  const bull60 = Number.isFinite(prior60d) && prior60d > 0.05;
  const dump20 = Number.isFinite(prior20d) && prior20d <= -0.05;
  return {
    tag: t._tag,
    entry: new Date(ts).toISOString().slice(0, 10),
    side,
    setup,
    pnl: Number(t.netPnl ?? 0),
    win: Number(t.netPnl ?? 0) > 0,
    lossPat: String(t.lossPattern ?? ""),
    prior5d,
    prior20d,
    prior60d,
    prior120d,
    prior4h: priorTrendMovePct(candles, idx, 16),
    htfSep: pre.htfSep[idx] ?? 0,
    htfUp: pre.htfUp[idx] === true,
    htfDown: pre.htfDown[idx] === true,
    aboveEma20d: pre.macroAboveEma20d?.[idx] === true,
    pathPct,
    vacuum,
    bull60,
    dump20,
    distFrom60High: distFromRollingHigh(candles, idx, 96 * 60),
    bullDaysFrac60: bullDaysFrac(candles, idx, 60),
    bullDaysFrac20: bullDaysFrac(candles, idx, 20),
    mfe: Number(t.mfePct ?? 0),
    mae: Number(t.maePct ?? 0),
    bars: Number(t.barsHeld ?? 0),
  };
}

async function runWindow(w) {
  const fromMs = Date.parse(w.from), toMs = Date.parse(w.to);
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    vpValSellBlockBull60Dump: true,
    vpValSellBull60Pct: 0.05,
    vpValSellBull60DumpPrior20dPct: -0.05,
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
    const f = attach(t, candles, pre);
    if (f) rows.push(f);
  }
  return { tag: w.tag, rows, summary: summarize(rows) };
}

const data = {};
for (const w of WINDOWS) {
  console.error(`running ${w.tag}…`);
  data[w.tag] = await runWindow(w);
}

const report = { generatedAt: new Date().toISOString(), baseline: "H1 dump ON", years: {}, vacBull60: {}, candidates: [] };

console.log("\n========== YEAR HEADLINES (under H1) ==========");
for (const tag of WINDOWS.map((w) => w.tag)) {
  const rows = data[tag].rows;
  const bySetup = {};
  for (const r of rows) {
    const k = `${r.side}:${r.setup}`;
    (bySetup[k] ??= []).push(r);
  }
  report.years[tag] = {
    summary: summarize(rows),
    bySetup: Object.fromEntries(Object.entries(bySetup).map(([k, v]) => [k, summarize(v)])),
  };
  console.log(`${tag}: ${fmt(report.years[tag].summary)}`);
  for (const [k, s] of Object.entries(report.years[tag].bySetup).sort((a, b) => a[1].net - b[1].net)) {
    console.log(`  ${k.padEnd(28)} ${fmt(s)}`);
  }
}

console.log("\n========== VAL bull60 vacuum (the residual conflict) ==========");
for (const tag of WINDOWS.map((w) => w.tag)) {
  const vac = data[tag].rows.filter(
    (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.bull60 && r.vacuum && !r.dump20,
  );
  const s = summarize(vac);
  report.vacBull60[tag] = {
    summary: s,
    byPrior60d: bucket(vac, "prior60d", [0.05, 0.1, 0.15, 0.25, 1]),
    byPrior120d: bucket(vac, "prior120d", [-1, 0, 0.15, 0.3, 0.5, 1]),
    byPrior20d: bucket(vac, "prior20d", [-0.05, -0.02, 0, 0.05, 0.1, 1]),
    byPrior5d: bucket(vac, "prior5d", [-0.1, -0.02, 0, 0.02, 0.05, 1]),
    byDist60High: bucket(vac, "distFrom60High", [-0.2, -0.1, -0.05, -0.02, 0.001]),
    byBullDays60: bucket(vac, "bullDaysFrac60", [0, 0.4, 0.5, 0.55, 0.6, 0.7, 1]),
    byHtf: {
      down: summarize(vac.filter((r) => r.htfDown)),
      up: summarize(vac.filter((r) => r.htfUp)),
    },
    rows: vac.map((r) => ({
      entry: r.entry,
      pnl: +r.pnl.toFixed(2),
      p5: r.prior5d,
      p20: r.prior20d,
      p60: r.prior60d,
      p120: r.prior120d,
      path: r.pathPct,
      distHi: r.distFrom60High,
      bullFrac60: r.bullDaysFrac60,
      htfD: r.htfDown,
      mfe: r.mfe,
      pat: r.lossPat,
    })),
  };
  console.log(`${tag}: ${fmt(s)} | avg p60=${((s.avgPrior60d ?? 0) * 100).toFixed(1)}% p120=${((s.avgPrior120d ?? 0) * 100).toFixed(1)}% bullFrac60=${((s.avgBullDaysFrac60 ?? 0) * 100).toFixed(0)}% distHi=${((s.avgDistFrom60High ?? 0) * 100).toFixed(1)}%`);
}

// Compare 21-22 losers vs 25-26 winners on vacuum bull60 (non-dump)
{
  const bad = data["2021-22"].rows.filter(
    (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.bull60 && r.vacuum && !r.dump20 && !r.win,
  );
  const good = data["2025-26"].rows.filter(
    (r) => r.side === "SELL" && r.setup === "val_breakdown" && r.bull60 && r.vacuum && !r.dump20 && r.win,
  );
  const keys = ["prior5d", "prior20d", "prior60d", "prior120d", "pathPct", "htfSep", "distFrom60High", "bullDaysFrac60", "bullDaysFrac20", "mfe", "mae"];
  console.log("\n========== 21-22 LOSERS vs 25-26 WINNERS (vac bull60 non-dump) ==========");
  console.log(`n losers=${bad.length} winners=${good.length}`);
  const cmp = {};
  for (const k of keys) {
    const lw = avg(bad.map((r) => r[k]));
    const gw = avg(good.map((r) => r[k]));
    cmp[k] = { loss21: lw, win25: gw, delta: lw != null && gw != null ? lw - gw : null };
    console.log(
      `  ${k.padEnd(18)} loss21=${lw == null ? "—" : lw.toFixed(4)}  win25=${gw == null ? "—" : gw.toFixed(4)}  Δ=${cmp[k].delta == null ? "—" : cmp[k].delta.toFixed(4)}`,
    );
  }
  report.loserVsWinner = cmp;
}

// Candidate rules: must improve 21-22 AND not destroy 25-26 vac bull60 edge
console.log("\n========== CANDIDATE RULES (harvest CF — confirm with full sim) ==========");
const allRows = Object.values(data).flatMap((d) => d.rows);
const rules = [
  {
    id: "H3a_bull60_vac_prior120_gt_30",
    label: "abstain VAL bull60 vac when prior120d > +30%",
    pred: (r) =>
      r.side === "SELL" &&
      r.setup === "val_breakdown" &&
      r.bull60 &&
      r.vacuum &&
      !r.dump20 &&
      Number(r.prior120d) > 0.3,
  },
  {
    id: "H3b_bull60_vac_prior60_gt_15",
    label: "abstain VAL bull60 vac when prior60d > +15%",
    pred: (r) =>
      r.side === "SELL" &&
      r.setup === "val_breakdown" &&
      r.bull60 &&
      r.vacuum &&
      !r.dump20 &&
      Number(r.prior60d) > 0.15,
  },
  {
    id: "H3c_bull60_vac_near_60high",
    label: "abstain VAL bull60 vac when within 5% of 60d high",
    pred: (r) =>
      r.side === "SELL" &&
      r.setup === "val_breakdown" &&
      r.bull60 &&
      r.vacuum &&
      !r.dump20 &&
      Number(r.distFrom60High) > -0.05,
  },
  {
    id: "H3d_bull60_vac_sustained_bullfrac",
    label: "abstain VAL bull60 vac when bullDaysFrac60 >= 0.55",
    pred: (r) =>
      r.side === "SELL" &&
      r.setup === "val_breakdown" &&
      r.bull60 &&
      r.vacuum &&
      !r.dump20 &&
      Number(r.bullDaysFrac60) >= 0.55,
  },
  {
    id: "H3e_bull60_nonVac",
    label: "abstain VAL bull60 non-vacuum (H2)",
    pred: (r) =>
      r.side === "SELL" && r.setup === "val_breakdown" && r.bull60 && !r.vacuum && !r.dump20,
  },
  {
    id: "H3f_all_bull60_vac",
    label: "abstain ALL VAL bull60 vacuum (blanket — expect 25-26 hurt)",
    pred: (r) =>
      r.side === "SELL" && r.setup === "val_breakdown" && r.bull60 && r.vacuum && !r.dump20,
  },
  {
    id: "H3g_thin_buy_rej",
    label: "abstain BUY va_rejection",
    pred: (r) => r.side === "BUY" && r.setup === "va_rejection",
  },
];

for (const rule of rules) {
  const byY = {};
  for (const tag of WINDOWS.map((w) => w.tag)) {
    byY[tag] = cf(data[tag].rows, rule.pred, rule.label);
  }
  const drop25 = byY["2025-26"].droppedNet;
  const keep21 = byY["2021-22"].kept.net;
  const base21 = report.years["2021-22"].summary.net;
  const base25 = report.years["2025-26"].summary.net;
  const improve21 = keep21 - base21;
  const cost25 = drop25; // negative = removing losers (good); positive = removing winners (bad)
  let verdict = "mixed";
  if (improve21 > 3 && cost25 < 5) verdict = "PROMISING";
  else if (improve21 > 3 && cost25 >= 15) verdict = "HURTS_GOOD_YEAR";
  else if (improve21 <= 1) verdict = "WEAK_ON_2122";
  report.candidates.push({
    id: rule.id,
    label: rule.label,
    verdict,
    improve21,
    cost25DroppedNet: cost25,
    byYear: Object.fromEntries(
      Object.entries(byY).map(([y, c]) => [
        y,
        { dropN: c.droppedN, dropNet: c.droppedNet, keptN: c.kept.n, keptNet: c.kept.net },
      ]),
    ),
  });
  console.log(
    `${verdict.padEnd(16)} ${rule.id.padEnd(36)} Δ21=${improve21.toFixed(1)} drop25Net=$${cost25.toFixed(1)} | 21 kept ${byY["2021-22"].kept.n}/$${keep21.toFixed(1)} 25 kept ${byY["2025-26"].kept.n}/$${byY["2025-26"].kept.net.toFixed(1)}`,
  );
}

const out = path.resolve(__dirname, ".vp-freq-eth-2122-h3-residual.json");
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.error("\nwrote", out);
await closePool?.();
