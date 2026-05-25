#!/usr/bin/env node
/** Compare HTF_RSI v1 (old logic) vs v2 (robust filters) on same window as recent run. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const FROM = new Date("2026-01-01").getTime();
const TO = new Date("2026-05-17").getTime();
const CAP = 1000;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const ind = await import("../src/strategy/indicators.js");
const { ema } = ind;
const computeRsi = ind.rsi;
const computeAtr = ind.atr;

function signalV1({ candles }) {
  const WARMUP = 80;
  if (candles.length < WARMUP) return { action: "HOLD" };
  const hourly = [];
  for (let i = 0; i + 3 < candles.length; i += 4) hourly.push({ close: candles[i + 3].close });
  if (hourly.length < 22) return { action: "HOLD" };
  const hCloses = hourly.map((c) => c.close);
  const hEma21 = ema(hCloses, 21);
  const hEma50 = ema(hCloses, 50);
  const hLast = hourly.length - 1;
  const htfE21 = hEma21[hLast];
  const htfE50 = hEma50[hLast];
  const htfUp = htfE21 > htfE50;
  const htfDown = htfE21 < htfE50;
  const htfSep = Math.abs(htfE21 - htfE50) / htfE50;
  if (htfSep < 0.0005) return { action: "HOLD" };
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => Number(c.volume) || 0);
  const i = candles.length - 1;
  const bar = candles[i];
  const prev = candles[i - 1];
  const rsiSeries = computeRsi(closes, 14);
  const atrSeries = computeAtr(candles, 14);
  const rsiNow = rsiSeries[i];
  const rsiPrev = rsiSeries[i - 1];
  const atrVal = atrSeries[i];
  if (!Number.isFinite(rsiNow)) return { action: "HOLD" };
  if (atrVal > 0 && (bar.high - bar.low) / atrVal > 4) return { action: "HOLD" };
  const volSlice = volumes.slice(Math.max(0, i - 20), i);
  const avgVol = volSlice.length ? volSlice.reduce((a, b) => a + b, 0) / volSlice.length : 0;
  if (avgVol > 0 && volumes[i] < 0.8 * avgVol) return { action: "HOLD" };
  if (htfUp && rsiNow <= 35) {
    const recovering = rsiNow > rsiPrev;
    const barOk = bar.close >= bar.open;
    if (recovering || (rsiNow <= 28 && barOk)) return { action: "BUY" };
  }
  if (htfDown && rsiNow >= 65) {
    const rejecting = rsiNow < rsiPrev;
    const barOk = bar.close <= bar.open;
    if (rejecting || (rsiNow >= 72 && barOk)) return { action: "SELL" };
  }
  return { action: "HOLD" };
}

const { signal: signalV2 } = await import("../src/strategy/htfRsi.js");

function makeAdapter(signalFn) {
  let lastDir = 0;
  return function (bar, idx, ctx) {
    if (idx < 80) return null;
    const slice = ctx.candles.slice(0, idx + 1);
    const sig = signalFn({ candles: slice, timeframe: ctx.timeframe });
    if (!sig || sig.action === "HOLD") return null;
    if (sig.action === "BUY" && lastDir !== 1) {
      lastDir = 1;
      return sig;
    }
    if (sig.action === "SELL" && lastDir !== -1) {
      lastDir = -1;
      return sig;
    }
    return null;
  };
}

const cfg = {
  marketMode: "FUTURES",
  futuresLeverage: 50,
  supertrendFuturesAuto: false,
  supertrendFuturesFixedSlPct: 0.008,
  supertrendFuturesFixedTpPct: 0.025,
  trailingStopLossAuto: true,
  futuresTrailingStopMode: "SUPERTREND",
  futuresTrailingStFeeBreakeven: false,
  futuresTrailingStAdvanced: true,
  trailBufferMode: "ATR",
  trailBufferAtrMult: 0.6,
  trailBufferRate: 0.002,
  supertrendMultiplier: 4,
  supertrendPeriod: 10,
  supertrendMoveQualityGate: false,
  signalStrengthGatesTrades: false,
  riskPerTrade: 5,
  riskPerTradeUnit: "PCT_EQUITY",
  backtestPositionSizing: "FULL_EQUITY_MARGIN",
  slippagePct: 0.0001,
  strategyMode: "MANUAL",
  manualStrategy: "HTF_RSI",
};

const candles = await readCandles("BTCUSDT", "15m", FROM, TO);

async function runLabel(label, adapter) {
  const sim = await runSimulation({
    strategyKey: "HTF_RSI",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: CAP,
    timeframe: "15m",
    adapters: { HTF_RSI: adapter },
    symbol: "BTCUSDT",
  });
  const m = computeAllMetrics({ trades: sim.trades, equityCurve: sim.equityCurve, tf: "15m", startingEquity: CAP });
  const ex = {};
  for (const t of sim.trades) ex[t.exitReason || "?"] = (ex[t.exitReason || "?"] || 0) + 1;
  const sl = ex.sl ?? 0;
  console.log(
    `${label.padEnd(22)} ret=${(m.totalReturnPct ?? 0).toFixed(1).padStart(7)}% trades=${m.totalTrades} WR=${((m.winRate ?? 0) * 100).toFixed(0)}% SL=${sl} trail=${ex.trail ?? 0} DD=${(m.maxDrawdownPct ?? 0).toFixed(1)}%`,
  );
}

console.log("HTF_RSI v1 vs v2 — Jan–May 2026, trail ATR0.6 ST4\n");
await runLabel("v1 (old signals)", makeAdapter(signalV1));
await runLabel("v2 (robust filters)", makeAdapter(signalV2));

await closePool();
