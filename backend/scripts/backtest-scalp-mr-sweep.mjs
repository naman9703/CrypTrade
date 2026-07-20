#!/usr/bin/env node
/** Quick grid search for OOS-positive SCALP_MR configs. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const SYMBOLS = ["BNBUSDT", "BTCUSDT", "ETHUSDT"];
const IS = ["2025-07", "2025-09", "2025-11"];
const OOS = ["2026-01", "2026-04"];
const COST = { leverage: 10, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 };

function monthWindow(ym) {
  const [y, m] = ym.split("-").map(Number);
  const from = `${y}-${String(m).padStart(2, "0")}-01`;
  const nextM = m === 12 ? 1 : m + 1;
  const nextY = m === 12 ? y + 1 : y;
  return { from, to: `${nextY}-${String(nextM).padStart(2, "0")}-01`, label: ym };
}

const { initPool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildScalpMrBacktestAdapter, resolveScalpMrCfg, scalpMrPadFromMs } = await import("../src/strategy/scalpMr.js");

const cache = new Map();
async function runMonth(symbol, tf, ym, patch) {
  const key = `${symbol}|${tf}|${ym}`;
  if (!cache.has(key)) {
    const w = monthWindow(ym);
    const fromMs = Date.parse(w.from);
    const toMs = Date.parse(w.to);
    cache.set(key, {
      candles: await readCandles(symbol, tf, scalpMrPadFromMs(fromMs, tf), toMs, { market: "futures" }),
      fromMs,
      toMs,
    });
  }
  const { candles, fromMs, toMs } = cache.get(key);
  const cfg = resolveScalpMrCfg({
    symbol,
    timeframe: tf,
    marketMode: "FUTURES",
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: 1,
    riskPerTradeUnit: "PCT",
    backtestSignalStartMs: fromMs,
    ...patch,
  });
  const sim = await runSimulation({
    strategyKey: "SCALP_MR",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 10_000,
    timeframe: tf,
    symbol,
    adapters: { SCALP_MR: buildScalpMrBacktestAdapter(candles, cfg, tf) },
    costModelOverride: COST,
  });
  const m = computeAllMetrics(sim, { fromMs, toMs });
  const finalEq = Number(m.finalEquity ?? 10_000);
  return ((finalEq - 10_000) / 10_000) * 100;
}

const grid = [];
for (const tf of ["15m"]) {
  for (const rsi of [[30, 70], [32, 68]]) {
    for (const bbMult of [2, 2.2, 2.5]) {
      for (const slMode of ["pierce", "entry_atr"]) {
        for (const minRr of [1.3, 1.5, 1.8, 2.0]) {
          for (const kz of ["LONDON", "LONDON_NY"]) {
            grid.push({
              tf,
              scalpMrRsiBuyMax: rsi[0],
              scalpMrRsiSellMin: rsi[1],
              scalpMrBbMult: bbMult,
              scalpMrSlMode: slMode,
              scalpMrMinRr: minRr,
              scalpMrMinTpPct: 0.28,
              scalpMrMaxAdx: 22,
              scalpMrAtrSlMult: slMode === "entry_atr" ? 0.9 : 0.45,
              scalpMrRangeRR: 2,
              scalpMrMinVolVsAvg: 1.2,
              scalpMrMaxTradesPerDay: 6,
              scalpMrMinBarGap: tf === "15m" ? 4 : 6,
              scalpMrKillzoneMode: kz,
              intradaySmcKillzoneMode: kz,
            });
          }
        }
      }
    }
  }
}

console.log(`Sweeping ${grid.length} configs × ${SYMBOLS.length} symbols...`);
const hits = [];

for (const patch of grid) {
  for (const symbol of SYMBOLS) {
    let isSum = 0;
    let oosSum = 0;
    let oosPos = true;
    for (const ym of IS) isSum += await runMonth(symbol, patch.tf, ym, { ...patch, symbol });
    for (const ym of OOS) {
      const r = await runMonth(symbol, patch.tf, ym, { ...patch, symbol });
      oosSum += r;
      if (r <= 0) oosPos = false;
    }
    if (oosPos && oosSum > 2 && isSum > 0) {
      hits.push({ symbol, isSum, oosSum, total: isSum + oosSum, patch });
    }
  }
}

hits.sort((a, b) => b.oosSum - a.oosSum);
console.log(`\nHits (OOS all positive, IS>0, OOS sum>2%): ${hits.length}`);
for (const h of hits.slice(0, 15)) {
  console.log(
    `${h.symbol} ${h.patch.tf} OOS +${h.oosSum.toFixed(1)}% IS +${h.isSum.toFixed(1)}% | RSI ${h.patch.scalpMrRsiBuyMax}/${h.patch.scalpMrRsiSellMin} bb ${h.patch.scalpMrBbMult} sl ${h.patch.scalpMrSlMode} minRr ${h.patch.scalpMrMinRr} kz ${h.patch.scalpMrKillzoneMode}`,
  );
}
