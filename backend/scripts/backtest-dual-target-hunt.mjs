#!/usr/bin/env node
/**
 * Hunt configs with WR >= 80% AND totalReturnPct >= 1000%.
 *
 *   node scripts/backtest-dual-target-hunt.mjs
 *   node scripts/backtest-dual-target-hunt.mjs --symbol BNBUSDT --minRet 1000
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const symbols = String(arg("symbols", "BNBUSDT,BTCUSDT"))
  .split(",")
  .map((s) => s.trim().toUpperCase());
const tf = String(arg("tf", "15m"));
const minWr = Number(arg("minWr", "80"));
const minRet = Number(arg("minRet", "1000"));
const minTrades = Math.max(5, Number(arg("minTrades", "8")));
const capital = Number(arg("capital", "100"));

const WINDOWS = [
  ["2026-01-01", "2026-05-20"],
  ["2025-06-01", "2026-05-20"],
];

const TPS = [0.003, 0.005, 0.007, 0.01, 0.015, 0.02, 0.025];
const SLS = [0.01, 0.015, 0.02, 0.03, 0.04];
const RISKS = [
  { risk: 5, lev: 10, sizing: "RISK_AT_SL" },
  { risk: 10, lev: 20, sizing: "RISK_AT_SL" },
  { risk: 15, lev: 30, sizing: "RISK_AT_SL" },
  { risk: 20, lev: 40, sizing: "RISK_AT_SL" },
  { risk: 25, lev: 50, sizing: "RISK_AT_SL" },
  { risk: 100, lev: 30, sizing: "FULL_EQUITY_MARGIN" },
  { risk: 100, lev: 50, sizing: "FULL_EQUITY_MARGIN" },
];
const INTEL = [
  { intel: false, strict: false, hwr: false },
  { intel: true, strict: false, hwr: false },
  { intel: true, strict: true, hwr: false },
  { intel: true, strict: false, hwr: true },
];
const STRATS = ["SUPERTREND", "TREND_HTF_ST"];

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { buildIntelligenceReplay } = await import("../src/backtest/engine/intelligenceReplay.js");
const { TREND_HTF_ST_BNB_MAX_PRESET } = await import("../src/strategy/presets/trendHtfStOptimized.js");
const { SUPERTREND_INTEL_80WR_PRESET } = await import("../src/strategy/presets/supertrendIntel80Wr.js");

const hits = [];
let total = 0;
let done = 0;

for (const symbol of symbols) {
  for (const [from, to] of WINDOWS) {
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
    const candles = await readCandles(symbol, tf, fromMs, toMs);
    if (!candles.length) continue;

    const gateFns = new Map();
    async function getGate(strict, hwr) {
      const k = `${strict}|${hwr}`;
      if (!gateFns.has(k)) {
        gateFns.set(
          k,
          await buildIntelligenceReplay({
            symbol,
            fromMs,
            toMs,
            candles,
            timeframe: tf,
            strictMode: strict,
            highWinRateMode: hwr,
          }),
        );
      }
      return gateFns.get(k);
    }

    const adapterCache = new Map();

    for (const strat of STRATS) {
      for (const tp of TPS) {
        for (const sl of SLS) {
          if (tp >= sl) continue;
          for (const rk of RISKS) {
            for (const ig of INTEL) {
              total++;
              const cfg = {
                symbol,
                timeframe: tf,
                marketMode: "FUTURES",
                strategyMode: "MANUAL",
                manualStrategy: strat,
                supertrendFuturesAuto: strat === "SUPERTREND",
                supertrendWilderAtr: true,
                supertrendPeriod: 10,
                supertrendMultiplier: 3,
                intelligenceGateEnabled: ig.intel,
                intelligenceGateStrict: ig.strict,
                intelligenceGateHighWinRate: ig.hwr,
                supertrendFuturesFixedSlPct: sl,
                supertrendFuturesFixedTpPct: tp,
                supertrendFuturesExitOnFlip: false,
                trailingStopLossAuto: false,
                supertrendBreakoutConfirm: false,
                supertrendMoveQualityGate: false,
                supertrendBigMoveGateEnabled: false,
                signalStrengthGatesTrades: false,
                marketDecision: { enabled: false },
                riskPerTrade: rk.risk,
                futuresLeverage: rk.lev,
                riskPerTradeUnit: "PCT",
                backtestPositionSizing: rk.sizing,
                slippagePct: 0.0001,
                tradeHistoryTakerOpenFeeRate: 0.0004,
                tradeHistoryTakerCloseFeeRate: 0.0004,
                ...(strat === "TREND_HTF_ST" ? TREND_HTF_ST_BNB_MAX_PRESET : {}),
              };

              const ak = `${strat}|${JSON.stringify(cfg).slice(0, 80)}`;
              if (!adapterCache.has(ak)) {
                adapterCache.set(
                  ak,
                  await buildBacktestAdapters({ strategyKey: strat, cfg, symbol, tf, candles, fromMs }),
                );
              }

              try {
                const sim = await runSimulation({
                  strategyKey: strat,
                  candles,
                  cfg,
                  gateMode: ig.intel ? "approx" : "off",
                  gateFn: ig.intel ? await getGate(ig.strict, ig.hwr) : null,
                  startingUsdt: capital,
                  timeframe: tf,
                  adapters: adapterCache.get(ak),
                  symbol,
                });
                const m = computeAllMetrics({
                  trades: sim.trades,
                  equityCurve: sim.equityCurve,
                  tf,
                  startingEquity: capital,
                });
                const wr = (m.winRate ?? 0) * 100;
                const ret = m.totalReturnPct ?? 0;
                const n = m.totalTrades ?? 0;
                if (wr >= minWr && ret >= minRet && n >= minTrades) {
                  hits.push({
                    symbol,
                    from,
                    to,
                    strat,
                    tp,
                    sl,
                    rk,
                    ig,
                    wr,
                    ret,
                    n,
                    pf: m.profitFactor,
                    dd: m.maxDrawdownPct,
                    cfg,
                  });
                  console.log(
                    `\n★ HIT ${symbol} ${from}→${to} ${strat} TP${(tp * 100).toFixed(2)}% SL${(sl * 100).toFixed(1)}% risk${rk.risk} ${rk.lev}x ${rk.sizing} intel=${ig.intel}/${ig.strict}/${ig.hwr} → WR${wr.toFixed(1)}% ret${ret.toFixed(0)}% n=${n}`,
                  );
                }
              } catch {
                /* skip */
              }
              done++;
              if (done % 100 === 0) process.stdout.write(`\r${done}/${total}`);
            }
          }
        }
      }
    }
  }
}

console.log(`\n\n=== Done ${done}/${total} — ${hits.length} configs met WR≥${minWr}% & ret≥${minRet}% ===\n`);
hits.sort((a, b) => b.ret - a.ret);
for (const h of hits.slice(0, 10)) {
  console.log(
    `${h.symbol} ${h.from} ${h.strat} WR${h.wr.toFixed(1)}% ret${h.ret.toFixed(0)}% n=${h.n} TP${(h.tp * 100).toFixed(2)}% SL${(h.sl * 100).toFixed(1)}% ${h.rk.sizing} ${h.rk.lev}x intel=${h.ig.intel}`,
  );
}
if (hits[0]) {
  console.log("\nBest config JSON:");
  console.log(JSON.stringify(hits[0].cfg, null, 2));
}

await closePool?.();
