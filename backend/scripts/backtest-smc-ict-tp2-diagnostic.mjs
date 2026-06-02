#!/usr/bin/env node
/**
 * Targeted TP2 + session-extreme diagnostics (post-bracket-fix).
 * 1. Internal TP2 vs opposing on CHoCH+FVG-mid (22-trade path)
 * 2. Session extreme proximity to PDH/PDL segmentation
 * 3. Prior-day range ratio vs outcomes
 *
 * Usage: node scripts/backtest-smc-ict-tp2-diagnostic.mjs [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fromMs = Date.parse(args[0] || "2026-01-01");
const toMs = Date.parse(args[1] || "2026-05-27");
const symbol = process.env.TUNE_SYMBOL || "BNBUSDT";
const tf = "15m";
const RISK_PCT = 2.5;

const { INTRADAY_PRO_ICT_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js"
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg, precomputeIntraday } = await import(
  "../src/strategy/intradayPro.js"
);
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { atrPercentileAt } = await import("../src/strategy/techniques/smcRegime.js");

const CHOCH_FVG_MID = {
  ...INTRADAY_PRO_ICT_15M,
  intradaySmcRequireChoch: true,
  intradaySmcRequireRetrace: true,
  intradaySmcFvgEntryMode: "midpoint",
  intradaySmcEntryZoneMode: "FVG",
  intradaySmcChochStrict: false,
};

function barIdx(candles, tsMs) {
  let idx = candles.findIndex((c) => c.ts === tsMs);
  if (idx >= 0) return idx;
  let best = 0;
  let bestD = Math.abs(candles[0].ts - tsMs);
  for (let i = 1; i < candles.length; i++) {
    const d = Math.abs(candles[i].ts - tsMs);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return bestD <= 90_000 ? best : -1;
}

function utcHour(tsMs) {
  return new Date(tsMs).getUTCHours() + new Date(tsMs).getUTCMinutes() / 60;
}

/** Rolling mean of prior-day (PDH−PDL) over last `days` UTC days before bar idx. */
function avgPriorDayRange(candles, pre, idx, days = 10) {
  const dayMs = 864e5;
  const curDay = Math.floor(candles[idx].ts / dayMs);
  const ranges = [];
  for (let d = 1; d <= days + 5 && ranges.length < days; d++) {
    const targetDay = curDay - d;
    let pdh = 0;
    let pdl = 0;
    for (let j = idx; j >= 0; j--) {
      const barDay = Math.floor(candles[j].ts / dayMs);
      if (barDay < targetDay) break;
      if (barDay === targetDay) {
        pdh = pre.prevDayHigh?.[j] ?? pdh;
        pdl = pre.prevDayLow?.[j] ?? pdl;
      }
    }
    if (pdh > 0 && pdl > 0 && pdh > pdl) ranges.push(pdh - pdl);
  }
  if (!ranges.length) return null;
  return ranges.reduce((a, b) => a + b, 0) / ranges.length;
}

function aggregateByEntry(trades) {
  const m = new Map();
  for (const t of trades) {
    const row = m.get(t.entryTs) ?? {
      entryTs: t.entryTs,
      direction: t.direction,
      netPnl: 0,
      legs: 0,
      trade: t,
    };
    row.netPnl += Number(t.netPnl ?? 0);
    row.legs += 1;
    row.trade = t;
    m.set(t.entryTs, row);
  }
  return [...m.values()];
}

function rMultiple(row, riskPct = RISK_PCT) {
  const t = row.trade;
  const eq = Number(t.equityAtEntry ?? 10_000);
  const riskUsd = eq * (riskPct / 100);
  if (riskUsd <= 0) return null;
  return Math.round((row.netPnl / riskUsd) * 100) / 100;
}

