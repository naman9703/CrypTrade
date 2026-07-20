#!/usr/bin/env node
/**
 * BTC VP FREQ — long/BUY autopsy (why shorts-only? is it coin or setup?).
 *
 * Prior funnel banned VAH after a 1y window (+vah → −13…−33%). That is NOT the same
 * as "BTC cannot long." Re-open longs on the multi-year locked short stack and measure:
 * which BUY setups/regimes win vs lose — then form adaptive long rules (not a ban).
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
    delta: summarize(kept).net - summarize(rows).net,
  };
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
    prior20d > 0.02;
  const chop = Number.isFinite(prior60d) && Math.abs(prior60d) < 0.05;
  const vacuum = (pathHvn?.distPct ?? 0) >= 0.02;
  const structured = (pathHvn?.distPct ?? 0) >= 0.01 && (pathHvn?.distPct ?? 0) < 0.02;
  return {
    tag: t._tag,
    setup,
    side,
    pnl: Number(t.netPnl ?? 0),
    win: Number(t.netPnl ?? 0) > 0,
    prior5d,
    prior20d,
    prior60d,
    prior4h: priorTrendMovePct(candles, idx, 16),
    htfSep,
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

/** Open funnel longs on top of current BTC regime locks (shorts unchanged). */
const OPEN_LONG = {
  ...VOLUME_PROFILE_FREQ_BTC_15M,
  vpAllowedSetups: [
    "lvn_vacuum",
    "vah_breakout",
    "val_breakdown",
    "poc_bounce",
    "va_rejection",
    "naked_poc",
  ],
};

