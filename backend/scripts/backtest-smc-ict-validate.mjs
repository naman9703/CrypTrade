#!/usr/bin/env node
/**
 * Validated ICT path: CHoCH + FVG-mid + internal TP2 + minRr 1.2 + PDH/PDL only.
 * In-sample + OOS (zero param changes).
 * Usage: node scripts/backtest-smc-ict-validate.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = process.env.TUNE_SYMBOL || "BNBUSDT";
const tf = "15m";
const inFrom = Date.parse("2026-01-01");
const inTo = Date.parse("2026-05-27");
const oosFrom = Date.parse("2025-06-01");
const oosTo = Date.parse("2025-12-31");
const RISK = 2.5;

const { INTRADAY_PRO_ICT_PDH_FVG_MID_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js"
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");

function aggregate(trades) {
  const m = new Map();
  for (const t of trades) {
    m.set(t.entryTs, (m.get(t.entryTs) ?? 0) + Number(t.netPnl ?? 0));
  }
  return [...m.entries()].map(([ts, netPnl]) => ({ ts, netPnl }));
}

function rMultiple(netPnl, equityAtEntry = 10_000) {
  const risk = equityAtEntry * (RISK / 100);
  return risk > 0 ? Math.round((netPnl / risk) * 100) / 100 : null;
}

function stats(rows, label) {
  const n = rows.length;
  const wins = rows.filter((r) => r.netPnl > 0);
  const losses = rows.filter((r) => r.netPnl <= 0);
  const winR = wins.map((r) => r.r).filter((x) => x != null);
  const lossR = losses.map((r) => r.r).filter((x) => x != null);
  const winRate = n ? wins.length / n : 0;
  const avgWinR = winR.length ? winR.reduce((a, b) => a + b, 0) / winR.length : 0;
  const avgLossR = lossR.length ? Math.abs(lossR.reduce((a, b) => a + b, 0) / lossR.length) : 0;
  const pnl = rows.reduce((s, r) => s + r.netPnl, 0);
  return {
    label,
    entries: n,
    winRatePct: n ? Math.round((wins.length / n) * 1000) / 10 : 0,
    returnPct: Math.round((pnl / 10_000) * 10000) / 100,
    avgWinR: winR.length ? Math.round(avgWinR * 100) / 100 : null,
    avgLossR: lossR.length ? Math.round(avgLossR * 100) / 100 : null,
    expectancyR: n ? Math.round((winRate * avgWinR - (1 - winRate) * avgLossR) * 100) / 100 : null,
    pnlDistribution: rows
      .map((r) => ({
        ts: new Date(r.ts).toISOString().slice(0, 16),
        netPnl: Math.round(r.netPnl * 100) / 100,
        r: r.r,
      }))
      .sort((a, b) => b.netPnl - a.netPnl),
  };
}

async function runWindow(candles, fromMs, toMs, tag) {
  clearIntradayAdapterCache();
  const cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_ICT_PDH_FVG_MID_15M, symbol, timeframe: tf },
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
      riskPerTrade: RISK,
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
  const rows = aggregate(trades).map(({ ts, netPnl }) => {
    const t = trades.find((x) => x.entryTs === ts);
    return { ts, netPnl, r: rMultiple(netPnl, t?.equityAtEntry) };
  });
  return stats(rows, tag);
}

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const inCandles = await readCandles(symbol, tf, inFrom - 5 * 864e5, inTo);
const oosCandles = await readCandles(symbol, tf, oosFrom - 5 * 864e5, oosTo);
await closePool();

process.stderr.write("In-sample validated config...\n");
const inSample = await runWindow(inCandles, inFrom, inTo, "in_sample");
process.stderr.write("OOS validated config (zero param change)...\n");
const oos = await runWindow(oosCandles, oosFrom, oosTo, "oos_jun_dec_2025");

const report = {
  config: {
    preset: "INTRADAY_PRO_ICT_PDH_FVG_MID_15M",
    choch: true,
    fvgMid: true,
    tp2Mode: "internal",
    minRr: 1.2,
    sessionExtreme: false,
    pdhPdlOnly: true,
  },
  inSample,
  oos,
  verdict:
    inSample.expectancyR > 0 && inSample.entries >= 15
      ? oos.expectancyR >= -0.1
        ? "In-sample positive; OOS near breakeven or better — candidate for extended validation"
        : "In-sample positive but OOS still negative — regime gate needed before live"
      : inSample.entries < 15
        ? "In-sample positive direction but sample too thin — extend date range"
        : "In-sample not confirmed — do not proceed to OOS tuning",
};

const outPath = path.resolve(__dirname, "../.data/smc-ict-validate.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
