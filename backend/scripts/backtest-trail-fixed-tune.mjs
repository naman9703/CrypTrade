#!/usr/bin/env node
/**
 * Tune Fixed % trailing + default bracket SL for UNIFIED_ELITE / SUPERTREND_ELITE.
 * Uses worker-parity 1m mark micro-trail (same as UI backtest worker).
 *
 * Usage (from backend/):
 *   node scripts/backtest-trail-fixed-tune.mjs --strategy both --quick
 *   node scripts/backtest-trail-fixed-tune.mjs --strategy UNIFIED_ELITE
 *   node scripts/backtest-trail-fixed-tune.mjs --strategy SUPERTREND_ELITE 9e6bb26c
 *   node scripts/backtest-trail-fixed-tune.mjs --no-micro   # debug parent-bar only
 */
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const quick = process.argv.includes("--quick");
const noMicro = process.argv.includes("--no-micro");
const stratArg = (() => {
  const i = process.argv.indexOf("--strategy");
  return i >= 0 ? String(process.argv[i + 1] || "both").toUpperCase() : "BOTH";
})();
const runPrefix = process.argv.find(
  (a) =>
    !a.startsWith("-") &&
    a.endsWith(".mjs") === false &&
    !a.includes("node") &&
    !["UNIFIED_ELITE", "SUPERTREND_ELITE", "BOTH"].includes(a.toUpperCase()),
);

const DEFAULT_RUN_PREFIX = {
  UNIFIED_ELITE: "9e6bb26c",
  SUPERTREND_ELITE: "1845b3b6",
};

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

function pickBot(snap) {
  if (!snap) return {};
  return snap.bot && typeof snap.bot === "object" ? snap.bot : snap;
}

function pnl(t) {
  return Number(t.netPnl ?? t.netPnlUsdt ?? t.pnlUsdt ?? 0);
}

const LOG_PATH = path.resolve(__dirname, ".fixed-trail-tune-progress.jsonl");

