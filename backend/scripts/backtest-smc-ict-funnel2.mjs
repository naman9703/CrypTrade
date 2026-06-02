#!/usr/bin/env node
/**
 * SMC/ICT funnel — stages from evaluateSmcIctSetup.countSmcFunnelStages.
 * Usage: node scripts/backtest-smc-ict-funnel2.mjs [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = process.env.TUNE_SYMBOL || "BNBUSDT";
const tf = "15m";
const fromMs = Date.parse(process.argv[2] || "2026-01-01");
const toMs = Date.parse(process.argv[3] || "2026-05-27");
const WARMUP = 100;

const { INTRADAY_PRO_ICT_15M, fillSmcSoloPresetDefaults } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { precomputeIntraday, buildIntradayOptsFromCfg } = await import("../src/strategy/intradayPro.js");
const { countSmcFunnelStages } = await import("../src/strategy/evaluateSmcIctSetup.js");
const { attachSmcHtfToPre } = await import("../src/strategy/techniques/htfBias.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
await closePool();
if (!candles.length) {
  console.error("No candles — sync klines first.");
  process.exit(1);
}

const cfg = fillSmcSoloPresetDefaults({ ...INTRADAY_PRO_ICT_15M, symbol, timeframe: tf });
const opts = buildIntradayOptsFromCfg(cfg);
const pre = precomputeIntraday(candles);
attachSmcHtfToPre(candles, pre);

const c = {
  bars: 0,
  sideTries: 0,
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

for (let i = WARMUP; i < candles.length; i++) {
  const bar = candles[i];
  if (bar.ts < fromMs || bar.ts > toMs) continue;
  c.bars++;
  for (const side of ["BUY", "SELL"]) {
    c.sideTries++;
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

console.log(
  JSON.stringify(
    {
      symbol,
      tf,
      from: new Date(fromMs).toISOString().slice(0, 10),
      to: new Date(toMs).toISOString().slice(0, 10),
      profile: opts.intradaySmcIctProfile,
      bars: c.bars,
      funnel: c,
      rates: {
        passHtf: c.passHtf / c.sideTries,
        passSetup: c.passSetup / c.sideTries,
        inZoneOfPd: c.hasPd ? c.inZone / c.hasPd : 0,
      },
    },
    null,
    2,
  ),
);