function enrichEntry(row, candles, pre) {
  const t = row.trade;
  const meta = t.liqContext?.smcMeta ?? {};
  const idx = meta.entryIdx ?? barIdx(candles, t.entryTs);
  const pdh = pre.prevDayHigh?.[idx] ?? 0;
  const pdl = pre.prevDayLow?.[idx] ?? 0;
  const sweepLevel = meta.sweepLevel ?? t.liqContext?.level ?? 0;
  const levelType = meta.levelType ?? t.liqContext?.levelType ?? "?";
  const priorRange = pdh > 0 && pdl > 0 ? pdh - pdl : null;
  const avg10 = idx >= 0 ? avgPriorDayRange(candles, pre, idx, 10) : null;
  const rangeRatio =
    priorRange != null && avg10 != null && avg10 > 0 ? Math.round((priorRange / avg10) * 1000) / 1000 : null;

  let pdProximityPct = null;
  if (levelType === "session_high" && pdh > 0 && sweepLevel > 0) {
    pdProximityPct = Math.round((Math.abs(sweepLevel - pdh) / pdh) * 10000) / 100;
  } else if (levelType === "session_low" && pdl > 0 && sweepLevel > 0) {
    pdProximityPct = Math.round((Math.abs(sweepLevel - pdl) / pdl) * 10000) / 100;
  }

  const atrPct = idx >= 0 ? atrPercentileAt(candles, pre, idx, 2880) : null;

  return {
    ts: new Date(t.entryTs).toISOString().slice(0, 16),
    side: t.direction,
    levelType,
    netPnl: Math.round(row.netPnl * 100) / 100,
    r: rMultiple(row),
    utcHour: Math.round(utcHour(t.entryTs) * 10) / 10,
    atrPctile: atrPct != null ? Math.round(atrPct * 10) / 10 : null,
    priorDayRangeRatio: rangeRatio,
    pdProximityPct,
    tp2Mode: meta.tp2Mode ?? null,
    internalTp: meta.internalTpLevel ?? null,
    sessionOpposing: meta.sessionOpposingLevel ?? t.liqContext?.opposingLevel ?? null,
    tp2Price: meta.tp2Price ?? t.tpPrice ?? null,
    slPrice: t.slPrice,
    exitReason: t.exitReason,
  };
}

function statsFromRows(rows, label) {
  const pnls = rows.map((r) => r.netPnl);
  const rs = rows.map((r) => r.r).filter((x) => x != null);
  const wins = rows.filter((r) => r.netPnl > 0);
  const losses = rows.filter((r) => r.netPnl <= 0);
  const winR = wins.map((r) => r.r).filter((x) => x != null);
  const lossR = losses.map((r) => r.r).filter((x) => x != null);
  const n = rows.length;
  return {
    label,
    entries: n,
    winRatePct: n ? Math.round((wins.length / n) * 1000) / 10 : 0,
    returnPct: Math.round(pnls.reduce((a, b) => a + b, 0) / 100) / 100,
    avgWinR: winR.length ? Math.round((winR.reduce((a, b) => a + b, 0) / winR.length) * 100) / 100 : null,
    avgLossR: lossR.length
      ? Math.round((Math.abs(lossR.reduce((a, b) => a + b, 0) / lossR.length)) * 100) / 100
      : null,
    expectancyR: rs.length ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null,
  };
}

function proximityBucket(pct) {
  if (pct == null) return "n/a";
  if (pct <= 0.5) return "near_0_0.5pct";
  if (pct <= 1.0) return "mid_0.5_1pct";
  return "far_over_1pct";
}

function rangeBucket(ratio) {
  if (ratio == null) return "unknown";
  if (ratio < 0.85) return "narrow_lt_0.85x_avg";
  if (ratio > 1.15) return "wide_gt_1.15x_avg";
  return "normal_0.85_1.15x";
}

async function runCfg(rawCfg, candles, tag) {
  const cfg = materializeIntradayEngineCfgSync(
    { ...rawCfg, symbol, timeframe: tf },
    materializeIntradayPanelOnCfg,
  );
  const merged = mergeAdaptiveCfg(cfg, candles);
  const out = await runSimulation({
    candles,
    strategyKey: "SR_INTRADAY",
    cfg: {
      ...merged,
      symbol,
      timeframe: tf,
      manualStrategy: "SR_INTRADAY",
      marketMode: "FUTURES",
      riskPerTrade: RISK_PCT,
      futuresLeverage: 12,
    },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 10_000,
    timeframe: tf,
    symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, merged, tf) },
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  const trades = out.trades.filter((t) => t.entryTs >= fromMs && t.entryTs <= toMs);
  return { tag, trades };
}

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
await closePool();
const pre = precomputeIntraday(candles);

process.stderr.write("Test 1: CHoCH+FVG-mid opposing vs internal TP2...\n");
clearIntradayAdapterCache();
const opposing = await runCfg({ ...CHOCH_FVG_MID, intradaySmcTp2Mode: "opposing" }, candles, "opposing");
clearIntradayAdapterCache();
const internal = await runCfg({ ...CHOCH_FVG_MID, intradaySmcTp2Mode: "internal" }, candles, "internal");

const oppRows = aggregateByEntry(opposing.trades).map((r) => enrichEntry(r, candles, pre));
const intRows = aggregateByEntry(internal.trades).map((r) => enrichEntry(r, candles, pre));
oppRows.sort((a, b) => b.netPnl - a.netPnl);
intRows.sort((a, b) => b.netPnl - a.netPnl);

