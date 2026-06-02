#!/usr/bin/env node
/**
 * Frozen SMC research configs — 15m (confirm) + 1H parallel (in-sample + OOS).
 * Usage: node scripts/backtest-smc-ict-research-1h.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = "BNBUSDT";
const inFrom = Date.parse("2026-01-01");
const inTo = Date.parse("2026-05-27");
const oosFrom = Date.parse("2025-06-01");
const oosTo = Date.parse("2025-12-31");

const {
  INTRADAY_PRO_ICT_RESEARCH_15M,
  INTRADAY_PRO_ICT_RESEARCH_1H,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { buildIntradayBacktestAdapter, mergeAdaptiveCfg } = await import("../src/strategy/intradayPro.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");

function stats(trades, fromMs, toMs, label) {
  const byEntry = new Map();
  for (const t of trades.filter((x) => x.entryTs >= fromMs && x.entryTs <= toMs)) {
    byEntry.set(t.entryTs, (byEntry.get(t.entryTs) ?? 0) + Number(t.netPnl ?? 0));
  }
  const pnls = [...byEntry.values()];
  const n = pnls.length;
  const wins = pnls.filter((p) => p > 0).length;
  const STARTING = 10_000;
  const risk = STARTING * 0.025;
  const rs = pnls.map((p) => Math.round((p / risk) * 100) / 100);
  const winR = rs.filter((r, i) => pnls[i] > 0);
  const lossR = rs.filter((r, i) => pnls[i] <= 0).map(Math.abs);
  const wr = n ? wins / n : 0;
  const aw = winR.length ? winR.reduce((a, b) => a + b, 0) / winR.length : 0;
  const al = lossR.length ? lossR.reduce((a, b) => a + b, 0) / lossR.length : 0;
  return {
    label,
    entries: n,
    winRatePct: n ? Math.round((wins / n) * 1000) / 10 : 0,
    returnPct: Math.round((pnls.reduce((a, b) => a + b, 0) / STARTING) * 10000) / 100,
    totalPnlUsd: Math.round(pnls.reduce((a, b) => a + b, 0) * 100) / 100,
    avgWinR: winR.length ? Math.round(aw * 100) / 100 : null,
    avgLossR: lossR.length ? Math.round(al * 100) / 100 : null,
    expectancyR: n ? Math.round((wr * aw - (1 - wr) * al) * 100) / 100 : null,
    pnlDistribution: pnls
      .map((p) => Math.round(p * 100) / 100)
      .sort((a, b) => b - a),
  };
}

async function runPreset(preset, candles, fromMs, toMs, tag) {
  clearIntradayAdapterCache();
  const tf = preset.timeframe ?? "15m";
  const cfg = materializeIntradayEngineCfgSync(
    { ...preset, symbol, timeframe: tf },
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
      riskPerTrade: 2.5,
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
  return stats(out.trades, fromMs, toMs, tag);
}

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const c15In = await readCandles(symbol, "15m", inFrom - 5 * 864e5, inTo);
const c15Oos = await readCandles(symbol, "15m", oosFrom - 5 * 864e5, oosTo);
const c1hIn = await readCandles(symbol, "1h", inFrom - 10 * 864e5, inTo);
const c1hOos = await readCandles(symbol, "1h", oosFrom - 10 * 864e5, oosTo);
await closePool();

process.stderr.write("15m research frozen...\n");
const m15In = await runPreset(INTRADAY_PRO_ICT_RESEARCH_15M, c15In, inFrom, inTo, "15m_in");
const m15Oos = await runPreset(INTRADAY_PRO_ICT_RESEARCH_15M, c15Oos, oosFrom, oosTo, "15m_oos");
process.stderr.write("1H research parallel...\n");
const h1In = await runPreset(INTRADAY_PRO_ICT_RESEARCH_1H, c1hIn, inFrom, inTo, "1h_in");
const h1Oos = await runPreset(INTRADAY_PRO_ICT_RESEARCH_1H, c1hOos, oosFrom, oosTo, "1h_oos");

const report = {
  frozenConfig: {
    stack: "CHoCH + FVG-mid + internal TP2 + minRr 1.5 + session extreme ON",
    status: "research_only — do not tune; collect live trades at minimal size",
  },
  results: { m15In, m15Oos, h1In, h1Oos },
  verdict: {
    confirmed15m: m15In.expectancyR > 0 ? `+${m15In.expectancyR}R/trade n=${m15In.entries} (pilot, not confirmed)` : "not positive",
    h1BetterGeometry:
      h1In.expectancyR > m15In.expectancyR && h1Oos.expectancyR > m15Oos.expectancyR
        ? "1H shows better in-sample and OOS expectancy — worth parallel collection"
        : h1In.expectancyR > 0
          ? "1H in-sample positive — run OOS before shifting focus"
          : "1H did not improve on frozen stack — stay on 15m data collection",
  },
};

const outPath = path.resolve(__dirname, "../.data/smc-ict-research-1h.json");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
