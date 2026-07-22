#!/usr/bin/env node
/** SOL H8_bear_rej — risk sweep for MC p5 / Calmar gate flip. */
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const SYMBOL = "SOLUSDT";
const TF = "15m";
const FROM = "2021-01-01";
const TO = "2026-05-31";
const START = 100;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const { VOLUME_PROFILE_BASE, VOLUME_PROFILE_FREQ_CORE, volumeProfilePadFromMs } = await import(
  "../src/strategy/presets/volumeProfileOptimized.js",
);
const { monteCarloBootstrap, acceptanceGates } = await import("../src/backtest/engine/validation.js");

const BASE_PATCH = {
  ...VOLUME_PROFILE_BASE,
  ...VOLUME_PROFILE_FREQ_CORE,
  symbol: SYMBOL,
  timeframe: TF,
  vpAllowedSetups: ["val_breakdown", "va_rejection"],
  vpRequireHtfAlign: true,
  vpMinHtfSepPct: 0.0015,
  vpMinScore: 7,
  vpMinBarGap: 2,
  vpMaxTradesPerDay: 2,
  vpValSellRequirePrior60dBear: true,
  vpValSellPrior60dBearPct: -0.05,
  vpRejectionSellBlockExtendedDown: true,
  vpRejectionExtendedPriorPct: 0.05,
  vpRejectionMinWickRatio: 0.35,
  vpNoveltyEnabled: false,
};

const RISKS = [2.5, 2.0, 1.75, 1.5, 1.25];

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const padFrom = volumeProfilePadFromMs(fromMs, TF, BASE_PATCH);
const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
let funding = [];
try {
  funding = await readFundingRates(SYMBOL, padFrom, toMs);
} catch {
  funding = [];
}

const rows = [];
for (const risk of RISKS) {
  const cfg = {
    ...BASE_PATCH,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: risk,
    riskPerTradeUnit: "PCT",
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
  };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: funding,
    startingUsdt: START,
    timeframe: TF,
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF) },
    symbol: SYMBOL,
  });
  const closed = (sim.trades ?? []).filter((t) => String(t.exitReason ?? "") !== "tp1_partial");
  const m = computeAllMetrics({ trades: closed, equityCurve: sim.equityCurve, tf: TF, startingEquity: START });
  const mc = monteCarloBootstrap(rMultipleStats(sim.trades).rValues, {
    paths: 3000,
    riskFrac: 0.01,
    ruinDrawdownPct: 50,
  });
  const gate = acceptanceGates({
    oosReturnPct: m.totalReturnPct,
    mcP5ReturnPct: mc.insufficient ? -1 : mc.p5ReturnPct,
    calmar: m.calmar ?? -1,
    walkForwardDegradationPct: 0,
  });
  rows.push({
    risk,
    trades: closed.length,
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    calmar: +(m.calmar ?? 0).toFixed(2),
    mcP5: mc.insufficient ? null : +mc.p5ReturnPct.toFixed(2),
    allPass: gate.allPass,
    gates: Object.entries(gate.gates).map(([k, g]) => `${g.pass ? "P" : "F"}:${k}`).join(" "),
  });
  console.log(
    `risk=${risk}%  ret=${rows.at(-1).ret}% DD=${rows.at(-1).dd}% Cal=${rows.at(-1).calmar} MCp5=${rows.at(-1).mcP5}% ${rows.at(-1).gates}`,
  );
}

fs.writeFileSync(path.join(__dirname, ".vp-freq-sol-h8-risk-sweep.json"), JSON.stringify({ rows }, null, 2));
await closePool?.();
