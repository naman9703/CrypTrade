/**
 * Trailing-stop parameter sweep for HTF_RSI (same window as recent UI backtests).
 * Usage: node scripts/backtest-trail-sweep.mjs [--quick]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const quick = process.argv.includes("--quick");
const SYMBOL = "BTCUSDT";
const TF = "15m";
const FROM = new Date("2026-01-01").getTime();
const TO = new Date("2026-05-15").getTime();
const CAP = 1000;
const SL = 0.008;
const TP = 0.025;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");

console.log("Loading candles…");
const candles = await readCandles(SYMBOL, TF, FROM, TO);
console.log(`  ${candles.length} bars\n`);

function baseCfg(overrides = {}) {
  return {
    marketMode: "FUTURES",
    futuresLeverage: 50,
    supertrendFuturesAuto: false,
    supertrendFuturesFixedSlPct: SL,
    supertrendFuturesFixedTpPct: TP,
    trailingStopLossAuto: true,
    futuresTrailingStopMode: "SUPERTREND",
    supertrendMoveQualityGate: false,
    signalStrengthGatesTrades: false,
    riskPerTrade: 5,
    riskPerTradeUnit: "PCT_EQUITY",
    slippagePct: 0.0001,
    tradeHistoryTakerOpenFeeRate: 0.0005,
    tradeHistoryTakerCloseFeeRate: 0.0005,
    strategyMode: "MANUAL",
    manualStrategy: "HTF_RSI",
    trailOpenFeeRate: 0.0005,
    trailCloseFeeRate: 0.0005,
    trailBufferMode: "PERCENT",
    ...overrides,
  };
}

async function runOne(label, cfg) {
  const adapters = await buildBacktestAdapters({
    strategyKey: "HTF_RSI",
    cfg,
    symbol: SYMBOL,
    tf: TF,
    candles,
    fromMs: FROM,
  });
  const sim = await runSimulation({
    strategyKey: "HTF_RSI",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: CAP,
    timeframe: TF,
    adapters,
    symbol: SYMBOL,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: CAP,
  });
  const n = m.totalTrades ?? 0;
  const ret = m.totalReturnPct ?? 0;
  const wr = (m.winRate ?? 0) * 100;
  const pf = m.profitFactor ?? 0;
  const dd = m.maxDrawdownPct ?? 0;
  const exits = {};
  const tiers = {};
  for (const t of sim.trades) {
    exits[t.exitReason || "?"] = (exits[t.exitReason || "?"] || 0) + 1;
  }
  for (const t of sim.trades) {
    if (t.trailTierLabel) tiers[t.trailTierLabel] = (tiers[t.trailTierLabel] || 0) + 1;
  }
  const slN = exits.sl ?? 0;
  const trailN = exits.trail ?? 0;
  const tpN = exits.tp ?? 0;
  const slPct = n > 0 ? (slN / n) * 100 : 0;
  const score = ret - dd * 0.3 - slPct * 0.4;
  return { label, ret, wr, pf, dd, n, exits, tiers, slN, trailN, tpN, slPct, score, cfg };
}

const results = [];

async function sweep(label, cfg) {
  process.stdout.write(`  ${label}… `);
  const r = await runOne(label, cfg);
  results.push(r);
  console.log(
    `ret=${r.ret.toFixed(1)}% WR=${r.wr.toFixed(0)}% SL=${r.slN} trail=${r.trailN} tp=${r.tpN} DD=${r.dd.toFixed(1)}%`,
  );
  return r;
}

console.log("=== Phase 1: Trail mode (fixed SL/TP, HTF_RSI) ===\n");
await sweep("no_trail", baseCfg({ trailingStopLossAuto: false }));
await sweep("adv_only_default", baseCfg({
  futuresTrailingStFeeBreakeven: false,
  futuresTrailingStAdvanced: true,
  trailBufferRate: 0.0015,
  trailPostT02SpacingFrac: 0.002,
  trailPostT02ActivationBufferRate: 0.0014,
}));
await sweep("tiered_both_default", baseCfg({
  futuresTrailingStFeeBreakeven: true,
  futuresTrailingStAdvanced: true,
  trailBufferRate: 0.0015,
  trailFeeBeMultiplier: 1.25,
  trailT01LockSlippageFrac: 0.0002,
  trailPostT02SpacingFrac: 0.002,
  trailPostT02ActivationBufferRate: 0.0014,
}));
await sweep("fee_be_only", baseCfg({
  futuresTrailingStFeeBreakeven: true,
  futuresTrailingStAdvanced: false,
  trailBufferRate: 0.0015,
  trailFeeBeMultiplier: 1.25,
}));

const advBuf = quick ? [0.001, 0.002] : [0.0008, 0.001, 0.0015, 0.002, 0.003];
const postSpacing = quick ? [0.001, 0.003] : [0.0005, 0.001, 0.002, 0.003];
const postBuf = quick ? [0, 0.003] : [0, 0.001, 0.002, 0.003, 0.005];
const feeMult = quick ? [1.0, 1.25] : [1.0, 1.15, 1.25, 1.5];

console.log("\n=== Phase 2: Advanced-only parameter grid ===\n");
for (const buf of advBuf) {
  for (const sp of postSpacing) {
    for (const p2b of postBuf) {
      await sweep(`adv buf=${buf} sp=${sp} p2buf=${p2b}`, baseCfg({
        futuresTrailingStFeeBreakeven: false,
        futuresTrailingStAdvanced: true,
        trailBufferRate: buf,
        trailPostT02SpacingFrac: sp,
        trailPostT02ActivationBufferRate: p2b > 0 ? p2b : null,
      }));
    }
  }
}

if (!quick) {
  console.log("\n=== Phase 3: Tiered (fee BE + advanced) buffer/spacing grid ===\n");
  for (const buf of [0.001, 0.0015, 0.002]) {
    for (const fm of feeMult) {
      for (const sp of [0.001, 0.002, 0.003]) {
        await sweep(`tier buf=${buf} fm=${fm} sp=${sp}`, baseCfg({
          futuresTrailingStFeeBreakeven: true,
          futuresTrailingStAdvanced: true,
          trailBufferRate: buf,
          trailFeeBeMultiplier: fm,
          trailT01LockSlippageFrac: 0,
          trailPostT02SpacingFrac: sp,
          trailPostT02ActivationBufferRate: 0.002,
        }));
      }
    }
  }
}

results.sort((a, b) => b.score - a.score);

console.log("\n\n╔══════════════════════════════════════════════════════════════════╗");
console.log("║ TOP 12 by score (return − 0.3×DD − 0.4×SL%)                     ║");
console.log("╚══════════════════════════════════════════════════════════════════╝\n");
for (const r of results.slice(0, 12)) {
  console.log(
    `${r.label.padEnd(42)} ret=${r.ret.toFixed(2).padStart(7)}% WR=${r.wr.toFixed(0).padStart(3)}% SL=${String(r.slN).padStart(2)}/${r.n} trail=${r.trailN} tp=${r.tpN} PF=${r.pf.toFixed(2)} DD=${r.dd.toFixed(1)}%`,
  );
}

const bestRet = [...results].sort((a, b) => b.ret - a.ret)[0];
const fewestSl = [...results].filter((r) => r.n >= 10).sort((a, b) => a.slPct - b.slPct)[0];
const noTrail = results.find((r) => r.label === "no_trail");

console.log("\n--- Verdict ---");
console.log(`Best return:     ${bestRet?.label} → ${bestRet?.ret.toFixed(2)}%`);
console.log(`Fewest SL %:     ${fewestSl?.label} → ${fewestSl?.slPct.toFixed(0)}% SL hits`);
console.log(`No trail:        ${noTrail?.ret.toFixed(2)}% (${noTrail?.slN} SL, ${noTrail?.trailN} trail exits)`);
const advDefault = results.find((r) => r.label === "adv_only_default");
console.log(`Adv-only default: ${advDefault?.ret.toFixed(2)}% (${advDefault?.slN} SL, ${advDefault?.trailN} trail)`);

await closePool();
