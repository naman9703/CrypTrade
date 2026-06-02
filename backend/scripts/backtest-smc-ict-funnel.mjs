#!/usr/bin/env node
/**
 * SMC/ICT full pipeline funnel — stage drop-off counts.
 * Usage: node scripts/backtest-smc-ict-funnel.mjs [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const symbol = "BNBUSDT";
const tf = "15m";
const fromMs = Date.parse(process.argv[2] || "2026-01-01");
const toMs = Date.parse(process.argv[3] || "2026-05-27");
const WARMUP = 100;

const { INTRADAY_PRO_ICT_15M } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { initPool, closePool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { precomputeIntraday, selectIntradayPicks, buildIntradayOptsFromCfg } = await import(
  "../src/strategy/intradayPro.js",
);
const { fillSmcSoloPresetDefaults } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { passesSmcHtfBias } = await import("../src/strategy/techniques/htfBias.js");
const { inSmcKillzone } = await import("../src/strategy/techniques/sessionKillzones.js");
const { passesSmcVolatilityFilter } = await import("../src/strategy/techniques/smcVolatility.js");
const { listSessionLiquiditySetups } = await import("../src/strategy/techniques/liquidity.js");
const { detectChochAfterBar, detectBosAfterBar } = await import("../src/strategy/techniques/bosChoch.js");
const { evaluateSmcIctSetup } = await import("../src/strategy/evaluateSmcIctSetup.js");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const candles = await readCandles(symbol, tf, fromMs - 5 * 864e5, toMs);
await closePool();

if (!candles.length) {
  console.error("No candles — sync klines first.");
  process.exit(1);
}

const cfg = fillSmcSoloPresetDefaults({ ...INTRADAY_PRO_ICT_15M, symbol, timeframe: tf });
const opts = { ...buildIntradayOptsFromCfg(cfg), _liqPre: null };
const pre = precomputeIntraday(candles);
opts._liqPre = pre;

const counts = {
  bars: 0,
  passHtf: 0,
  passKillzone: 0,
  passVol: 0,
  reclaims: 0,
  passChoch: 0,
  passBos: 0,
  passSetup: 0,
};

for (let i = WARMUP; i < candles.length; i++) {
  if (candles[i].ts < fromMs || candles[i].ts > toMs) continue;
  counts.bars++;
  for (const side of ["BUY", "SELL"]) {
    if (passesSmcHtfBias(side, pre, i, opts)) counts.passHtf++;
    if (!inSmcKillzone(candles[i].ts, opts)) continue;
    counts.passKillzone++;
    if (!passesSmcVolatilityFilter(candles, i, pre, opts)) continue;
    counts.passVol++;
    const setups = listSessionLiquiditySetups(candles, i, side, pre, opts);
    for (const s of setups) {
      if (s.reclaimIdx !== i) continue;
      counts.reclaims++;
      const choch = detectChochAfterBar(candles, i, side, opts);
      if (opts.intradaySmcRequireChoch === true && !choch.ok) continue;
      counts.passChoch++;
      const bos = detectBosAfterBar(candles, choch.ok ? choch.chochIdx : i, side, opts);
      if (opts.intradaySmcRequireBos !== false && !bos.ok) continue;
      counts.passBos++;
      if (evaluateSmcIctSetup(candles, i, side, pre, opts)) counts.passSetup++;
    }
  }
}

const { series } = selectIntradayPicks(candles, cfg);
const picks = series.filter((s) => s?.action).length;

console.log(
  JSON.stringify({ symbol, tf, fromMs, toMs, counts, picksAfterCaps: picks }, null, 2),
);
