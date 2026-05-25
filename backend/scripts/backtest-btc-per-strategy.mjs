#!/usr/bin/env node
/** Fast per-strategy BTC 15m optimizer. Use --deep STRAT for full grid on one strategy. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = "BTCUSDT";
const tf = "15m";
const fromMs = new Date("2026-01-01").getTime();
const toMs = new Date("2026-05-18").getTime();
const startingUsdt = 100;
const deepOnly = process.argv.includes("--deep") ? process.argv[process.argv.indexOf("--deep") + 1] : null;

const STRATEGIES = deepOnly
  ? [deepOnly]
  : process.argv.slice(2).filter((a) => !a.startsWith("--")).length
  ? process.argv.slice(2).filter((a) => !a.startsWith("--"))
  : [
      "APEX_TREND",
      "BTC_CONSENSUS",
      "SUPERTREND",
      "EMA_CROSS",
      "RSI_MEAN",
      "BREAKOUT_VOL",
      "MOMENTUM_SURGE",
      "CONFLUENCE",
      "ENSEMBLE",
      "AUTO",
      "TREND_PULLBACK",
      "SMART_REVERSAL",
      "HTF_RSI",
      "TREND_HTF_ST",
      "HTF_LEG_RIDER",
      "SURF_PULSE_ML",
    ];

const SL_TP_FAST = [
  { sl: 0.006, tp: 0.012 },
  { sl: 0.006, tp: 0.018 },
  { sl: 0.008, tp: 0.024 },
  { sl: 0.01, tp: 0.03 },
  { sl: 0.012, tp: 0.036 },
  { sl: 0.006, tp: 0, trail: true },
];

const SL_TP_DEEP = [
  ...SL_TP_FAST,
  { sl: 0.005, tp: 0.015 },
  { sl: 0.007, tp: 0.021 },
  { sl: 0.008, tp: 0.016 },
  { sl: 0.008, tp: 0.032 },
  { sl: 0.009, tp: 0.027 },
  { sl: 0.01, tp: 0.02 },
  { sl: 0.01, tp: 0.04 },
  { sl: 0.015, tp: 0.045 },
  { sl: 0.008, tp: 0, trail: true },
];

const RISKS = deepOnly ? [3, 5, 7, 10] : [5, 7];
const LEVS = deepOnly ? [10, 15, 25] : [15, 25];
const ST = deepOnly
  ? [
      { period: 7, mult: 2.5 },
      { period: 10, mult: 2.5 },
      { period: 10, mult: 3 },
      { period: 14, mult: 3 },
    ]
  : [{ period: 10, mult: 3 }];

const SL_TP = deepOnly ? SL_TP_DEEP : SL_TP_FAST;

function cfgFor(strat, sltp, risk, lev, st) {
  return {
    marketMode: "FUTURES",
    futuresLeverage: lev,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: risk,
    riskPerTradeUnit: "PCT_EQUITY",
    supertrendWilderAtr: true,
    supertrendFuturesAuto: false,
    strategyMode: strat === "AUTO" ? "AUTO" : "MANUAL",
    manualStrategy: strat === "AUTO" ? undefined : strat,
    supertrendPeriod: st.period,
    supertrendMultiplier: st.mult,
    supertrendFuturesFixedSlPct: sltp.sl,
    supertrendFuturesFixedTpPct: sltp.tp ?? 0,
    trailingStopLossAuto: Boolean(sltp.trail),
    supertrendMoveQualityGate: false,
    signalStrengthGatesTrades: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    surfPulseMlGateEnabled: false,
  };
}

function score(ret, wr, n, dd) {
  if (n < 5) return -1e9;
  const target = ret >= 1000 && wr >= 80 ? 1e6 : 0;
  return target + ret * 1.5 + wr * 0.6 - Math.max(0, dd - 40) * 2;
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) {
  try {
    await initPool({ info: () => {}, warn: () => {}, error: console.error });
  } catch (e) {
    console.error(
      "Database required. Start: docker compose -f docker-compose.db.yml up -d\n" +
        "Then: cd backend && npm run db:migrate && npm run backtest:sync\n" +
        `Error: ${e?.message || e}`
    );
    process.exit(1);
  }
}
const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
console.error(`BTC ${tf} · ${candles.length} bars · mode=${deepOnly ? `deep:${deepOnly}` : "fast"}\n`);

const summary = [];

for (const strat of STRATEGIES) {
  const stList = strat === "SUPERTREND" ? ST : [ST[0]];
  let best = null;
  let tested = 0;
  const t0 = Date.now();

  for (const st of stList) {
    for (const sltp of SL_TP) {
      for (const risk of RISKS) {
        for (const lev of LEVS) {
          tested++;
          const cfg = cfgFor(strat, sltp, risk, lev, st);
          try {
            const adapters = await buildBacktestAdapters({
              strategyKey: strat,
              cfg,
              symbol,
              tf,
              candles,
              fromMs,
            });
            const sim = await runSimulation({
              strategyKey: strat,
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
            const sc = score(ret, wr, n, dd);
            const row = { strat, sl: sltp.sl, tp: sltp.tp, trail: sltp.trail, risk, lev, ret, wr, n, dd, pf: m.profitFactor ?? 0, sc };
            if (!best || sc > best.sc) best = row;
          } catch {
            /* skip */
          }
        }
      }
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  if (best) {
    const sltp = best.trail ? `${(best.sl * 100).toFixed(1)}% trail` : `${(best.sl * 100).toFixed(1)}/${(best.tp * 100).toFixed(1)}`;
    console.log(JSON.stringify({ strategy: strat, best: { ...best, sltp }, tested, elapsedSec: Number(elapsed), targetMet: best.ret >= 1000 && best.wr >= 80 }));
    summary.push({ strat, ...best, sltp, hit: best.ret >= 1000 && best.wr >= 80 });
  }
  console.error(`  ${strat}: ${tested} in ${elapsed}s → ret=${best?.ret?.toFixed(1) ?? "?"}% WR=${best?.wr?.toFixed(1) ?? "?"}% n=${best?.n ?? 0}`);
}

console.error("\n── RANKED ──");
summary.sort((a, b) => b.sc - a.sc).forEach((r, i) => {
  console.error(`${i + 1}. ${r.strat.padEnd(18)} ret=${r.ret.toFixed(1).padStart(8)}% WR=${r.wr.toFixed(1).padStart(5)}% n=${r.n} ${r.sltp}`);
});
await closePool?.();
