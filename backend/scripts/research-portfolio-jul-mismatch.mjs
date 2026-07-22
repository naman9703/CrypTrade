#!/usr/bin/env node
/** Unit-sim Jul mismatch: long vs short portfolio windows. */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });
dotenv.config({ path: path.resolve(__dirname, "../../.env"), override: false });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const {
  buildVolumeProfileBacktestAdapter,
  precomputeVolumeProfile,
} = await import("../src/strategy/volumeProfileStrategy.js");
const {
  fillVolumeProfileFreqDefaults,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const JUL_FROM = Date.parse("2026-07-01T00:00:00Z");
const JUL_TO = Date.parse("2026-07-21T00:00:00Z");
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT", "SOLUSDT"];

const snap = JSON.parse(fs.readFileSync("/tmp/runA_cfg.json", "utf8"));
const bot = snap.bot ?? {};

async function unitSim(label, sym, fromMs, toMs) {
  const cfg = fillVolumeProfileFreqDefaults({
    ...bot,
    symbol: sym,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: bot.slippagePct ?? 0.0005,
    maxDailyLoss: 0,
    backtestSignalStartMs: fromMs,
  });
  const padFrom = volumeProfilePadFromMs(fromMs, "15m", cfg);
  const candles = await readCandles(sym, "15m", padFrom, toMs, { market: "futures" });
  const pre = precomputeVolumeProfile(candles, cfg);
  const idxAt = (ms) => candles.findIndex((c) => Number(c.ts) >= ms);
  const i1 = idxAt(fromMs);
  const i12 = idxAt(Date.parse("2026-07-12T01:15:00Z"));
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: "15m",
    adapters: { VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, "15m") },
    symbol: sym,
  });
  const jul = (sim.trades ?? [])
    .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
    .filter((t) => {
      const ts = Number(t.entryTs);
      return ts >= JUL_FROM && ts < JUL_TO;
    });
  return {
    label,
    sym,
    padDays: ((fromMs - padFrom) / 864e5).toFixed(1),
    bars: candles.length,
    setups: cfg.vpAllowedSetups,
    bear60: cfg.vpValSellRequirePrior60dBear === true,
    flat60: cfg.vpValSellBlockFlatPrior60 === true,
    prior60_start: i1 >= 0 ? pre.macroPrior60d[i1] : null,
    prior60_jul12: i12 >= 0 ? pre.macroPrior60d[i12] : null,
    trades: jul.map((t) => ({
      entry: new Date(t.entryTs).toISOString().slice(0, 16),
      reason: t.entryReason,
      pnl: +Number(t.netPnl).toFixed(2),
    })),
  };
}

const windows = [
  { label: "LONG_Jan", from: Date.parse("2026-01-01Z"), to: JUL_TO },
  { label: "SHORT_Jul", from: JUL_FROM, to: JUL_TO },
];

for (const w of windows) {
  console.log(`\n===== ${w.label} ${new Date(w.from).toISOString().slice(0, 10)}→${new Date(w.to).toISOString().slice(0, 10)} =====`);
  for (const sym of SYMBOLS) {
    const r = await unitSim(w.label, sym, w.from, w.to);
    console.log(
      `${sym.padEnd(8)} pad=${r.padDays}d bear60=${r.bear60} flat60=${r.flat60} prior60@start=${r.prior60_start} @Jul12=${r.prior60_jul12} setups=${JSON.stringify(r.setups)}`,
    );
    if (!r.trades.length) console.log("         Jul trades: NONE");
    for (const t of r.trades) console.log(`         ${t.entry} ${t.reason} pnl=${t.pnl}`);
  }
}

await closePool?.();
