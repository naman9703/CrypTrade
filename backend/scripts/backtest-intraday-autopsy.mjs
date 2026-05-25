#!/usr/bin/env node
/**
 * Trade-by-trade autopsy: label wins/losses, show veto hits, compare configs.
 * Usage: npm run backtest:intraday-autopsy -- BNBUSDT 15m [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = process.argv[2] || "BNBUSDT";
const tf = process.argv[3] || "15m";
const fromMs = new Date(process.argv[4] || "2026-01-01").getTime();
const toMs = new Date(process.argv[5] || "2026-05-18").getTime();
const days = Math.max(1, (toMs - fromMs) / 86_400_000);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { mergeAdaptiveCfg, buildIntradayOptsFromCfg } = await import("../src/strategy/intradayPro.js");
const { buildIntradayEntryContext, classifyTradeOutcome } = await import("../src/strategy/intradayEntryContext.js");
const { INTRADAY_VETO_RULES, discoverVetoRules, applyIntradayVetoes } = await import(
  "../src/strategy/intradayLearnedRules.js",
);
const { INTRADAY_PRO_15M, INTRADAY_PRO_BIGMOVE_15M } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);

const WARMUP = 100;
const signalIndex = new Map();

function findSignalIdx(entryTs) {
  const t = typeof entryTs === "number" ? entryTs : new Date(entryTs).getTime();
  let i = candles.findIndex((c) => c.ts >= t);
  if (i > 0) i -= 1;
  return Math.max(WARMUP, Math.min(candles.length - 1, i));
}

async function runSim(cfg, label) {
  const merged = mergeAdaptiveCfg(
    {
      ...cfg,
      marketMode: "FUTURES",
      strategyMode: "MANUAL",
      manualStrategy: "SR_INTRADAY",
      slippagePct: 0.0005,
    },
    candles,
  );
  const opts = buildIntradayOptsFromCfg(merged);
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg: merged,
    symbol,
    tf,
    candles,
    fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg: merged,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: tf,
    adapters,
    symbol,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf,
    startingEquity: 100,
  });
  const { precomputeIntraday, evaluateIntradayBar } = await import("../src/strategy/intradayPro.js");
  const pre = precomputeIntraday(candles);

  const rows = [];
  for (const t of sim.trades) {
    const idx = findSignalIdx(t.entryTs);
    let sig = signalIndex.get(idx);
    if (!sig) {
      sig = evaluateIntradayBar(candles, idx, opts, pre);
      if (sig) signalIndex.set(idx, sig);
    }
    if (!sig) continue;
    const ctx = buildIntradayEntryContext(candles, idx, pre, sig, opts);
    rows.push({
      trade: t,
      ctx,
      bucket: classifyTradeOutcome(t),
      sig,
    });
  }

  const tpm = ((m.totalTrades ?? 0) / days) * 30;
  console.log({
    label,
    n: m.totalTrades,
    tpm: +tpm.toFixed(1),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(1),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(1),
  });
  return { m, rows, merged };
}

console.error(
  `\n${symbol} ${tf} ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}\n`,
);

const loose = await runSim(
  {
    intradayLearnedRulesEnabled: false,
    intradayRequireSessionReclaim: false,
    intradayRequireFibOrVp: false,
    srIntradayMinScore: 8,
    supertrendFuturesFixedSlPct: 0.0035,
    supertrendFuturesFixedTpPct: 0.01,
    futuresLeverage: 12,
    riskPerTrade: 2.5,
  },
  "loose",
);

const final = await runSim(INTRADAY_PRO_15M, "final_veto");
const trail = await runSim(INTRADAY_PRO_BIGMOVE_15M, "tierA_trail");

const buckets = {};
for (const r of loose.rows) buckets[r.bucket] = (buckets[r.bucket] ?? 0) + 1;
console.error("\nBuckets (loose):", buckets);

const discovered = discoverVetoRules(loose.rows, { maxRules: 8 });
console.error("\nDiscovered veto rules:");
for (const r of discovered) console.error(`  • ${r.id}: ${r.note}`);

console.error("\n── Losses that FINAL rules would block ──");
let blocked = 0;
for (const r of loose.rows) {
  if (r.bucket === "BIG_WIN" || r.bucket === "WIN") continue;
  const v = applyIntradayVetoes(r.ctx, { intradayLearnedRulesEnabled: true });
  if (!v.allow) {
    blocked++;
    console.error(
      `  #${r.trade.tradeNumber} ${r.bucket} ${r.trade.exitReason} → ${v.vetoId}`,
    );
  }
}
console.error(`Blocked ${blocked} / ${loose.rows.filter((x) => x.bucket !== "BIG_WIN" && x.bucket !== "WIN").length} losers`);

console.error("\n── BIG_WINs in final run ──");
for (const r of final.rows.filter((x) => x.bucket === "BIG_WIN")) {
  console.error(
    `  #${r.trade.tradeNumber} tier=${r.sig.tier} mfe=${(Number(r.trade.mfePct) * 100).toFixed(2)}% net=${Number(r.trade.netPnl).toFixed(2)}`,
  );
}

await closePool?.();