function logProgress(row) {
  try {
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(row)}\n`);
  } catch {
    /* ignore */
  }
}

const SL_GRID = quick
  ? [0.004, 0.006, 0.008, 0.01, 0.012, 0.015, 0.018, 0.02, 0.025]
  : [0.002, 0.003, 0.004, 0.005, 0.006, 0.008, 0.01, 0.012, 0.015, 0.02, 0.025];
const BUF_GRID = quick
  ? [0.001, 0.0015, 0.002, 0.003, 0.004, 0.005, 0.006, 0.008, 0.01]
  : [0.0005, 0.001, 0.0015, 0.002, 0.0025, 0.003, 0.004, 0.005, 0.007, 0.01];
const FEE_BE_GRID = quick ? [2, 2.5, 3] : [1.5, 2, 2.5, 3];
const POST_T02_GRID = quick ? [null, 0.001] : [null, 0.0005, 0.001, 0.0015, 0.002, 0.003];
/** T01 lock only in full grid — quick keeps saved/default 0 */
const T01_LOCK_GRID = quick ? [0] : [0, 0.0001, 0.0002, 0.0005, 0.001];

async function loadRun(prefix) {
  const runQ = await pool.query(
    `SELECT * FROM backtest_runs WHERE id::text LIKE $1 AND status = 'done' LIMIT 1`,
    [`${prefix}%`],
  );
  const run = runQ.rows[0];
  if (!run) throw new Error(`No completed run for prefix ${prefix}`);
  return run;
}

async function tuneStrategy(strategyKey, runPrefixOverride) {
  const prefix = runPrefixOverride || DEFAULT_RUN_PREFIX[strategyKey];
  const run = await loadRun(prefix);
  const baseCfg = pickBot(run.config_snapshot);
  baseCfg.symbol = run.symbol;
  baseCfg.timeframe = run.timeframe;
  baseCfg.manualStrategy = strategyKey;

  const fromMs = new Date(run.start_date).getTime();
  const toMs = new Date(run.end_date).getTime();
  const startingUsdt = Number(run.initial_capital) || 100;
  const market = String(baseCfg.marketMode ?? "FUTURES").toUpperCase() === "SPOT" ? "spot" : "futures";
  const isFutures = market === "futures";

  const { readCandles } = await import("../src/backtest/data/klineIngest.js");
  const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
  const { runSimulation } = await import("../src/backtest/engine/runner.js");
  const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
  const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
  const { materializeIntradayEngineCfgSync } = await import("../src/strategy/presets/srIntradayOptimized.js");
  const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");

  if (!baseCfg._intradayEngineMaterialized) {
    Object.assign(baseCfg, materializeIntradayEngineCfgSync(baseCfg, materializeIntradayPanelOnCfg));
  }

  const candles = await readCandles(run.symbol, run.timeframe, fromMs, toMs, { market });
  if (!candles.length) throw new Error(`No candles for ${run.symbol} ${run.timeframe}`);

  const funding = await readFundingRates(run.symbol, fromMs, toMs).catch(() => []);
  const adapters = await buildBacktestAdapters({
    strategyKey,
    cfg: baseCfg,
    symbol: run.symbol,
    tf: run.timeframe,
    candles,
    fromMs,
  });

  let sharedTrailMicro = null;
  async function resolveTrailMicro(cfg) {
    if (noMicro) return null;
    const futuresTrailMode = String(cfg?.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
    const trailEnabled =
      cfg?.trailingStopLossAuto === true && isFutures && futuresTrailMode !== "OFF";
    if (!trailEnabled) return null;
    if (sharedTrailMicro) return sharedTrailMicro;
    const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
    sharedTrailMicro = await buildTrailMicroContext({
      symbol: run.symbol,
      fromMs,
      toMs,
      cfg,
      trailEnabled: true,
    });
    return sharedTrailMicro;
  }

  function fixedCfg(overrides) {
    return {
      ...baseCfg,
      trailingStopLossAuto: true,
      trailSizingMode: "FIXED_PCT",
      futuresTrailingStopMode: "SUPERTREND",
      futuresTrailingStFeeBreakeven: baseCfg.futuresTrailingStFeeBreakeven !== false,
      futuresTrailingStAdvanced: baseCfg.futuresTrailingStAdvanced !== false,
      supertrendFuturesUseFixedSl: true,
      backtestTrailMicroTf: baseCfg.backtestTrailMicroTf ?? "1m",
      ...overrides,
    };
  }

  async function sim(overrides) {
    const cfg = fixedCfg(overrides);
    const trailMicro = await resolveTrailMicro(cfg);
    const sim = await runSimulation({
      strategyKey,
      candles,
      cfg,
      gateMode: String(run.gate_mode || "off") === "approx" ? "approx" : "off",
      fundingRates: funding,
      startingUsdt,
      timeframe: run.timeframe,
      adapters,
      symbol: run.symbol,
      trailMicro,
    });
    const m = computeAllMetrics({
      trades: sim.trades,
      equityCurve: sim.equityCurve,
      tf: run.timeframe,
      startingEquity: startingUsdt,
    });
    let trailN = 0;
    let trailPnl = 0;
    let slN = 0;
    for (const t of sim.trades) {
      if (t.exitReason === "trail") {
        trailN++;
        trailPnl += pnl(t);
      }
      if (t.exitReason === "sl") slN++;
    }
    const ret = m.totalReturnPct ?? 0;
    const dd = m.maxDrawdownPct ?? 0;
    const pf = m.profitFactor ?? 0;
    const score = ret - dd * 0.3 + (pf > 1 ? pf * 2 : 0);
    return { ret, dd, wr: (m.winRate ?? 0) * 100, pf, trailN, slN, trailPnl, score, cfg, n: m.totalTrades ?? 0 };
  }

  const combos =
    SL_GRID.length * BUF_GRID.length * FEE_BE_GRID.length * POST_T02_GRID.length * T01_LOCK_GRID.length;

  console.log(`\n${"=".repeat(72)}`);
  console.log(`FIXED % + SL tune | ${strategyKey}`);
  console.log(`baseline run: ${run.id.slice(0, 8)}… | ${run.symbol} ${run.timeframe}`);
  console.log(
    `window: ${run.start_date?.toISOString?.()?.slice(0, 10)} → ${run.end_date?.toISOString?.()?.slice(0, 10)} | stored ret: ${Number(run.metrics?.totalReturnPct).toFixed(1)}%`,
  );
  console.log(
    `trail sim: ${noMicro ? "parent-bar (--no-micro)" : "worker 1m mark micro"} | ${quick ? "2-phase quick" : `full grid ${combos} combos`}`,
  );
  console.log(`${"=".repeat(72)}\n`);

  const baseline = await sim({
    supertrendFuturesFixedSlPct: Number(baseCfg.supertrendFuturesFixedSlPct ?? 0.002),
    trailBufferRate: Number(baseCfg.trailBufferRate ?? 0.0005),
    trailFeeBeMultiplier: Number(baseCfg.trailFeeBeMultiplier ?? 2),
    trailPostT02SpacingFrac: baseCfg.trailPostT02SpacingFrac ?? null,
    trailT01LockSlippageFrac: Number(baseCfg.trailT01LockSlippageFrac ?? 0),
  });
  console.log(
    `baseline (saved params): ret=${baseline.ret.toFixed(1)}% DD=${baseline.dd.toFixed(1)}% trail=${baseline.trailN} sl=${baseline.slN} trail$=${baseline.trailPnl.toFixed(1)} PF=${baseline.pf.toFixed(2)}`,
  );

  const results = [];
  let n = 0;

  async function runGrid(slList, bufList, feeList, postList, t01List, phaseLabel) {
    const total = slList.length * bufList.length * feeList.length * postList.length * t01List.length;
    if (total === 0) return;
    console.log(`\n--- ${phaseLabel} (${total} combos) ---\n`);
    for (const sl of slList) {
      for (const buf of bufList) {
        for (const feeBe of feeList) {
          for (const postT02 of postList) {
            for (const t01 of t01List) {
              n++;
              const label = `sl=${sl} buf=${buf} feeBe=${feeBe} t02=${postT02 ?? "null"} t01=${t01}`;
              process.stdout.write(`  [${n}] ${label.slice(0, 52).padEnd(52)} `);
              const r = await sim({
                supertrendFuturesFixedSlPct: sl,
                trailBufferRate: buf,
                trailFeeBeMultiplier: feeBe,
                trailPostT02SpacingFrac: postT02,
                trailT01LockSlippageFrac: t01,
              });
              results.push({ label, ...r });
              logProgress({ strategyKey, label, ret: r.ret, dd: r.dd, pf: r.pf, trailN: r.trailN, slN: r.slN, score: r.score, sl, buf, feeBe, postT02, t01 });
              console.log(
                `ret=${r.ret.toFixed(1).padStart(7)}% DD=${r.dd.toFixed(1).padStart(5)}% trail=${String(r.trailN).padStart(2)} sl=${String(r.slN).padStart(2)} PF=${r.pf.toFixed(2)}`,
              );
            }
          }
        }
      }
    }
  }

  if (quick) {
    const defaultFee = Number(baseCfg.trailFeeBeMultiplier ?? 2);
    const defaultPost = baseCfg.trailPostT02SpacingFrac ?? null;
    await runGrid(SL_GRID, BUF_GRID, [defaultFee], [defaultPost], [0], "Phase 1: SL × trail buffer");
    results.sort((a, b) => b.score - a.score);
    const topSlBuf = [...new Set(results.slice(0, 8).map((r) => r.cfg.supertrendFuturesFixedSlPct))];
    const topBuf = [...new Set(results.slice(0, 8).map((r) => r.cfg.trailBufferRate))];
    await runGrid(topSlBuf, topBuf, FEE_BE_GRID, POST_T02_GRID, [0], "Phase 2: fee BE × post-T02 on top SL/buffer");
  } else {
    await runGrid(SL_GRID, BUF_GRID, FEE_BE_GRID, POST_T02_GRID, T01_LOCK_GRID, "Full grid");
  }

  results.sort((a, b) => b.score - a.score);
  const best = results[0];

  console.log(`\n--- TOP 10 (${strategyKey}) ---`);
  for (const r of results.slice(0, 10)) {
    console.log(
      `${r.label.padEnd(52)} ret=${r.ret.toFixed(2).padStart(8)}% DD=${r.dd.toFixed(1)}% trail=${r.trailN} trail$=${r.trailPnl.toFixed(0)} PF=${r.pf.toFixed(2)}`,
    );
  }

  console.log(`\n=== BEST ${strategyKey} (micro trail) ===`);
  console.log(`Return ${best.ret.toFixed(2)}% vs baseline ${baseline.ret.toFixed(2)}% (Δ ${(best.ret - baseline.ret).toFixed(2)}%)`);
  console.log(`DD ${best.dd.toFixed(1)}% | WR ${best.wr.toFixed(0)}% | PF ${best.pf.toFixed(2)} | trades ${best.n}`);
  console.log(`Trail exits ${best.trailN} (net $${best.trailPnl.toFixed(2)}) | SL exits ${best.slN}`);
  console.log("\nRecommended Fixed % + SL params:");
  console.log(
    JSON.stringify(
      {
        trailSizingMode: "FIXED_PCT",
        trailingStopLossAuto: true,
        supertrendFuturesUseFixedSl: true,
        supertrendFuturesFixedSlPct: best.cfg.supertrendFuturesFixedSlPct,
        trailBufferRate: best.cfg.trailBufferRate,
        trailFeeBeMultiplier: best.cfg.trailFeeBeMultiplier,
        trailPostT02SpacingFrac: best.cfg.trailPostT02SpacingFrac ?? null,
        trailT01LockSlippageFrac: best.cfg.trailT01LockSlippageFrac ?? 0,
        futuresTrailingStFeeBreakeven: best.cfg.futuresTrailingStFeeBreakeven !== false,
        futuresTrailingStAdvanced: best.cfg.futuresTrailingStAdvanced !== false,
      },
      null,
      2,
    ),
  );

  return { strategyKey, baseline, best, results };
}

const strategies =
  stratArg === "BOTH" ? ["UNIFIED_ELITE", "SUPERTREND_ELITE"] : [stratArg];

const summaries = [];
for (const sk of strategies) {
  if (!DEFAULT_RUN_PREFIX[sk] && !runPrefix) {
    console.error(`Unknown strategy ${sk}`);
    continue;
  }
  summaries.push(await tuneStrategy(sk, runPrefix && strategies.length === 1 ? runPrefix : undefined));
}

if (summaries.length > 1) {
  console.log(`\n${"=".repeat(72)}`);
  console.log("SUMMARY — best Fixed % + SL per strategy (1m micro trail)");
  console.log("=".repeat(72));
  for (const s of summaries) {
    console.log(
      `${s.strategyKey.padEnd(18)} best ret=${s.best.ret.toFixed(1)}% (baseline ${s.baseline.ret.toFixed(1)}%) | sl=${s.best.cfg.supertrendFuturesFixedSlPct} buf=${s.best.cfg.trailBufferRate} feeBe=${s.best.cfg.trailFeeBeMultiplier}`,
    );
  }
}

await closePool();
