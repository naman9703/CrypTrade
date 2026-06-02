#!/usr/bin/env node
/**
 * Bar-by-bar fib autopsy: label every strict fib setup as win/loss via forward TP/SL sim.
 * Usage: npm run backtest:fib-autopsy -- BNBUSDT 15m [from] [to]
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const symbol = process.argv[2] || "BNBUSDT";
const tf = process.argv[3] || "15m";
const fromMs = new Date(process.argv[4] || "2026-01-01").getTime();
const toMs = new Date(process.argv[5] || "2026-05-25").getTime();
const days = Math.max(1, (toMs - fromMs) / 86_400_000);

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: console.warn, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { evaluateFibRetraceSetup } = await import("../src/strategy/techniques/fibonacci.js");
const { buildFibEntryContext } = await import("../src/strategy/intradayFibContext.js");
const {
  FIB_VETO_RULES,
  discoverFibVetoRules,
  applyFibVetoes,
} = await import("../src/strategy/intradayFibLearnedRules.js");
const { INTRADAY_PRO_FIB_15M } = await import("../src/strategy/presets/srIntradayOptimized.js");

await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
const candles = await readCandles(symbol, tf, fromMs, toMs);
const WARMUP = 100;
const MAX_HOLD = 48;

/** Broad scan — enough setups to learn loss patterns (production applies vetoes on top). */
const SCAN_CFG = {
  ...INTRADAY_PRO_FIB_15M,
  symbol,
  timeframe: tf,
  intradayFibLearnedRulesEnabled: false,
  intradayFibConfirmNextBar: false,
  intradayFibRequireRsiAlign: false,
  intradayFibMinAdx: 18,
  intradayFibMinWickRatio: 0.34,
  intradayFibMinLegAtrMult: 1.65,
  intradayFibMinRetraceRatio: 0.45,
  intradayFibMaxRetraceRatio: 0.78,
  intradayFibAllowedRatios: [0.618, 0.5],
  intradayFibTpMode: "scalp",
  intradayFibScalpTpPct: 0.004,
  intradayFibScalpSlPct: 0.0025,
};

const BASE_CFG = SCAN_CFG;

const PROD_CFG = {
  ...INTRADAY_PRO_FIB_15M,
  symbol,
  timeframe: tf,
  intradayFibLearnedRulesEnabled: true,
  intradayFibConfirmNextBar: true,
  intradayFibRequireRsiAlign: true,
};

function forwardSim(candles, idx, sig) {
  const entry = candles[idx].close;
  const side = sig.side;
  const slPct = sig.slPct;
  const tpPct = sig.tpPct;
  let mfe = 0;
  let mae = 0;
  for (let j = idx + 1; j < Math.min(candles.length, idx + MAX_HOLD); j++) {
    const bar = candles[j];
    const moveLong = (bar.high - entry) / entry;
    const moveShort = (entry - bar.low) / entry;
    const fav = side === "BUY" ? moveLong : moveShort;
    const adv = side === "BUY" ? (entry - bar.low) / entry : (bar.high - entry) / entry;
    mfe = Math.max(mfe, fav);
    mae = Math.min(mae, -adv);
    if (side === "BUY") {
      if (bar.low <= entry * (1 - slPct)) return { win: false, mfe, mae, bars: j - idx, exit: "sl" };
      if (bar.high >= entry * (1 + tpPct)) return { win: true, mfe, mae, bars: j - idx, exit: "tp" };
    } else {
      if (bar.high >= entry * (1 + slPct)) return { win: false, mfe, mae, bars: j - idx, exit: "sl" };
      if (bar.low <= entry * (1 - tpPct)) return { win: true, mfe, mae, bars: j - idx, exit: "tp" };
    }
  }
  return { win: false, mfe, mae, bars: MAX_HOLD, exit: "timeout" };
}

