#!/usr/bin/env node
/**
 * BTC VP FREQ — deep dependency analysis across regimes.
 * BTC nature (prior funnel): short-biased (VAL + va_rej); VAH longs bleed.
 * Do NOT copy ETH long-side locks blindly — measure BTC failure modes first.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const WINDOWS = [
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
  VOLUME_PROFILE_FREQ_BTC_15M,
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

function attach(t, candles, pre, cfg) {
  const ts = Number(t.entryTs ?? t.entry_time);
  const idx = findIdx(candles, ts);
  if (idx < 1) return null;
  const bar = candles[idx];
  const side = String(t.direction ?? t.side).toUpperCase();
  const setup = String(t.entryReason ?? "").replace(/^vp_/, "") || t.vpSetup;
  const vp = buildVolumeProfile(candles, idx, {
    mode: cfg.vpProfileMode ?? "composite_utc",
    lookback: cfg.vpLookbackBars ?? 384,
    bins: 50,
    includePriorSession: true,
  });
  const pathHvn = vp ? pathToNextHvn(bar.close, side, vp) : null;
  const prior5d = priorPct(candles, idx, 96 * 5);
  const prior20d = priorPct(candles, idx, 96 * 20);
  const prior60d = priorPct(candles, idx, 96 * 60);
  const htfSep = pre.htfSep[idx] ?? 0;
  const macroBull =
    pre.macroAboveEma20d?.[idx] === true ||
    (pre.macroEma5dSlope?.[idx] ?? 0) > 0 ||
    prior20d > (cfg.vpSellMacroPrior20dBullPct ?? 0.02);
  const chop = Number.isFinite(prior60d) && Math.abs(prior60d) < 0.05;
  const vacuum = pathHvn?.distPct >= 0.02;
  const structured = pathHvn?.distPct >= 0.01 && pathHvn?.distPct < 0.02;
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
    pathPct: pathHvn?.distPct ?? null,
    mfe: Number(t.mfePct ?? 0),
    mae: Number(t.maePct ?? 0),
    bars: Number(t.barsHeld ?? 0),
  };
}

function summarize(rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.win);
  const net = rows.reduce((s, r) => s + r.pnl, 0);
  return { n, wr: n ? (wins.length / n) * 100 : 0, net };
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
  const kept = rows.filter((r) => !pred(r));
  const dropped = rows.filter(pred);
  return {
    label,
    droppedN: dropped.length,
    droppedNet: dropped.reduce((s, r) => s + r.pnl, 0),
    kept: summarize(kept),
  };
}

async function runWindow(w) {
  const fromMs = Date.parse(w.from), toMs = Date.parse(w.to);
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
    backtestSignalStartMs: fromMs,
    // No maxDailyLoss — research honesty (UI bot 2% distorts year windows)
    maxDailyLoss: 0,
  };
  const pad = volumeProfilePadFromMs(fromMs, "15m", cfg);
  console.error(`  reading candles ${w.tag}…`);
  const candles = await readCandles("BTCUSDT", "15m", pad, toMs, { market: "futures" });
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
  symbol: "BTCUSDT",
  preset: "VOLUME_PROFILE_FREQ_BTC_15M",
  years: {},
  rules: {},
};

for (const [tag, { rows, summary }] of Object.entries(data)) {
  const bySetup = {};
  for (const r of rows) {
    const k = `${r.side}:${r.setup}`;
    if (!bySetup[k]) bySetup[k] = [];
    bySetup[k].push(r);
  }
  report.years[tag] = {
    summary,
    bySetup: Object.fromEntries(
      Object.entries(bySetup).map(([k, v]) => [k, summarize(v)]),
    ),
    val_sell: {
      all: summarize(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL")),
      macroBull: summarize(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL" && r.macroBull)),
      macroBear: summarize(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL" && !r.macroBull)),
      shallowHtf: summarize(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL" && r.htfSep < 0.005)),
      strongHtf: summarize(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL" && r.htfSep >= 0.005)),
      chop: summarize(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL" && r.chop)),
      trend: summarize(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL" && !r.chop)),
      vacuum: summarize(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL" && r.vacuum)),
      structured: summarize(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL" && r.structured)),
      byHtfSep: bucket(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL"), "htfSep", [0, 0.0015, 0.003, 0.005, 0.008, 0.012, 1]),
      byPrior60d: bucket(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL"), "prior60d", [-1, -0.15, -0.05, 0, 0.05, 0.15, 1]),
      byPrior20d: bucket(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL"), "prior20d", [-1, -0.1, -0.05, 0, 0.02, 0.08, 1]),
      byPath: bucket(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL"), "pathPct", [0, 0.01, 0.02, 0.03, 1]),
      byPrior5d: bucket(rows.filter((r) => r.setup === "val_breakdown" && r.side === "SELL"), "prior5d", [-1, -0.05, 0, 0.04, 0.08, 1]),
    },
    va_rej: {
      all: summarize(rows.filter((r) => r.setup === "va_rejection")),
      sell: summarize(rows.filter((r) => r.setup === "va_rejection" && r.side === "SELL")),
      buy: summarize(rows.filter((r) => r.setup === "va_rejection" && r.side === "BUY")),
      sellExtendedDown: summarize(rows.filter((r) => r.setup === "va_rejection" && r.side === "SELL" && r.prior20d <= -0.05)),
      sellMacroBull: summarize(rows.filter((r) => r.setup === "va_rejection" && r.side === "SELL" && r.macroBull)),
      byPrior20d: bucket(rows.filter((r) => r.setup === "va_rejection" && r.side === "SELL"), "prior20d", [-1, -0.1, -0.05, 0, 0.05, 1]),
    },
    other: {
      lvn: summarize(rows.filter((r) => r.setup === "lvn_vacuum")),
      naked: summarize(rows.filter((r) => r.setup === "naked_poc")),
    },
  };

  // BTC-native counterfactuals (short-side focused; do not assume ETH long rules)
  const rules = [
    cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.macroBull, "block VAL short macroBull"),
    cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.macroBull && r.htfSep < 0.005, "block VAL bull+shallow HTF"),
    cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.htfSep < 0.003, "block VAL htfSep<0.3%"),
    cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.htfSep < 0.005, "block VAL htfSep<0.5%"),
    cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && !r.macroBull && r.prior20d > -0.1 && r.htfSep < 0.005, "block VAL weak-bear shallow HTF"),
    cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.chop, "block VAL in chop |prior60d|<5%"),
    cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.vacuum, "block VAL vacuum path≥2%"),
    cf(rows, (r) => r.setup === "val_breakdown" && r.side === "SELL" && r.prior5d > 0.04, "block VAL after 5d bounce>4%"),
    cf(rows, (r) => r.setup === "va_rejection" && r.side === "SELL" && r.prior20d <= -0.05, "block SELL va_rej extended down"),
    cf(rows, (r) => r.setup === "va_rejection" && r.side === "SELL" && r.macroBull, "block SELL va_rej macroBull"),
    cf(rows, (r) => r.setup === "va_rejection", "block all va_rejection"),
    cf(rows, (r) => r.setup === "lvn_vacuum", "block lvn_vacuum"),
    cf(rows, (r) => r.setup === "naked_poc", "block naked_poc"),
    cf(rows, (r) => r.side === "BUY", "block all BUY"),
    cf(rows, (r) => r.mfe >= 0.01 && r.pnl < 0 && r.side === "SELL", "counterfactual: SELL losers with MFE≥1% (exit leak)"),
  ];
  report.rules[tag] = rules;
}

const outPath = path.resolve(__dirname, ".vp-freq-btc-bad-years-deep.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

// Compact stdout summary
for (const [tag, y] of Object.entries(report.years)) {
  console.log(`\n== ${tag} == N=${y.summary.n} WR=${y.summary.wr.toFixed(1)}% net=$${y.summary.net.toFixed(2)}`);
  console.log("  bySetup", JSON.stringify(y.bySetup));
  console.log("  VAL bull/bear", JSON.stringify({ macroBull: y.val_sell.macroBull, macroBear: y.val_sell.macroBear }));
  console.log("  VAL htf/chop/vac", JSON.stringify({
    shallow: y.val_sell.shallowHtf, strong: y.val_sell.strongHtf,
    chop: y.val_sell.chop, vacuum: y.val_sell.vacuum, structured: y.val_sell.structured,
  }));
  console.log("  va_rej", JSON.stringify(y.va_rej));
  for (const rule of report.rules[tag]) {
    if (rule.droppedN > 0) {
      const delta = rule.kept.net - y.summary.net;
      console.log(`  CF ${rule.label}: drop ${rule.droppedN} ($${rule.droppedNet.toFixed(1)}) → kept $${rule.kept.net.toFixed(1)} (Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(1)})`);
    }
  }
}

console.error("wrote", outPath);
await closePool?.();