async function runWindow(w, cfgBase) {
  const fromMs = Date.parse(w.from), toMs = Date.parse(w.to);
  const cfg = {
    ...cfgBase,
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
  const pad = volumeProfilePadFromMs(fromMs, "15m", cfg);
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
  return { tag: w.tag, rows, summary: summarize(rows), equityRet: rows.reduce((s, r) => s + r.pnl, 0) };
}

console.error("=== SHORTS-ONLY locked baseline (per year) ===");
const shortOnly = {};
for (const w of WINDOWS) {
  console.error(`  ${w.tag}…`);
  shortOnly[w.tag] = await runWindow(w, VOLUME_PROFILE_FREQ_BTC_15M);
  const s = shortOnly[w.tag].summary;
  console.error(`    N=${s.n} WR=${s.wr.toFixed(0)}% net=$${s.net.toFixed(1)}`);
}

console.error("\n=== OPEN FUNNEL (VAH+poc longs re-enabled) on locked short stack ===");
const open = {};
const allOpenRows = [];
for (const w of WINDOWS) {
  console.error(`  ${w.tag}…`);
  open[w.tag] = await runWindow(w, OPEN_LONG);
  allOpenRows.push(...open[w.tag].rows);
  const s = open[w.tag].summary;
  const buys = open[w.tag].rows.filter((r) => r.side === "BUY");
  const sells = open[w.tag].rows.filter((r) => r.side === "SELL");
  console.error(
    `    N=${s.n} net=$${s.net.toFixed(1)} | BUY n=${buys.length} net=$${summarize(buys).net.toFixed(1)} | SELL n=${sells.length} net=$${summarize(sells).net.toFixed(1)}`,
  );
}

const buys = allOpenRows.filter((r) => r.side === "BUY");
const sells = allOpenRows.filter((r) => r.side === "SELL");
const vah = buys.filter((r) => r.setup === "vah_breakout");
const poc = buys.filter((r) => r.setup === "poc_bounce");
const rejBuy = buys.filter((r) => r.setup === "va_rejection");
const lvnBuy = buys.filter((r) => r.setup === "lvn_vacuum");

const report = {
  generatedAt: new Date().toISOString(),
  note: "Long reopen on locked BTC short stack — diagnose BUY failure modes",
  shortOnlyByYear: Object.fromEntries(
    Object.entries(shortOnly).map(([k, v]) => [k, v.summary]),
  ),
  openByYear: Object.fromEntries(
    Object.entries(open).map(([k, v]) => {
      const b = v.rows.filter((r) => r.side === "BUY");
      const s = v.rows.filter((r) => r.side === "SELL");
      const bySetup = {};
      for (const r of v.rows) {
        const key = `${r.side}:${r.setup}`;
        if (!bySetup[key]) bySetup[key] = [];
        bySetup[key].push(r);
      }
      return [
        k,
        {
          all: v.summary,
          buy: summarize(b),
          sell: summarize(s),
          bySetup: Object.fromEntries(Object.entries(bySetup).map(([kk, vv]) => [kk, summarize(vv)])),
        },
      ];
    }),
  ),
  buyPooled: {
    all: summarize(buys),
    bySetup: {
      vah_breakout: summarize(vah),
      poc_bounce: summarize(poc),
      va_rejection: summarize(rejBuy),
      lvn_vacuum: summarize(lvnBuy),
    },
    vah: {
      vacuum: summarize(vah.filter((r) => r.vacuum)),
      structured: summarize(vah.filter((r) => r.structured)),
      macroBull: summarize(vah.filter((r) => r.macroBull)),
      macroBear: summarize(vah.filter((r) => !r.macroBull)),
      chop: summarize(vah.filter((r) => r.chop)),
      byPrior5d: bucket(vah, "prior5d", [-1, -0.05, 0, 0.04, 0.08, 0.15, 1]),
      byPrior60d: bucket(vah, "prior60d", [-1, -0.15, -0.05, 0, 0.05, 0.15, 1]),
      byPath: bucket(vah, "pathPct", [0, 0.01, 0.02, 0.03, 1]),
      byHtfSep: bucket(vah, "htfSep", [0, 0.003, 0.005, 0.008, 0.012, 1]),
    },
  },
  sellPooled: summarize(sells),
  buyCounterfactuals: [
    cf(buys, (r) => r.setup === "vah_breakout" && r.vacuum, "block VAH vacuum path≥2%"),
    cf(buys, (r) => r.setup === "vah_breakout" && r.vacuum && !r.macroBull, "block VAH vacuum non-bull"),
    cf(buys, (r) => r.setup === "vah_breakout" && r.prior5d > 0.08, "block VAH prior5d>8%"),
    cf(buys, (r) => r.setup === "vah_breakout" && r.prior5d > 0.04, "block VAH prior5d>4%"),
    cf(buys, (r) => r.setup === "vah_breakout" && !r.macroBull, "block VAH in macroBear"),
    cf(buys, (r) => r.setup === "vah_breakout" && r.macroBull === false && r.vacuum, "block VAH vacuum in bear"),
    cf(buys, (r) => r.setup === "vah_breakout" && r.pathPct >= 0.02 && r.prior5d > 0.01, "ETH vacuum pullback gate"),
    cf(buys, (r) => r.setup === "poc_bounce", "block all poc_bounce BUY"),
    cf(buys, (r) => r.setup === "va_rejection" && r.side === "BUY", "block BUY va_rejection"),
    cf(buys, (r) => r.htfSep < 0.008 && r.setup === "vah_breakout", "VAH require HTF≥0.8%"),
    cf(buys, (r) => r.mfe >= 0.01 && r.pnl < 0, "BUY losers with MFE≥1% (exit leak)"),
  ],
  yearBuyCf: {},
};

for (const [tag, v] of Object.entries(open)) {
  const b = v.rows.filter((r) => r.side === "BUY");
  report.yearBuyCf[tag] = [
    cf(b, (r) => r.setup === "vah_breakout" && r.vacuum && !r.macroBull, "block VAH vacuum non-bull"),
    cf(b, (r) => r.setup === "vah_breakout" && r.prior5d > 0.08, "block VAH prior5d>8%"),
    cf(b, (r) => r.setup === "vah_breakout" && !r.macroBull, "block VAH macroBear"),
    cf(b, (r) => r.setup === "vah_breakout" && r.pathPct >= 0.02 && r.prior5d > 0.01, "vacuum pullback"),
  ].filter((x) => x.droppedN > 0);
}

const outPath = path.resolve(__dirname, ".vp-freq-btc-long-autopsy.json");
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log("\n=== POOLED BUY ===");
console.log(JSON.stringify(report.buyPooled, null, 2));
console.log("\n=== BUY CFs (pooled) ===");
for (const r of report.buyCounterfactuals) {
  if (r.droppedN > 0) {
    console.log(
      `  ${r.label}: drop ${r.droppedN} ($${r.droppedNet.toFixed(1)}) → kept $${r.kept.net.toFixed(1)} (Δ ${r.delta >= 0 ? "+" : ""}${r.delta.toFixed(1)})`,
    );
  }
}
console.log("\n=== OPEN vs SHORT-ONLY by year ===");
for (const tag of Object.keys(open)) {
  const o = report.openByYear[tag];
  const s = report.shortOnlyByYear[tag];
  console.log(
    `${tag}: short-only N=${s.n} net=$${s.net.toFixed(1)} | open N=${o.all.n} net=$${o.all.net.toFixed(1)} (BUY $${o.buy.net.toFixed(1)} / SELL $${o.sell.net.toFixed(1)})`,
  );
  console.log("  setups", JSON.stringify(o.bySetup));
}

console.error("wrote", outPath);
await closePool?.();
