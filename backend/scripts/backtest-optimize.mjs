#!/usr/bin/env node
/**
 * Grid-search backtest optimizer — ranks configs by return + win rate + profit factor.
 *
 *   node backend/scripts/backtest-optimize.mjs --days 30 --top 15
 *   node backend/scripts/backtest-optimize.mjs --days 90 --tf 5m --quick
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const symbol = String(arg("symbol", "BTCUSDT")).toUpperCase();
const days = Math.max(7, Number(arg("days", "30")));
const topN = Math.max(5, Number(arg("top", "20")));
const quick = process.argv.includes("--quick");
const turbo = process.argv.includes("--turbo");
const tfArg = arg("tf", null);
const startingUsdt = 10_000;

const STRATEGIES = turbo
  ? ["SUPERTREND", "TREND_PULLBACK", "CONFLUENCE", "RSI_MEAN"]
  : quick
  ? ["SUPERTREND", "TREND_PULLBACK", "EMA_CROSS", "RSI_MEAN", "CONFLUENCE", "AUTO"]
  : [
      "SUPERTREND",
      "TREND_PULLBACK",
      "EMA_CROSS",
      "RSI_MEAN",
      "BREAKOUT_VOL",
      "MOMENTUM_SURGE",
      "CONFLUENCE",
      "ENSEMBLE",
      "AUTO",
    ];

const TIMEFRAMES = tfArg ? [tfArg] : turbo ? ["5m"] : quick ? ["5m", "15m"] : ["1m", "5m", "15m"];

const SL_TP_GRID = turbo
  ? [
      { sl: 0.006, tp: 0.008, trail: false },
      { sl: 0.008, tp: 0.012, trail: false },
      { sl: 0.01, tp: 0.015, trail: false },
    ]
  : quick
  ? [
      { sl: 0.006, tp: 0.008, trail: false },
      { sl: 0.008, tp: 0.012, trail: false },
      { sl: 0.01, tp: 0.015, trail: false },
      { sl: 0.006, tp: 0, trail: true },
    ]
  : [
      { sl: 0.004, tp: 0.006, trail: false },
      { sl: 0.006, tp: 0.008, trail: false },
      { sl: 0.006, tp: 0.01, trail: false },
      { sl: 0.008, tp: 0.012, trail: false },
      { sl: 0.01, tp: 0.015, trail: false },
      { sl: 0.012, tp: 0.02, trail: false },
      { sl: 0.006, tp: 0, trail: true },
      { sl: 0.008, tp: 0, trail: true },
    ];

const ST_GRID = turbo
  ? [{ period: 10, mult: 3 }]
  : quick
  ? [
      { period: 10, mult: 3 },
      { period: 7, mult: 2.5 },
    ]
  : [
      { period: 7, mult: 2 },
      { period: 7, mult: 2.5 },
      { period: 10, mult: 2.5 },
      { period: 10, mult: 3 },
      { period: 14, mult: 3 },
    ];

const GATE_VARIANTS = turbo
  ? [
      { mq: false, ss: false, md: false },
      { mq: true, ss: false, md: false },
    ]
  : quick
  ? [
      { mq: false, ss: false, md: false },
      { mq: true, ss: false, md: false },
      { mq: false, ss: true, md: false },
    ]
  : [
      { mq: false, ss: false, md: false },
      { mq: true, ss: false, md: false },
      { mq: true, ss: true, md: false },
      { mq: false, ss: true, md: false },
      { mq: true, ss: false, md: true },
    ];

function baseCfg(overrides = {}) {
  return {
    marketMode: "FUTURES",
    futuresLeverage: 5,
    supertrendWilderAtr: true,
    supertrendFuturesAuto: false,
    strategyMode: "MANUAL",
    riskPerTrade: 1,
    riskPerTradeUnit: "PCT_EQUITY",
    slippagePct: 0.0001,
    tradeHistoryTakerOpenFeeRate: 0.0002,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    trailingStopLossAuto: false,
    futuresTrailingStopMode: "SUPERTREND",
    supertrendMoveQualityGate: false,
    supertrendMoveQualityMinScore: 0.55,
    supertrendMoveQualityMinAdx: 20,
    supertrendMoveQualityMinMoveSlRatio: 1.5,
    signalStrengthGatesTrades: false,
    signalStrengthOpenMin: 70,
    marketDecision: { enabled: false },
    intelligenceGateEnabled: false,
    ...overrides,
  };
}

function scoreRow(m, minTrades = 8) {
  const n = m.totalTrades ?? 0;
  if (n < minTrades) return -1e9;
  const ret = Number(m.totalReturnPct ?? 0);
  const wr = Number(m.winRate ?? 0) * 100;
  const pf = Number(m.profitFactor ?? 0);
  const dd = Math.abs(Number(m.maxDrawdownPct ?? 0));
  const sharpe = Number(m.sharpeRatio ?? 0);
  // Penalize huge drawdowns; reward return, WR, PF, sharpe
  const ddPen = dd > 25 ? (dd - 25) * 2 : 0;
  return ret * 1.2 + wr * 0.35 + Math.min(pf, 4) * 8 + sharpe * 3 - ddPen;
}

async function loadCandles(tf, fromMs, toMs) {
  const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
  await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
  return readCandles(symbol, tf, fromMs, toMs);
}

async function runConfig({ strategyKey, tf, cfg, candles, fromMs }) {
  const { runSimulation } = await import("../src/backtest/engine/runner.js");
  const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
  const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

  const adapters = await buildBacktestAdapters({
    strategyKey,
    cfg,
    symbol,
    tf,
    candles,
    fromMs,
  });

  const sim = await runSimulation({
    strategyKey,
    candles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt,
    timeframe: tf,
    adapters,
    symbol,
  });

  const metrics = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf,
    startingEquity: startingUsdt,
  });

  return { sim, metrics };
}

function* iterConfigs() {
  for (const tf of TIMEFRAMES) {
    for (const strategyKey of STRATEGIES) {
      const isSt = strategyKey === "SUPERTREND";
      const stVariants = isSt ? ST_GRID : [{ period: 10, mult: 3 }];
      for (const st of stVariants) {
        for (const risk of SL_TP_GRID) {
          for (const gates of GATE_VARIANTS) {
            yield { tf, strategyKey, st, risk, gates };
          }
        }
      }
    }
  }
}

async function main() {
  const { initPool, closePool, getPool } = await import("../src/db/pool.js");
  if (!getPool?.()) {
    await initPool({ info: () => {}, warn: () => {}, error: console.error });
  }

  const toMs = Date.now();
  const fromMs = toMs - days * 86400000;

  console.log(`\n=== Backtest Optimizer ===`);
  const mode = turbo ? "turbo" : quick ? "quick" : "full";
  console.log(`${symbol} · ${days}d · $${startingUsdt} · ${mode} grid`);
  console.log(`TFs: ${TIMEFRAMES.join(", ")} · strategies: ${STRATEGIES.length}\n`);

  const candleCache = new Map();
  for (const tf of TIMEFRAMES) {
    process.stdout.write(`Loading ${tf}... `);
    const candles = await loadCandles(tf, fromMs, toMs);
    candleCache.set(tf, candles);
    console.log(`${candles.length} bars`);
    if (!candles.length) {
      console.error(`No candles for ${tf}`);
      process.exit(1);
    }
  }

  const configs = [...iterConfigs()];
  console.log(`\nRunning ${configs.length} configurations...\n`);

  const results = [];
  let done = 0;
  const t0 = Date.now();

  for (const c of configs) {
    const candles = candleCache.get(c.tf);
    const cfg = baseCfg({
      manualStrategy: c.strategyKey,
      supertrendPeriod: c.st.period,
      supertrendMultiplier: c.st.mult,
      supertrendFuturesFixedSlPct: c.risk.sl,
      supertrendFuturesFixedTpPct: c.risk.tp,
      trailingStopLossAuto: c.risk.trail,
      supertrendMoveQualityGate: c.gates.mq,
      signalStrengthGatesTrades: c.gates.ss,
      marketDecision: c.gates.md ? { enabled: true } : { enabled: false },
      ...(c.strategyKey === "AUTO" ? { strategyMode: "AUTO", manualStrategy: undefined } : {}),
    });

    try {
      const { metrics } = await runConfig({
        strategyKey: c.strategyKey,
        tf: c.tf,
        cfg,
        candles,
        fromMs,
      });
      const sc = scoreRow(metrics, c.tf === "1m" ? 5 : 8);
      results.push({
        ...c,
        metrics,
        score: sc,
        ret: metrics.totalReturnPct ?? 0,
        wr: (metrics.winRate ?? 0) * 100,
        n: metrics.totalTrades ?? 0,
        pf: metrics.profitFactor ?? 0,
        dd: metrics.maxDrawdownPct ?? 0,
      });
    } catch (e) {
      results.push({ ...c, error: String(e.message || e).slice(0, 80), score: -1e9 });
    }

    done++;
    if (done % 25 === 0 || done === configs.length) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      process.stdout.write(`\r  ${done}/${configs.length} (${elapsed}s)`);
    }
  }
  console.log("\n");

  const ranked = results
    .filter((r) => !r.error && r.score > -1e8)
    .sort((a, b) => b.score - a.score);

  const minTrades = quick ? 5 : 8;
  const viable = ranked.filter((r) => r.n >= minTrades && r.ret > 0 && r.wr >= 55);

  console.log("─── TOP BY COMPOSITE SCORE ─────────────────────────────");
  console.log(
    `${"rank".padStart(4)} ${"strategy".padEnd(16)} ${"tf".padStart(4)} ${"trades".padStart(6)} ${"ret%".padStart(8)} ${"win%".padStart(6)} ${"PF".padStart(5)} ${"DD%".padStart(7)} ${"SL/TP".padStart(12)} gates`
  );
  console.log("-".repeat(95));

  for (let i = 0; i < Math.min(topN, ranked.length); i++) {
    const r = ranked[i];
    const sltp = `${(r.risk.sl * 100).toFixed(1)}/${r.risk.tp ? (r.risk.tp * 100).toFixed(1) : "trail"}`;
    const g = `${r.gates.mq ? "MQ" : ""}${r.gates.ss ? "SS" : ""}${r.gates.md ? "MD" : ""}` || "—";
    const st = r.strategyKey === "SUPERTREND" ? ` ST${r.st.period}/${r.st.mult}` : "";
    console.log(
      `${String(i + 1).padStart(4)} ${r.strategyKey.padEnd(16)} ${r.tf.padStart(4)} ${String(r.n).padStart(6)} ${r.ret.toFixed(2).padStart(8)} ${r.wr.toFixed(1).padStart(6)} ${r.pf.toFixed(2).padStart(5)} ${r.dd.toFixed(2).padStart(7)} ${sltp.padStart(12)} ${g}${st}`
    );
  }

  if (viable.length) {
    console.log("\n─── BEST VIABLE (ret>0, win≥55%, min trades) ───────────");
    for (let i = 0; i < Math.min(10, viable.length); i++) {
      const r = viable[i];
      console.log(
        `  #${i + 1} ${r.strategyKey} ${r.tf} ret=${r.ret.toFixed(2)}% wr=${r.wr.toFixed(1)}% n=${r.n} PF=${r.pf.toFixed(2)} SL=${(r.risk.sl * 100).toFixed(2)}% TP=${r.risk.tp ? (r.risk.tp * 100).toFixed(2) + "%" : "trail"} MQ=${r.gates.mq} SS=${r.gates.ss}`
      );
    }
  } else {
    console.log("\n  No config met ret>0 + win≥55% + min trades on this window.");
    console.log("  Top score row may still be the least-bad starting point.");
  }

  const best = ranked[0];
  if (best) {
    console.log("\n─── RECOMMENDED CONFIG (copy to panel) ─────────────────");
    console.log(JSON.stringify(
      {
        strategyMode: best.strategyKey === "AUTO" ? "AUTO" : "MANUAL",
        manualStrategy: best.strategyKey === "AUTO" ? undefined : best.strategyKey,
        supertrendFuturesAuto: false,
        timeframe: best.tf,
        supertrendPeriod: best.st.period,
        supertrendMultiplier: best.st.mult,
        supertrendFuturesFixedSlPct: best.risk.sl,
        supertrendFuturesFixedTpPct: best.risk.tp,
        trailingStopLossAuto: best.risk.trail,
        supertrendMoveQualityGate: best.gates.mq,
        signalStrengthGatesTrades: best.gates.ss,
        futuresLeverage: 5,
        initial_capital: 10000,
      },
      null,
      2
    ));
  }

  await closePool().catch(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
