#!/usr/bin/env node
/** SR_INTRADAY parameter sweep — 15m BTC/BNB, targets ~2–4 trades/day, high WR. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbols = process.argv.includes("--bnb") ? ["BNBUSDT"] : ["BTCUSDT", "BNBUSDT"];
const tf = "15m";
const fromMs = new Date(process.env.SR_FROM || "2026-01-01").getTime();
const toMs = new Date(process.env.SR_TO || "2026-05-18").getTime();
const startingUsdt = 100;

const SL_TP = [
  { sl: 0.005, tp: 0.012 },
  { sl: 0.006, tp: 0.015 },
  { sl: 0.006, tp: 0.018 },
  { sl: 0.007, tp: 0.021 },
  { sl: 0.008, tp: 0.024 },
];

const RISKS = [4, 5, 6];
const LEVS = [15, 20];
const SWEEPS = [0.0006, 0.0008, 0.001];
const WICKS = [0.48, 0.52, 0.56];

function cfgFor(symbol, sltp, risk, lev, sweep, wick) {
  return {
    marketMode: "FUTURES",
    futuresLeverage: lev,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: risk,
    riskPerTradeUnit: "PCT",
    supertrendFuturesAuto: false,
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    supertrendFuturesFixedSlPct: sltp.sl,
    supertrendFuturesFixedTpPct: sltp.tp,
    trailingStopLossAuto: false,
    supertrendMoveQualityGate: false,
    signalStrengthGatesTrades: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    srIntradaySweepPct: sweep,
    srIntradayMinWickRatio: wick,
    srIntradayMaxTradesPerDay: 4,
    srIntradayCooldownBars: 8,
  };
}

function score(ret, wr, n, dd, tradesPerDay) {
  if (n < 8) return -1e9;
  const tpd = tradesPerDay ?? n / 120;
  const tpdPenalty = tpd < 0.3 ? -500 : tpd > 6 ? -300 : 0;
  const wrBonus = wr >= 55 ? wr * 2 : wr;
  return ret * 1.2 + wrBonus * 0.8 - Math.max(0, dd - 35) * 1.5 + tpdPenalty;
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) {
  try {
    await initPool({ info: () => {}, warn: () => {}, error: console.error });
  } catch (e) {
    console.error(`DB required: ${e?.message || e}`);
    process.exit(1);
  }
}

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

const days = (toMs - fromMs) / 86_400_000;

for (const symbol of symbols) {
  await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
  const candles = await readCandles(symbol, tf, fromMs, toMs);
  console.error(`\n${symbol} ${tf} · ${candles.length} bars · ${days.toFixed(0)}d\n`);

  let best = null;
  let tested = 0;

  for (const sltp of SL_TP) {
    for (const risk of RISKS) {
      for (const lev of LEVS) {
        for (const sweep of SWEEPS) {
          for (const wick of WICKS) {
            tested++;
            const cfg = cfgFor(symbol, sltp, risk, lev, sweep, wick);
            try {
              const adapters = await buildBacktestAdapters({
                strategyKey: "SR_INTRADAY",
                cfg,
                symbol,
                tf,
                candles,
                fromMs,
              });
              const sim = await runSimulation({
                strategyKey: "SR_INTRADAY",
                candles,
                cfg,
                gateMode: "off",
                fundingRates: [],
                startingUsdt,
                timeframe: tf,
                adapters,
                symbol,
              });
              const m = computeAllMetrics({
                trades: sim.trades,
                equityCurve: sim.equityCurve,
                tf,
                startingEquity: startingUsdt,
              });
              const ret = m.totalReturnPct ?? 0;
              const wr = (m.winRate ?? 0) * 100;
              const n = m.totalTrades ?? 0;
              const dd = Math.abs(m.maxDrawdownPct ?? 0);
              const tpd = n / days;
              const sc = score(ret, wr, n, dd, tpd);
              const row = { symbol, sl: sltp.sl, tp: sltp.tp, risk, lev, sweep, wick, ret, wr, n, dd, tpd, pf: m.profitFactor ?? 0, sc };
              if (!best || sc > best.sc) best = row;
            } catch {
              /* skip */
            }
          }
        }
      }
    }
  }

  if (best) {
    console.log(JSON.stringify({ symbol, best, tested }));
    console.error(
      `  BEST ${symbol}: ret=${best.ret.toFixed(1)}% WR=${best.wr.toFixed(1)}% n=${best.n} tpd=${best.tpd.toFixed(2)} sl=${best.sl} tp=${best.tp}`
    );
  }
}

await closePool?.();
