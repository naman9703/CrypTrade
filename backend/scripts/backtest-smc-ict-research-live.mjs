#!/usr/bin/env node
/**
 * Frozen SMC research preset — sync live klines + full stats report.
 * Usage: node scripts/backtest-smc-ict-research-live.mjs [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = "BNBUSDT";
const tf = "15m";
const argv = process.argv.slice(2);
const skipFunnel = !argv.includes("--funnel");
const args = argv.filter((a) => !a.startsWith("--"));
const nowMs = Date.now();
const toMs = Date.parse(args[1] || new Date(nowMs).toISOString().slice(0, 10));
const fromMs = Date.parse(args[0] || "2025-06-01");
const STARTING = 10_000;
const RISK_PCT = 2.5;
const RISK_USD = STARTING * (RISK_PCT / 100);

const {
  INTRADAY_PRO_ICT_RESEARCH_15M,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const {
  buildIntradayBacktestAdapter,
  mergeAdaptiveCfg,
  precomputeIntraday,
  buildIntradayOptsFromCfg,
} = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { countSmcFunnelStages } = await import("../src/strategy/evaluateSmcIctSetup.js");
const { attachSmcHtfToPre } = await import("../src/strategy/techniques/htfBias.js");
const { maxDrawdown } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");

function wilsonCi(wins, n, z = 1.96) {
  if (!n) return { lo: 0, hi: 0 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    lo: Math.round(((centre - margin) / denom) * 1000) / 10,
    hi: Math.round(((centre + margin) / denom) * 1000) / 10,
  };
}

function aggregateTrades(trades, windowFrom, windowTo) {
  const filtered = trades.filter((t) => t.entryTs >= windowFrom && t.entryTs <= windowTo);
  const byEntry = new Map();
  for (const t of filtered) {
    const prev = byEntry.get(t.entryTs);
    if (!prev) byEntry.set(t.entryTs, { ...t, netPnl: Number(t.netPnl ?? 0) });
    else prev.netPnl += Number(t.netPnl ?? 0);
  }
  const entries = [...byEntry.values()];
  const pnls = entries.map((t) => t.netPnl);
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0).length;
  const grossWin = pnls.filter((p) => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter((p) => p < 0).reduce((a, b) => a + b, 0));
  const winPnls = pnls.filter((p) => p > 0);
  const lossPnls = pnls.filter((p) => p <= 0).map(Math.abs);
  const wr = n ? wins / n : 0;
  const avgWin = winPnls.length ? winPnls.reduce((a, b) => a + b, 0) / winPnls.length : 0;
  const avgLoss = lossPnls.length ? lossPnls.reduce((a, b) => a + b, 0) / lossPnls.length : 0;
  const avgWinR = winPnls.length ? avgWin / RISK_USD : 0;
  const avgLossR = lossPnls.length ? avgLoss / RISK_USD : 0;
  const expectancyR = wr * avgWinR - (1 - wr) * avgLossR;
  const totalPnl = pnls.reduce((a, b) => a + b, 0);

  let peak = STARTING;
  let eq = STARTING;
  let maxDd = 0;
  for (const t of filtered.slice().sort((a, b) => a.exitTs - b.exitTs)) {
    eq += Number(t.netPnl ?? 0);
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, (peak - eq) / peak);
  }

  const exitReasons = {};
  for (const t of filtered) {
    const r = t.exitReason ?? "unknown";
    exitReasons[r] = (exitReasons[r] ?? 0) + 1;
  }

  const levelTypes = {};
  for (const t of entries) {
    const lt = t.liqContext?.smcMeta?.levelType ?? t.liqContext?.levelType ?? "unknown";
    levelTypes[lt] = (levelTypes[lt] ?? 0) + 1;
  }

  return {
    entries: n,
    wins,
    losses: n - wins,
    winRatePct: n ? Math.round((wins / n) * 1000) / 10 : 0,
    wrCi95: wilsonCi(wins, n),
    returnPct: Math.round((totalPnl / STARTING) * 10000) / 100,
    totalPnlUsd: Math.round(totalPnl * 100) / 100,
    profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
    avgWinUsd: winPnls.length ? Math.round(avgWin * 100) / 100 : null,
    avgLossUsd: lossPnls.length ? Math.round(avgLoss * 100) / 100 : null,
    avgWinR: winPnls.length ? Math.round(avgWinR * 100) / 100 : null,
    avgLossR: lossPnls.length ? Math.round(avgLossR * 100) / 100 : null,
    expectancyR: n ? Math.round(expectancyR * 100) / 100 : null,
    maxDdPct: Math.round(maxDd * 10000) / 100,
    exitReasons,
    levelTypes,
    trades: entries,
    pnlDistribution: pnls.map((p) => Math.round(p * 100) / 100).sort((a, b) => b - a),
  };
}

function tradeRow(t) {
  const liq = t.liqContext ?? {};
  const meta = liq.smcMeta ?? {};
  const entry = Number(t.entryPrice ?? 0);
  const sl = Number(t.slPrice ?? 0);
  const risk = Math.abs(entry - sl);
  const rr = risk > 0 ? Math.abs(Number(t.tpPrice ?? 0) - entry) / risk : null;
  return {
    entryTime: new Date(t.entryTs).toISOString(),
    exitTime: new Date(t.exitTs).toISOString(),
    side: t.direction,
    levelType: meta.levelType ?? liq.levelType ?? null,
    sessionExtreme: meta.sessionExtreme ?? liq.sessionExtreme ?? null,
    entryPrice: entry,
    slPrice: sl,
    tpPrice: Number(t.tpPrice ?? 0),
    tp2Price: meta.tp2Price ?? liq.tp2Price ?? null,
    opposingLevel: liq.opposingLevel ?? meta.opposingLevel ?? null,
    plannedRr: meta.plannedRr ?? liq.plannedRr ?? (rr != null ? Math.round(rr * 100) / 100 : null),
    tp2Mode: meta.tp2Mode ?? liq.tp2Mode ?? null,
    internalTpLevel: meta.internalTpLevel ?? liq.internalTpLevel ?? null,
    netPnlUsd: Math.round(Number(t.netPnl ?? 0) * 100) / 100,
    netR: Math.round((Number(t.netPnl ?? 0) / RISK_USD) * 100) / 100,
    exitReason: t.exitReason ?? null,
    barsAfterReclaim: meta.barsAfterReclaim ?? null,
    fvgEntryMode: meta.fvgEntryMode ?? null,
    liqContextComplete: Boolean(liq.opposingLevel && meta.plannedRr != null),
  };
}

function funnelStats(candles, pre, cfg, windowFrom, windowTo) {
  const opts = buildIntradayOptsFromCfg(cfg);
  const c = {
    bars: 0,
    passHtf: 0,
    passKz: 0,
    passVol: 0,
    hasCycle: 0,
    passChoch: 0,
    passMss: 0,
    hasPd: 0,
    inZone: 0,
    passSetup: 0,
  };
  for (let i = 100; i < candles.length; i++) {
    if (candles[i].ts < windowFrom || candles[i].ts > windowTo) continue;
    c.bars++;
    for (const side of ["BUY", "SELL"]) {
      const st = countSmcFunnelStages(candles, i, side, pre, opts);
      if (st.passHtf) c.passHtf++;
      if (st.passKz) c.passKz++;
      if (st.passVol) c.passVol++;
      if (st.hasCycle) c.hasCycle++;
      if (st.passChoch) c.passChoch++;
      if (st.passMss) c.passMss++;
      if (st.hasPd) c.hasPd++;
      if (st.inZone) c.inZone++;
      if (st.passSetup) c.passSetup++;
    }
  }
  return c;
}

await initPool({ info: () => {}, warn: () => {}, error: console.error });
process.stderr.write(`Syncing ${symbol} ${tf} klines ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}...\n`);
const inFrom = Date.parse("2026-01-01");
const inTo = Date.parse("2026-05-27");
const oosFrom = Date.parse("2025-06-01");
const oosTo = Date.parse("2025-12-31");

const sync = await ensureKlines(symbol, tf, { from: fromMs - 10 * 864e5, to: toMs + 864e5, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs - 10 * 864e5, toMs + 864e5);
const cInIsolated = await readCandles(symbol, tf, inFrom - 5 * 864e5, inTo);
const cOosIsolated = await readCandles(symbol, tf, oosFrom - 5 * 864e5, oosTo);
await closePool();

if (!candles.length) {
  console.error("No candles after sync — check DB / network.");
  process.exit(1);
}

const lastBar = candles.at(-1);
process.stderr.write(`Loaded ${candles.length} bars; last bar ${new Date(lastBar.ts).toISOString()}\n`);

async function runSim(candleSlice, tag) {
  clearIntradayAdapterCache();
  const cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_ICT_RESEARCH_15M, symbol, timeframe: tf },
    materializeIntradayPanelOnCfg,
  );
  const merged = mergeAdaptiveCfg(cfg, candleSlice);
  process.stderr.write(`Running simulation (${tag}, ${candleSlice.length} bars)...\n`);
  const out = await runSimulation({
    candles: candleSlice,
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
    startingUsdt: STARTING,
    timeframe: tf,
    symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candleSlice, merged, tf) },
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });
  return { out, merged, mdd: maxDrawdown(out.equityCurve ?? []) };
}

const { out, merged, mdd } = await runSim(candles, "continuous_full_range");

const isolatedIn = await runSim(cInIsolated, "isolated_in_sample");
const isolatedOos = await runSim(cOosIsolated, "isolated_oos");

function windowSummary(out, from, to, label) {
  const s = aggregateTrades(out.trades, from, to);
  return {
    label,
    entries: s.entries,
    wins: s.wins,
    losses: s.losses,
    winRatePct: s.winRatePct,
    wrCi95: s.wrCi95,
    returnPct: s.returnPct,
    totalPnlUsd: s.totalPnlUsd,
    profitFactor: s.profitFactor,
    avgWinUsd: s.avgWinUsd,
    avgLossUsd: s.avgLossUsd,
    avgWinR: s.avgWinR,
    avgLossR: s.avgLossR,
    expectancyR: s.expectancyR,
    pnlDistribution: s.pnlDistribution,
  };
}

const windows = {
  oos_2025: { from: oosFrom, to: oosTo, label: "OOS Jun–Dec 2025" },
  inSample_2026: { from: inFrom, to: inTo, label: "In-sample Jan–May 2026" },
  postFreeze_live: { from: Date.parse("2026-05-28"), to: toMs, label: "Post-freeze live extension" },
  ytd_2026: { from: Date.parse("2026-01-01"), to: toMs, label: "YTD 2026 (through latest bar)" },
  fullRange: { from: fromMs, to: toMs, label: "Full synced range" },
};

const windowStats = {};
for (const [key, w] of Object.entries(windows)) {
  windowStats[key] = { label: w.label, ...aggregateTrades(out.trades, w.from, w.to) };
}

const pre = precomputeIntraday(candles);
attachSmcHtfToPre(candles, pre);
const funnels = {};
if (!skipFunnel) {
  process.stderr.write("Computing funnel stages...\n");
  for (const [key, w] of Object.entries(windows)) {
    if (key === "fullRange") continue;
    funnels[key] = funnelStats(candles, pre, merged, w.from, w.to);
  }
}

const inSample = windowStats.inSample_2026;
const tradeLog = inSample.trades.map(tradeRow);
const liqContextComplete = tradeLog.filter((t) => t.liqContextComplete).length;

const report = {
  preset: "INTRADAY_PRO_ICT_RESEARCH_15M",
  status: "research_only — frozen config, data collection not profit center",
  config: {
    stack: "CHoCH + FVG-mid + internal TP2 + minRr 1.5 + session extreme ON",
    symbol,
    timeframe: tf,
    riskPerTradePct: RISK_PCT,
    leverage: 12,
    startingUsdt: STARTING,
    riskUsdPerTrade: RISK_USD,
  },
  dataSync: {
    from: new Date(fromMs).toISOString().slice(0, 10),
    to: new Date(toMs).toISOString().slice(0, 10),
    candlesLoaded: candles.length,
    lastBarTime: new Date(lastBar.ts).toISOString(),
    klinesInserted: sync.inserted,
    klineGaps: sync.gaps,
  },
  methodologyNote: {
    continuous:
      "One sim from Jun 2025 with $10k start. OOS losses reduce equity before in-sample → smaller position sizes (PCT_EQUITY risk). Matches live deployment path.",
    isolated:
      "Fresh $10k sim per window (matches backtest-smc-ict-research-1h.mjs). Use for research expectancy / +0.27R comparisons.",
  },
  simulation: {
    mode: "continuous_full_range",
    finalEquity: Math.round(out.finalEquity * 100) / 100,
    maxDrawdownPct: Math.round(mdd.maxDrawdownPct * 100) / 100,
    totalRawTrades: out.trades.length,
  },
  isolatedWindows: {
    inSample_2026: windowSummary(isolatedIn.out, inFrom, inTo, "Isolated in-sample (fresh $10k)"),
    oos_2025: windowSummary(isolatedOos.out, oosFrom, oosTo, "Isolated OOS (fresh $10k)"),
  },
  windows: Object.fromEntries(
    Object.entries(windowStats).map(([k, v]) => [
      k,
      {
        label: v.label,
        entries: v.entries,
        wins: v.wins,
        losses: v.losses,
        winRatePct: v.winRatePct,
        wrCi95: v.wrCi95,
        returnPct: v.returnPct,
        totalPnlUsd: v.totalPnlUsd,
        profitFactor: v.profitFactor,
        avgWinUsd: v.avgWinUsd,
        avgLossUsd: v.avgLossUsd,
        avgWinR: v.avgWinR,
        avgLossR: v.avgLossR,
        expectancyR: v.expectancyR,
        maxDdPct: v.maxDdPct,
        exitReasons: v.exitReasons,
        levelTypes: v.levelTypes,
        pnlDistribution: v.pnlDistribution,
        tradesPerMonth: v.entries
          ? Math.round((v.entries / ((windows[k]?.to - windows[k]?.from) / (30 * 864e5))) * 100) / 100
          : 0,
      },
    ]),
  ),
  funnels,
  inSampleTradeLog: tradeLog,
  forensics: {
    liqContextCompletePct: inSample.entries
      ? Math.round((liqContextComplete / inSample.entries) * 1000) / 10
      : 0,
    liqContextCompleteCount: `${liqContextComplete}/${inSample.entries}`,
  },
};

const outPath = path.resolve(__dirname, "../.data/smc-ict-research-live.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
process.stderr.write(`Wrote ${outPath}\n`);
console.log(JSON.stringify(report, null, 2));