const intByTs = new Map(intRows.map((r) => [r.ts, r]));
const paired = oppRows.map((o) => ({
  ts: o.ts,
  opposing: { netPnl: o.netPnl, r: o.r, exitReason: o.exitReason },
  internal: intByTs.get(o.ts) ?? null,
}));

process.stderr.write("Test 2: Session extreme proximity on sweep baseline...\n");
const sweep = await runCfg(INTRADAY_PRO_ICT_15M, candles, "sweep");
const sweepRows = aggregateByEntry(sweep.trades).map((r) => enrichEntry(r, candles, pre));
const sessionExt = sweepRows.filter((r) => r.levelType === "session_high" || r.levelType === "session_low");

const proxSegments = {};
for (const bucket of ["near_0_0.5pct", "mid_0.5_1pct", "far_over_1pct", "n/a"]) {
  proxSegments[bucket] = statsFromRows(sessionExt.filter((r) => proximityBucket(r.pdProximityPct) === bucket), bucket);
}

const rangeSegments = {};
for (const bucket of ["narrow_lt_0.85x_avg", "normal_0.85_1.15x", "wide_gt_1.15x_avg", "unknown"]) {
  rangeSegments[bucket] = statsFromRows(oppRows.filter((r) => rangeBucket(r.priorDayRangeRatio) === bucket), bucket);
}

const lossCluster = {
  opposingLosses: oppRows.filter((r) => r.netPnl <= 0),
  byHour: {},
  bySide: { BUY: statsFromRows(oppRows.filter((r) => r.side === "BUY" && r.netPnl <= 0), "loss_buy"), SELL: statsFromRows(oppRows.filter((r) => r.side === "SELL" && r.netPnl <= 0), "loss_sell") },
};
for (const r of lossCluster.opposingLosses) {
  const h = Math.floor(r.utcHour);
  const key = `${h}h`;
  if (!lossCluster.byHour[key]) lossCluster.byHour[key] = [];
  lossCluster.byHour[key].push(r);
}

const report = {
  window: { symbol, tf, from: new Date(fromMs).toISOString().slice(0, 10), to: new Date(toMs).toISOString().slice(0, 10) },
  test1_tp2OnChochFvgMid: {
    opposing: statsFromRows(oppRows, "choch_fvg_mid_opposing_tp2"),
    internal: statsFromRows(intRows, "choch_fvg_mid_internal_tp2"),
    deltaAvgWinR:
      statsFromRows(intRows, "").avgWinR != null && statsFromRows(oppRows, "").avgWinR != null
        ? Math.round((statsFromRows(intRows, "").avgWinR - statsFromRows(oppRows, "").avgWinR) * 100) / 100
        : null,
    perTradeOpposing: oppRows,
    perTradeInternal: intRows,
    pairedByEntryTs: paired,
    lossClusterHours: Object.fromEntries(
      Object.entries(lossCluster.byHour).map(([h, rows]) => [h, { count: rows.length, totalPnl: Math.round(rows.reduce((s, r) => s + r.netPnl, 0)) }]),
    ),
    lossBySide: lossCluster.bySide,
  },
  test2_sessionExtremeProximity: {
    totalSessionExtremeTrades: sessionExt.length,
    segments: proxSegments,
  },
  test3_priorDayRangeOnChochFvgMid: {
    segments: rangeSegments,
  },
  verdict: {},
};

const oppS = report.test1_tp2OnChochFvgMid.opposing;
const intS = report.test1_tp2OnChochFvgMid.internal;
report.verdict.tp2 =
  intS.avgWinR != null && oppS.avgWinR != null && intS.avgWinR > oppS.avgWinR + 0.3
    ? `Internal TP2 raised avg win R (${oppS.avgWinR} → ${intS.avgWinR}) — TP targeting was the gap`
    : intS.returnPct > oppS.returnPct
      ? `Internal TP2 improved return (${oppS.returnPct}% → ${intS.returnPct}%) but avg win R move was modest`
      : "Internal TP2 did not materially change win profile — gap may be entry filter or loss clustering, not TP2";

const nearProx = proxSegments["near_0_0.5pct"];
const farProx = proxSegments["far_over_1pct"];
report.verdict.sessionExtreme =
  nearProx.entries >= 5 && nearProx.expectancyR != null && farProx.expectancyR != null && nearProx.expectancyR > farProx.expectancyR
    ? "Rehabilitate session extreme with PD proximity gate (near PDH/PDL sweeps better)"
    : nearProx.entries < 5
      ? "Insufficient near-PD session extreme sample"
      : "Session extreme proximity does not clearly separate quality — keep off or need more data";

const outPath = path.resolve(__dirname, "../.data/smc-ict-tp2-diagnostic.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