function scanSetups(cfg, pre) {
  const rows = [];
  for (let i = WARMUP; i < candles.length - 2; i++) {
    const sig = evaluateFibRetraceSetup(candles, i, cfg, pre);
    if (!sig) continue;
    const ctx = buildFibEntryContext(candles, i, pre, sig, cfg);
    const sim = forwardSim(candles, i, sig);
    let bucket = sim.win ? "WIN" : "LOSS";
    if (!sim.win && sim.mfe >= tpPctFromSig(sig) * 0.7) bucket = "GAVE_BACK";
    rows.push({ idx: i, ctx, sig, sim, bucket });
  }
  return rows;
}

function tpPctFromSig(sig) {
  return sig.tpPct ?? 0.004;
}

function summarize(label, rows) {
  const n = rows.length;
  const wins = rows.filter((r) => r.sim.win).length;
  const wr = n ? (wins / n) * 100 : 0;
  const tpm = (n / days) * 30;
  console.log(`[${label}] setups=${n} (${tpm.toFixed(1)}/mo) WR=${wr.toFixed(1)}%`);
  return { n, wr, wins };
}

function lossReport(losses) {
  const byReason = new Map();
  for (const r of losses) {
    for (const id of FIB_VETO_RULES) {
      try {
        if (id.test(r.ctx)) {
          byReason.set(id.id, (byReason.get(id.id) || 0) + 1);
        }
      } catch {
        /* skip */
      }
    }
  }
  console.log("\n── Loss clusters (static veto hit counts) ──");
  [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .forEach(([k, v]) => console.log(`  ${k}: ${v}/${losses.length}`));
}

console.error(`\n=== Fib bar-by-bar autopsy ${symbol} ${tf} (${days.toFixed(0)}d) ===\n`);

const pre = precomputeIntraday(candles);
const allRows = scanSetups(BASE_CFG, pre);
const losses = allRows.filter((r) => !r.sim.win);
const wins = allRows.filter((r) => r.sim.win);

summarize("all_setups_no_veto", allRows);
lossReport(losses);

console.log("\n── Sample losses (worst MAE) ──");
losses
  .sort((a, b) => a.sim.mae - b.sim.mae)
  .slice(0, 8)
  .forEach((r) => {
    const c = r.ctx;
    const blocked = FIB_VETO_RULES.filter((v) => v.test(c)).map((v) => v.id);
    console.log({
      ts: new Date(candles[r.idx].ts).toISOString().slice(0, 16),
      side: c.side,
      fib: `${c.fibRatio} ret=${c.fibRetrace?.toFixed(3)}`,
      mfe: +(r.sim.mfe * 100).toFixed(2),
      mae: +(r.sim.mae * 100).toFixed(2),
      adx: c.adx?.toFixed(1),
      rsi: c.rsi?.toFixed(1),
      macro: c.macroMode,
      vol: c.volRatio?.toFixed(2),
      wick: c.wick?.toFixed(2),
      block: blocked.slice(0, 5),
    });
  });

const discovered = discoverFibVetoRules(
  allRows.map((r) => ({ ctx: r.ctx, bucket: r.sim.win ? "WIN" : r.bucket })),
  { maxRules: 12 },
);
console.log("\n── Greedy discovered vetoes ──");
discovered.forEach((d) => console.log(`  ${d.id}: ${d.note}`));

const afterStatic = allRows.filter((r) => applyFibVetoes(r.ctx, PROD_CFG).allow);
summarize("after_static_vetoes", afterStatic);

const cfgDisc = {
  ...PROD_CFG,
  intradayFibCustomVetoRules: discovered.length ? discovered : undefined,
};
const afterDisc = allRows.filter((r) => {
  const v = applyFibVetoes(r.ctx, cfgDisc);
  return v.allow;
});
summarize("after_static+discovered", afterDisc);

async function runEngine(cfg, label) {
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
  const tpm = ((m.totalTrades ?? 0) / days) * 30;
  console.log(
    `[engine ${label}] trades=${m.totalTrades} (${tpm.toFixed(1)}/mo) WR=${((m.winRate ?? 0) * 100).toFixed(1)}% ret=${(m.totalReturnPct ?? 0).toFixed(2)}%`,
  );
}

console.log("\n── Full engine (portfolio sim) ──");
await runEngine(PROD_CFG, "prod_vetoes");
await runEngine(cfgDisc, "prod_vetoes+disc");

await closePool();
