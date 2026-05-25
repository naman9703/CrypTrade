#!/usr/bin/env node
/**
 * Supertrend + Intelligence gate optimizer — gate on/off, strict bands, trailing, move-quality.
 *
 *   node scripts/backtest-st-intel-sweep.mjs --symbol BNBUSDT --from 2026-01-01 --to 2026-05-15
 *   node scripts/backtest-st-intel-sweep.mjs --symbol BTCUSDT --days 90 --top 25
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

function arg(name, fallback) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const symbol = String(arg("symbol", "BNBUSDT")).toUpperCase();
const tf = String(arg("tf", "15m"));
const topN = Math.max(10, Number(arg("top", "30")));
const minTrades = Math.max(3, Number(arg("minTrades", "6")));
const targetWr = Number(arg("targetWr", "80"));
const days = arg("days", null);
const fromArg = arg("from", null);
const toArg = arg("to", null);
const startingUsdt = Number(arg("capital", "100"));

const toMs = toArg ? new Date(toArg).getTime() : Date.now();
const fromMs = fromArg
  ? new Date(fromArg).getTime()
  : days
    ? toMs - Number(days) * 86400000
    : new Date("2026-01-01").getTime();

const ST_PERIODS = [
  { period: 10, mult: 3 },
  { period: 7, mult: 2.5 },
];

const SL_TP = [
  { sl: 0.008, tp: 0.025, trail: false },
  { sl: 0.01, tp: 0.03, trail: false },
  { sl: 0.008, tp: 0, trail: true },
  { sl: 0.01, tp: 0, trail: true },
];

const RISK_LEV = [
  { risk: 5, lev: 10 },
  { risk: 7, lev: 15 },
  { risk: 10, lev: 20 },
];

const GATE_FLAGS = [
  { intel: false, mq: false, bo: false, strict: false, noFlip: false },
  { intel: true, mq: false, bo: false, strict: false, noFlip: false },
  { intel: true, mq: false, bo: false, strict: false, noFlip: true },
  { intel: true, mq: true, bo: false, strict: false, noFlip: true },
  { intel: true, mq: true, bo: false, strict: true, noFlip: true },
];

function baseCfg(overrides = {}) {
  return {
    symbol,
    timeframe: tf,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SUPERTREND",
    supertrendFuturesAuto: true,
    supertrendWilderAtr: true,
    intelligenceGateEnabled: false,
    intelligenceGateStrict: false,
    supertrendMoveQualityGate: false,
    supertrendBreakoutConfirm: false,
    supertrendBreakoutMaxBars: 3,
    signalStrengthGatesTrades: false,
    marketDecision: { enabled: false },
    riskPerTradeUnit: "PCT",
    slippagePct: 0.0001,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    trailingStopLossAuto: false,
    futuresTrailingStopMode: "SUPERTREND",
    futuresTrailingStFeeBreakeven: true,
    futuresTrailingStAdvanced: true,
    trailBufferMode: "ATR",
    trailBufferAtrMult: 1.2,
    trailPostT02SpacingFrac: 0.003,
    trailPostT02ActivationBufferRate: 0.003,
    trailMinSlDistFrac: 0.002,
    ...overrides,
  };
}

function scoreRow(m) {
  const n = m.totalTrades ?? 0;
  if (n < minTrades) return -1e9;
  const ret = Number(m.totalReturnPct ?? 0);
  const wr = Number(m.winRate ?? 0) * 100;
  const pf = Number(m.profitFactor ?? 0);
  const dd = Math.abs(Number(m.maxDrawdownPct ?? 0));
  const wrBonus = wr >= targetWr ? 500 + (wr - targetWr) * 10 : 0;
  const ddPen = dd > 30 ? (dd - 30) * 3 : 0;
  return wrBonus + ret * 1.5 + wr * 0.5 + Math.min(pf, 5) * 12 - ddPen - (n < 10 ? (10 - n) * 5 : 0);
}

async function main() {
  const { initPool, closePool, getPool } = await import("../src/db/pool.js");
  if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

  const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
  const { ensureFunding, readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
  const { ensureFearGreed } = await import("../src/backtest/data/fearGreedIngest.js");
  const { ensureOpenInterest } = await import("../src/backtest/data/openInterestIngest.js");
  const { runSimulation } = await import("../src/backtest/engine/runner.js");
  const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
  const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
  const { buildIntelligenceReplay } = await import("../src/backtest/engine/intelligenceReplay.js");

  const padMs = 35 * 86400000;
  await Promise.all([
    ensureFearGreed({ limit: 0 }).catch(() => {}),
    ensureFunding(symbol, { from: fromMs - padMs, to: toMs }).catch(() => {}),
    ensureOpenInterest(symbol, { from: fromMs - padMs, to: toMs, period: "1h" }).catch(() => {}),
    ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" }),
  ]);

  const candles = await readCandles(symbol, tf, fromMs, toMs);
  if (!candles.length) {
    console.error("No candles — sync data first.");
    process.exit(1);
  }
  const fundingRates = await readFundingRates(symbol, fromMs, toMs).catch(() => []);

  console.log(`\n=== ST + Intel sweep ===`);
  console.log(`${symbol} ${tf} · ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}`);
  console.log(`Capital $${startingUsdt} · target WR ${targetWr}% · ${candles.length} bars\n`);

  const adapters = await buildBacktestAdapters({
    strategyKey: "SUPERTREND",
    cfg: baseCfg(),
    symbol,
    tf,
    candles,
    fromMs,
  });

  const gateFnNormal = await buildIntelligenceReplay({
    symbol,
    fromMs,
    toMs,
    candles,
    timeframe: tf,
    strictMode: false,
  });
  const gateFnStrict = await buildIntelligenceReplay({
    symbol,
    fromMs,
    toMs,
    candles,
    timeframe: tf,
    strictMode: true,
  });

  const results = [];
  let done = 0;
  const total =
    ST_PERIODS.length * SL_TP.length * RISK_LEV.length * GATE_FLAGS.length;
  const t0 = Date.now();

  for (const st of ST_PERIODS) {
    for (const risk of SL_TP) {
      for (const rl of RISK_LEV) {
        for (const g of GATE_FLAGS) {
          const cfg = baseCfg({
            supertrendPeriod: st.period,
            supertrendMultiplier: st.mult,
            supertrendFuturesFixedSlPct: risk.sl,
            supertrendFuturesFixedTpPct: risk.tp,
            trailingStopLossAuto: risk.trail,
            riskPerTrade: rl.risk,
            futuresLeverage: rl.lev,
            intelligenceGateEnabled: g.intel,
            intelligenceGateStrict: g.strict,
            supertrendMoveQualityGate: g.mq,
            supertrendMoveQualityMinScore: 0.58,
            supertrendMoveQualityMinAdx: 22,
            supertrendMoveQualityMinMoveSlRatio: 1.8,
            supertrendBreakoutConfirm: g.bo,
            supertrendFuturesExitOnFlip: !g.noFlip,
          });

          const gateMode = g.intel ? "approx" : "off";
          const gateFn =
            gateMode === "approx" ? (g.strict ? gateFnStrict : gateFnNormal) : null;
          try {
            const sim = await runSimulation({
              strategyKey: "SUPERTREND",
              candles,
              cfg,
              gateMode,
              gateFn,
              fundingRates,
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
            const exits = {};
            for (const t of sim.trades) exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;
            results.push({
              st,
              risk,
              rl,
              g,
              metrics,
              exits,
              score: scoreRow(metrics),
              ret: metrics.totalReturnPct ?? 0,
              wr: (metrics.winRate ?? 0) * 100,
              n: metrics.totalTrades ?? 0,
              gateReplay: sim.gateReplay,
            });
          } catch (e) {
            results.push({ st, risk, rl, g, error: String(e.message || e), score: -1e9 });
          }
          done++;
          if (done % 20 === 0 || done === total) {
            process.stdout.write(`\r  ${done}/${total} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
          }
        }
      }
    }
  }
  console.log("\n");

  results.sort((a, b) => b.score - a.score);
  const hit80 = results.filter((r) => r.wr >= targetWr && r.n >= minTrades);

  console.log(`--- Top ${topN} by score ---\n`);
  for (const r of results.slice(0, topN)) {
    if (r.error) continue;
    const label = `intel=${r.g.intel ? (r.g.strict ? "strict" : "on") : "off"} noFlip=${r.g.noFlip} mq=${r.g.mq} trail=${r.risk.trail} st=${r.st.period}/${r.st.mult} risk=${r.rl.risk}% lev=${r.rl.lev}x sl=${(r.risk.sl * 100).toFixed(1)}%`;
    console.log(
      `WR ${r.wr.toFixed(1)}% · ret ${r.ret.toFixed(1)}% · n=${r.n} · pf ${(r.metrics.profitFactor ?? 0).toFixed(2)} · ${label}`,
    );
    if (r.exits) console.log(`   exits: ${JSON.stringify(r.exits)}`);
    if (r.gateReplay?.vetoed) console.log(`   gate: pass=${r.gateReplay.pass} veto=${r.gateReplay.vetoed}`);
  }

  console.log(`\n--- Configs with WR >= ${targetWr}% (${hit80.length}) ---\n`);
  for (const r of hit80.slice(0, 15)) {
    console.log(
      `WR ${r.wr.toFixed(1)}% ret ${r.ret.toFixed(1)}% n=${r.n} intel=${r.g.strict ? "strict" : r.g.intel} trail=${r.risk.trail} lev=${r.rl.lev}`,
    );
  }

  await closePool();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
