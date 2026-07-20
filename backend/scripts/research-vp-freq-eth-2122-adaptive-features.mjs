#!/usr/bin/env node
/**
 * ETH 2021–22 — relative/adaptive feature autopsy (under H1+H2 high-return lock).
 *
 * Goal: find measurable relative conditions where the SAME setup fails in
 * blow-off residual vs succeeds in clean bear — then adapt behaviour only
 * when that condition is present (no-op elsewhere → preserve lock returns).
 *
 * Usage (from backend/):
 *   node scripts/research-vp-freq-eth-2122-adaptive-features.mjs
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
function rollingHighDist(candles, idx, bars) {
  if (idx < bars) return null;
  let hi = -Infinity;
  for (let i = idx - bars; i <= idx; i++) hi = Math.max(hi, Number(candles[i].high));
  const px = Number(candles[idx].close);
  return hi > 0 ? (px - hi) / hi : null;
}
function realizedVol(candles, idx, lb = 96) {
  if (idx < lb + 1) return null;
  const rets = [];
  for (let i = idx - lb + 1; i <= idx; i++) {
    const a = candles[i - 1].close, b = candles[i].close;
    if (a > 0) rets.push((b - a) / a);
  }
  if (rets.length < 10) return null;
  const m = rets.reduce((s, x) => s + x, 0) / rets.length;
  const v = rets.reduce((s, x) => s + (x - m) ** 2, 0) / rets.length;
  return Math.sqrt(v);
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
function featAvg(rows, key) {
  return avg(rows.map((r) => r[key]));
}
function bucket(rows, key, edges) {
  const out = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i], hi = edges[i + 1];
    const sub = rows.filter((r) => Number.isFinite(r[key]) && r[key] >= lo && r[key] < hi);
    out.push({ bucket: `[${lo},${hi})`, ...summarize(sub), avgMfe: avg(sub.map((r) => r.mfe)) });
  }
  return out;
}
function cf(rows, pred) {
  const dropped = rows.filter(pred);
  const kept = rows.filter((r) => !pred(r));
  return { dropped: summarize(dropped), kept: summarize(kept) };
}

const H12 = {
  vpValSellBlockBull60Dump: true,
  vpValSellBull60Pct: 0.05,
  vpValSellBull60DumpPrior20dPct: -0.05,
  vpValSellBlockBull60NonVac: true,
  vpValSellRequirePrior60dBear: false,
  vpBuyRejectionBlockUnpreparedMacro: false,
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
    const prior10d = priorPct(candles, idx, 96 * 10);
    const prior20d = priorPct(candles, idx, 96 * 20);
    const prior40d = priorPct(candles, idx, 96 * 40);
    const prior60d = priorPct(candles, idx, 96 * 60);
    const prior120d = priorPct(candles, idx, 96 * 120);
    // Relative: is 20d still extending the 60d move, or mean-reverting against it?
    const ext20vs60 =
      Number.isFinite(prior20d) && Number.isFinite(prior60d) && Math.abs(prior60d) > 0.01
        ? prior20d / prior60d
        : null;
    // Deceleration: 20d weaker than first half of 60d path would imply
    const prior40to60 =
      Number.isFinite(prior60d) && Number.isFinite(prior40d) ? prior60d - prior40d : null;
    const macroBull = vpMacroBullAt(pre, idx, cfg);
    const macro = classifyVpMacro(prior60d, macroBull, -0.05);
    const pathL = classifyVpPath(path?.distPct ?? null, 0.02);
    const key = buildVpConditionCellKey(side, setup, macro, pathL);
    const htfSep = pre.htfSep?.[idx] ?? 0;
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
      prior10d,
      prior20d,
      prior40d,
      prior60d,
      prior120d,
      ext20vs60,
      prior40to60,
      // still-elevated 20d inside bull60 (shorting into residual strength)
      bull60: Number.isFinite(prior60d) && prior60d > 0.05,
      bear60: Number.isFinite(prior60d) && prior60d < -0.05,
      strong20up: Number.isFinite(prior20d) && prior20d > 0.1,
      mild20up: Number.isFinite(prior20d) && prior20d > 0 && prior20d <= 0.1,
      // relative stretch: 5d still positive while 60d huge (chase short into melt-up residue)
      stretchShort:
        side === "SELL" &&
        Number.isFinite(prior60d) &&
        prior60d > 0.15 &&
        Number.isFinite(prior20d) &&
        prior20d > 0.05,
      // failed continuation: vacuum path + 20d still up + 60d bull
      vacBullStrong20:
        side === "SELL" &&
        setup === "val_breakdown" &&
        (path?.distPct ?? 0) >= 0.02 &&
        Number.isFinite(prior60d) &&
        prior60d > 0.05 &&
        Number.isFinite(prior20d) &&
        prior20d > 0.05,
      // soft extension: vacuum bull60 with 20d > 0 (any)
      vacBullUp20:
        side === "SELL" &&
        setup === "val_breakdown" &&
        (path?.distPct ?? 0) >= 0.02 &&
        Number.isFinite(prior60d) &&
        prior60d > 0.05 &&
        Number.isFinite(prior20d) &&
        prior20d > 0,
      dist60hi: rollingHighDist(candles, idx, 96 * 60),
      dist120hi: rollingHighDist(candles, idx, 96 * 120),
      rv1d: realizedVol(candles, idx, 96),
      rv5d: realizedVol(candles, idx, 96 * 5),
      htfSep,
      htfDown: pre.htfDown?.[idx] === true,
      prior4h: priorTrendMovePct(candles, idx, 16),
      // adaptive HTF insufficiency relative to stretch
      shallowVsStretch:
        side === "SELL" &&
        Number.isFinite(prior60d) &&
        prior60d > 0.05 &&
        htfSep < 0.008,
    });
  }
  return rows;
}

const byYear = {};
for (const w of WINDOWS) {
  console.error(`running ${w.tag}…`);
  byYear[w.tag] = await runWindow(w);
}

const report = { generatedAt: new Date().toISOString(), baseline: "H1+H2", years: {}, valFocus: {}, candidates: [] };

console.log("\n========== YEAR HEADLINES (H1+H2) ==========");
for (const tag of WINDOWS.map((w) => w.tag)) {
  const s = summarize(byYear[tag]);
  report.years[tag] = s;
  console.log(`${tag}: ${fmt(s)}`);
}

// Focus: SELL VAL residuals
console.log("\n========== VAL SHORTS — relative feature buckets ==========");
for (const tag of ["2021-22", "2025-26"]) {
  const val = byYear[tag].filter((r) => r.side === "SELL" && r.setup === "val_breakdown");
  console.log(`\n--- ${tag} VAL ${fmt(summarize(val))} ---`);
  console.log("  by prior20d", bucket(val, "prior20d", [-1, -0.05, 0, 0.05, 0.1, 0.2, 1]).map((b) => `${b.bucket}:${b.n}/$${b.net.toFixed(0)}`).join(" "));
  console.log("  by prior60d", bucket(val, "prior60d", [-1, -0.15, -0.05, 0.05, 0.15, 0.3, 1]).map((b) => `${b.bucket}:${b.n}/$${b.net.toFixed(0)}`).join(" "));
  console.log("  by ext20vs60", bucket(val, "ext20vs60", [-2, 0, 0.3, 0.6, 1, 2, 5]).map((b) => `${b.bucket}:${b.n}/$${b.net.toFixed(0)}`).join(" "));
  console.log("  by htfSep", bucket(val, "htfSep", [0, 0.005, 0.008, 0.012, 0.02, 1]).map((b) => `${b.bucket}:${b.n}/$${b.net.toFixed(0)}`).join(" "));
  console.log("  by pathPct", bucket(val, "pathPct", [0, 0.02, 0.03, 0.05, 1]).map((b) => `${b.bucket}:${b.n}/$${b.net.toFixed(0)}`).join(" "));
  console.log("  by dist60hi", bucket(val, "dist60hi", [-0.25, -0.15, -0.08, -0.03, 0.01]).map((b) => `${b.bucket}:${b.n}/$${b.net.toFixed(0)}`).join(" "));
  report.valFocus[tag] = {
    all: summarize(val),
    byPrior20d: bucket(val, "prior20d", [-1, -0.05, 0, 0.05, 0.1, 0.2, 1]),
    byExt: bucket(val, "ext20vs60", [-2, 0, 0.3, 0.6, 1, 2, 5]),
    byHtf: bucket(val, "htfSep", [0, 0.005, 0.008, 0.012, 0.02, 1]),
  };
}

// Loser vs winner feature deltas for VAL in 21-22 vs 25-26
console.log("\n========== VAL losers 21-22 vs VAL winners 25-26 (relative) ==========");
{
  const L = byYear["2021-22"].filter((r) => r.side === "SELL" && r.setup === "val_breakdown" && !r.win);
  const W = byYear["2025-26"].filter((r) => r.side === "SELL" && r.setup === "val_breakdown" && r.win);
  const keys = [
    "prior5d", "prior10d", "prior20d", "prior40d", "prior60d", "prior120d",
    "ext20vs60", "prior40to60", "pathPct", "htfSep", "dist60hi", "dist120hi",
    "rv1d", "rv5d", "prior4h", "mfe", "mae",
  ];
  console.log(`n L=${L.length} W=${W.length}`);
  const cmp = {};
  for (const k of keys) {
    const a = featAvg(L, k), b = featAvg(W, k);
    cmp[k] = { loss21: a, win25: b, delta: a != null && b != null ? a - b : null };
    console.log(
      `  ${k.padEnd(14)} L21=${a == null ? "—" : a.toFixed(4)}  W25=${b == null ? "—" : b.toFixed(4)}  Δ=${cmp[k].delta == null ? "—" : cmp[k].delta.toFixed(4)}`,
    );
  }
  report.loserVsWinner = cmp;
}

// Candidate RELATIVE rules — must help 21-22 and not destroy 25-26
const rules = [
  {
    id: "R1_vacBull_prior20_gt_5",
    label: "abstain VAL vacuum+bull60 when prior20d > +5% (short into residual 20d strength)",
    pred: (r) => r.vacBullStrong20,
  },
  {
    id: "R2_vacBull_prior20_gt_0",
    label: "abstain VAL vacuum+bull60 when prior20d > 0",
    pred: (r) => r.vacBullUp20,
  },
  {
    id: "R3_stretchShort",
    label: "abstain VAL when prior60d>+15% AND prior20d>+5%",
    pred: (r) => r.stretchShort && r.setup === "val_breakdown",
  },
  {
    id: "R4_ext20vs60_gt_0.5_bull60",
    label: "abstain VAL bull60 when ext20vs60 > 0.5 (20d still extending 60d)",
    pred: (r) =>
      r.side === "SELL" &&
      r.setup === "val_breakdown" &&
      r.bull60 &&
      Number(r.ext20vs60) > 0.5,
  },
  {
    id: "R5_bull60_htf_lt_0.8",
    label: "abstain VAL bull60 when htfSep < 0.8% (adaptive harder HTF in residual bull)",
    pred: (r) => r.shallowVsStretch && r.setup === "val_breakdown",
  },
  {
    id: "R6_bull60_htf_lt_1.0",
    label: "abstain VAL bull60 when htfSep < 1.0%",
    pred: (r) =>
      r.side === "SELL" &&
      r.setup === "val_breakdown" &&
      r.bull60 &&
      r.htfSep < 0.01,
  },
  {
    id: "R7_near60high_bull60",
    label: "abstain VAL bull60 when within 8% of 60d high",
    pred: (r) =>
      r.side === "SELL" &&
      r.setup === "val_breakdown" &&
      r.bull60 &&
      Number(r.dist60hi) > -0.08,
  },
  {
    id: "R8_weak_bear_vacuum",
    label: "abstain VAL weak_bear vacuum (transition shorts)",
    pred: (r) => r.key === "SELL|val_breakdown|weak_bear|vacuum",
  },
  {
    id: "R9_buy_rej_bull_trend",
    label: "abstain BUY va_rejection in bull_trend only",
    pred: (r) => r.side === "BUY" && r.setup === "va_rejection" && r.macro === "bull_trend",
  },
  {
    id: "R10_R1_plus_R9",
    label: "R1 + R9 combined",
    pred: (r) => r.vacBullStrong20 || (r.side === "BUY" && r.setup === "va_rejection" && r.macro === "bull_trend"),
  },
  {
    id: "R11_R3_plus_R8_plus_R9",
    label: "stretchShort + weak_bear vac + BUY rej bull_trend",
    pred: (r) =>
      (r.stretchShort && r.setup === "val_breakdown") ||
      r.key === "SELL|val_breakdown|weak_bear|vacuum" ||
      (r.side === "BUY" && r.setup === "va_rejection" && r.macro === "bull_trend"),
  },
];

console.log("\n========== RELATIVE RULE CANDIDATES (harvest CF) ==========");
for (const rule of rules) {
  const byY = {};
  for (const tag of WINDOWS.map((w) => w.tag)) {
    byY[tag] = cf(byYear[tag], rule.pred);
  }
  const base21 = report.years["2021-22"].net;
  const base25 = report.years["2025-26"].net;
  const baseLockApprox =
    report.years["2022-23"].net +
    report.years["2023-24"].net +
    report.years["2024-25"].net +
    report.years["2025-26"].net;
  const keep21 = byY["2021-22"].kept.net;
  const keep25 = byY["2025-26"].kept.net;
  const drop25 = byY["2025-26"].dropped.net;
  const keepLock =
    byY["2022-23"].kept.net +
    byY["2023-24"].kept.net +
    byY["2024-25"].kept.net +
    byY["2025-26"].kept.net;
  const d21 = keep21 - base21;
  const d25 = keep25 - base25;
  const dLock = keepLock - baseLockApprox;
  let verdict = "mixed";
  if (d21 > 5 && dLock >= -15 && drop25 < 15) verdict = "PROMISING";
  else if (d21 > 5 && dLock < -40) verdict = "HURTS_LOCK";
  else if (d21 > 5 && drop25 >= 20) verdict = "HURTS_2526";
  else if (d21 <= 2) verdict = "WEAK_2122";
  report.candidates.push({
    id: rule.id,
    label: rule.label,
    verdict,
    d21,
    d25,
    dLock,
    drop25Net: drop25,
    byYear: Object.fromEntries(
      Object.entries(byY).map(([y, c]) => [
        y,
        { dropN: c.dropped.n, dropNet: c.dropped.net, keptN: c.kept.n, keptNet: c.kept.net },
      ]),
    ),
  });
  console.log(
    `${verdict.padEnd(12)} ${rule.id.padEnd(28)} Δ21=${d21.toFixed(1)} Δ25=${d25.toFixed(1)} Δlock≈${dLock.toFixed(1)} drop25=$${drop25.toFixed(1)}`,
  );
}

const out = path.resolve(__dirname, ".vp-freq-eth-2122-adaptive-features.json");
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.error("\nwrote", out);
await closePool?.();
