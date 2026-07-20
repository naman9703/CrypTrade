#!/usr/bin/env node
/**
 * V2 dynamic trailing (ATR SL + micro floor + hybrid ratchet) vs tuned Fixed %.
 * Worker-parity 1m mark micro-trail. Multi-coin robustness check.
 *
 * Usage (from backend/):
 *   node scripts/backtest-trail-dynamic-v2-tune.mjs --quick
 *   node scripts/backtest-trail-dynamic-v2-tune.mjs --strategy SUPERTREND_ELITE
 *   node scripts/backtest-trail-dynamic-v2-tune.mjs 1845b3b6
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { DYNAMIC_TRAIL_V2_DEFAULTS } from "../src/lib/dynamicTrailing.js";

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

/** Tuned Fixed % from micro-trail grid (same window family). */
const TUNED_FIXED = {
  UNIFIED_ELITE: {
    supertrendFuturesFixedSlPct: 0.025,
    trailBufferRate: 0.01,
    trailFeeBeMultiplier: 2,
    trailPostT02SpacingFrac: 0.001,
    trailSizingMode: "FIXED_PCT",
  },
  SUPERTREND_ELITE: {
    supertrendFuturesFixedSlPct: 0.01,
    trailBufferRate: 0.01,
    trailFeeBeMultiplier: 2,
    trailPostT02SpacingFrac: 0.001,
    trailSizingMode: "FIXED_PCT",
  },
};

const MULTI_COIN = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "LINKUSDT"];

const SL_ATR_GRID = quick ? [2.0, 2.5, 3.0] : [1.5, 2.0, 2.5, 3.0, 3.5];
const BE_ATR_GRID = quick ? [0.85, 1.0, 1.25] : [0.75, 0.85, 1.0, 1.15, 1.3];
const HWM_GRID = quick ? [1.75, 2.0, 2.25] : [1.25, 1.5, 2.0, 2.5, 3.0];
const MICRO_FLOOR_GRID = quick ? [1.0] : [0.75, 0.85, 1.0, 1.15, 1.25];
const GIVEBACK_GRID = quick ? [0.2, 0.22, 0.25] : [0.15, 0.18, 0.22, 0.28, 0.35];

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
  baseCfg.timeframe = run.timeframe;
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

  const symbols = quick ? [run.symbol, "ETHUSDT", "SOLUSDT"] : MULTI_COIN;
  const symbolCtx = new Map();

  for (const sym of symbols) {
    const candles = await readCandles(sym, run.timeframe, fromMs, toMs, { market });
    if (!candles.length) {
      console.warn(`  skip ${sym}: no candles`);
      continue;
    }
    const cfg = { ...baseCfg, symbol: sym, manualStrategy: strategyKey };
    const funding = await readFundingRates(sym, fromMs, toMs).catch(() => []);
    const adapters = await buildBacktestAdapters({
      strategyKey,
      cfg,
      symbol: sym,
      tf: run.timeframe,
      candles,
      fromMs,
    });
    symbolCtx.set(sym, { candles, funding, adapters, cfg });
  }

  if (!symbolCtx.size) throw new Error("No candle data for any symbol");

  const trailMicroCache = new Map();
  async function resolveTrailMicro(sym, cfg) {
    if (noMicro) return null;
    const futuresTrailMode = String(cfg?.futuresTrailingStopMode ?? "SUPERTREND").toUpperCase();
    const trailEnabled =
      cfg?.trailingStopLossAuto === true && isFutures && futuresTrailMode !== "OFF";
    if (!trailEnabled) return null;
    const key = sym;
    if (trailMicroCache.has(key)) return trailMicroCache.get(key);
    const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
    const ctx = await buildTrailMicroContext({
      symbol: sym,
      fromMs,
      toMs,
      cfg,
      trailEnabled: true,
    });
    trailMicroCache.set(key, ctx);
    return ctx;
  }

  function trailCfg(overrides) {
    return {
      ...baseCfg,
      trailingStopLossAuto: true,
      futuresTrailingStopMode: "SUPERTREND",
      futuresTrailingStFeeBreakeven: baseCfg.futuresTrailingStFeeBreakeven !== false,
      futuresTrailingStAdvanced: baseCfg.futuresTrailingStAdvanced !== false,
      supertrendFuturesUseFixedSl: true,
      backtestTrailMicroTf: baseCfg.backtestTrailMicroTf ?? "1m",
      manualStrategy: strategyKey,
      ...overrides,
    };
  }

  async function simOne(sym, overrides) {
    const ctx = symbolCtx.get(sym);
    if (!ctx) return null;
    const cfg = trailCfg({ ...ctx.cfg, ...overrides, symbol: sym });
    const trailMicro = await resolveTrailMicro(sym, cfg);
    const sim = await runSimulation({
      strategyKey,
      candles: ctx.candles,
      cfg,
      gateMode: String(run.gate_mode || "off") === "approx" ? "approx" : "off",
      fundingRates: ctx.funding,
      startingUsdt,
      timeframe: run.timeframe,
      adapters: ctx.adapters,
      symbol: sym,
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
    for (const t of sim.trades) {
      if (t.exitReason === "trail") {
        trailN++;
        trailPnl += pnl(t);
      }
    }
    const ret = m.totalReturnPct ?? 0;
    const dd = m.maxDrawdownPct ?? 0;
    const pf = m.profitFactor ?? 0;
    const score = ret - dd * 0.3 + (pf > 1 ? pf * 2 : 0);
    return { sym, ret, dd, wr: (m.winRate ?? 0) * 100, pf, trailN, trailPnl, score, n: m.totalTrades ?? 0, cfg };
  }

  async function simPortfolio(label, overrides) {
    const rows = [];
    for (const sym of symbolCtx.keys()) {
      const r = await simOne(sym, overrides);
      if (r) rows.push(r);
    }
    if (!rows.length) return null;
    const avgRet = rows.reduce((s, r) => s + r.ret, 0) / rows.length;
    const avgDd = rows.reduce((s, r) => s + r.dd, 0) / rows.length;
    const minRet = Math.min(...rows.map((r) => r.ret));
    const score = avgRet - avgDd * 0.3;
    return { label, avgRet, avgDd, minRet, score, rows, cfg: rows[0]?.cfg };
  }

  console.log(`\n${"=".repeat(72)}`);
  console.log(`DYNAMIC V2 tune | ${strategyKey}`);
  console.log(`baseline run: ${run.id.slice(0, 8)}… | ${run.timeframe} | coins: ${[...symbolCtx.keys()].join(", ")}`);
  console.log(
    `window: ${run.start_date?.toISOString?.()?.slice(0, 10)} → ${run.end_date?.toISOString?.()?.slice(0, 10)}`,
  );
  console.log(`trail sim: ${noMicro ? "parent-bar" : "1m mark micro"} | ${quick ? "quick grid" : "full grid"}`);
  console.log(`${"=".repeat(72)}\n`);

  const results = [];

  const saved = await simPortfolio("saved params", {
    trailSizingMode: "FIXED_PCT",
    supertrendFuturesFixedSlPct: Number(baseCfg.supertrendFuturesFixedSlPct ?? 0.002),
    trailBufferRate: Number(baseCfg.trailBufferRate ?? 0.0005),
  });
  if (saved) {
    results.push({ ...saved, kind: "baseline" });
    console.log(
      `saved:     avgRet=${saved.avgRet.toFixed(1)}% min=${saved.minRet.toFixed(1)}% avgDD=${saved.avgDd.toFixed(1)}%`,
    );
  }

  const tunedFixed = TUNED_FIXED[strategyKey];
  const fixed = await simPortfolio("tuned FIXED_PCT", tunedFixed);
  if (fixed) {
    results.push({ ...fixed, kind: "fixed" });
    console.log(
      `tuned fix: avgRet=${fixed.avgRet.toFixed(1)}% min=${fixed.minRet.toFixed(1)}% avgDD=${fixed.avgDd.toFixed(1)}%`,
    );
  }

  const v2defaults = await simPortfolio("DYNAMIC v2 defaults", {
    trailSizingMode: "DYNAMIC",
    ...DYNAMIC_TRAIL_V2_DEFAULTS,
  });
  if (v2defaults) {
    results.push({ ...v2defaults, kind: "dynamic" });
    console.log(
      `v2 default: avgRet=${v2defaults.avgRet.toFixed(1)}% min=${v2defaults.minRet.toFixed(1)}% avgDD=${v2defaults.avgDd.toFixed(1)}%`,
    );
  }

  console.log("\n--- Dynamic grid (portfolio avg) ---\n");
  let n = 0;

  async function runDynGrid(slList, beList, hwmList, microList, gbList, phaseLabel) {
    const total = slList.length * beList.length * hwmList.length * microList.length * gbList.length;
    if (!total) return;
    console.log(`\n--- ${phaseLabel} (${total} combos) ---\n`);
    for (const slAtr of slList) {
      for (const beAtr of beList) {
        for (const hwm of hwmList) {
          for (const micro of microList) {
            for (const gb of gbList) {
              n++;
              const label = `sl=${slAtr} be=${beAtr} hwm=${hwm} μ=${micro} gb=${gb}`;
              process.stdout.write(`  [${n}] ${label.slice(0, 48).padEnd(48)} `);
              const r = await simPortfolio(label, {
                trailSizingMode: "DYNAMIC",
                trailDynamicSlAtrMult: slAtr,
                trailDynamicBeAtrMult: beAtr,
                trailDynamicAdvAtrHwmMult: hwm,
                trailDynamicMicroFloorMult: micro,
                trailDynamicAdvMfeGivebackFrac: gb,
                trailDynamicBeRegimeAdjust: true,
                trailDynamicAdvMergeSupertrend: true,
                trailDynamicAdvAtrSource: "ENTRY",
                trailDynamicAdvMfeMinR: DYNAMIC_TRAIL_V2_DEFAULTS.trailDynamicAdvMfeMinR,
                trailDynamicAdvPostT02StepAtrMult: DYNAMIC_TRAIL_V2_DEFAULTS.trailDynamicAdvPostT02StepAtrMult,
              });
              if (r) {
                results.push({ ...r, kind: "dynamic" });
                console.log(`avg=${r.avgRet.toFixed(1)}% min=${r.minRet.toFixed(1)}% DD=${r.avgDd.toFixed(1)}%`);
              } else {
                console.log("skip");
              }
            }
          }
        }
      }
    }
  }

  if (quick) {
    const d = DYNAMIC_TRAIL_V2_DEFAULTS;
    await runDynGrid(SL_ATR_GRID, BE_ATR_GRID, [d.trailDynamicAdvAtrHwmMult], [d.trailDynamicMicroFloorMult], GIVEBACK_GRID, "quick phase-1 SL×BE");
    const phase1Best = results
      .filter((r) => r.kind === "dynamic" && r.label.startsWith("sl="))
      .sort((a, b) => b.score - a.score)[0];
    if (phase1Best?.cfg) {
      const c = phase1Best.cfg;
      await runDynGrid(
        [c.trailDynamicSlAtrMult],
        [c.trailDynamicBeAtrMult],
        HWM_GRID,
        MICRO_FLOOR_GRID,
        GIVEBACK_GRID,
        "quick phase-2 HWM×GB around best SL/BE",
      );
    }
  } else {
    await runDynGrid(SL_ATR_GRID, BE_ATR_GRID, HWM_GRID, MICRO_FLOOR_GRID, GIVEBACK_GRID, "full grid");
  }

  results.sort((a, b) => b.score - a.score);
  const bestDyn = results.filter((r) => r.kind === "dynamic").sort((a, b) => b.score - a.score)[0];

  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║ TOP 8 (portfolio avg return − 0.3×avg DD)                  ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");
  for (const r of results.slice(0, 8)) {
    console.log(
      `${r.label.padEnd(42)} avgRet=${r.avgRet.toFixed(2).padStart(7)}% min=${r.minRet.toFixed(1).padStart(6)}% DD=${r.avgDd.toFixed(1)}%`,
    );
    for (const row of r.rows ?? []) {
      console.log(`    ${row.sym.padEnd(10)} ret=${row.ret.toFixed(1).padStart(6)}% trail=${row.trailN} DD=${row.dd.toFixed(1)}%`);
    }
  }

  console.log("\n=== VERDICT ===");
  if (fixed && bestDyn) {
    const delta = bestDyn.avgRet - fixed.avgRet;
    console.log(`Tuned Fixed % portfolio avg: ${fixed.avgRet.toFixed(2)}% (min coin ${fixed.minRet.toFixed(1)}%)`);
    console.log(`Best Dynamic V2 portfolio avg: ${bestDyn.avgRet.toFixed(2)}% (min coin ${bestDyn.minRet.toFixed(1)}%)`);
    console.log(`Δ Dynamic − Fixed: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}% avg return`);
    if (bestDyn.cfg) {
      console.log("\nRecommended DYNAMIC params:");
      const c = bestDyn.cfg;
      console.log(
        JSON.stringify(
          {
            trailSizingMode: "DYNAMIC",
            trailDynamicSlAtrMult: c.trailDynamicSlAtrMult,
            trailDynamicBeAtrMult: c.trailDynamicBeAtrMult,
            trailDynamicMicroFloorMult: c.trailDynamicMicroFloorMult,
            trailDynamicAdvAtrHwmMult: c.trailDynamicAdvAtrHwmMult,
            trailDynamicAdvMfeGivebackFrac: c.trailDynamicAdvMfeGivebackFrac,
            trailDynamicAdvMfeMinR: c.trailDynamicAdvMfeMinR,
            trailDynamicAdvPostT02StepAtrMult: c.trailDynamicAdvPostT02StepAtrMult,
            trailDynamicBeRegimeAdjust: c.trailDynamicBeRegimeAdjust,
          },
          null,
          2,
        ),
      );
    }
  }

  return { strategyKey, fixed, bestDyn, results };
}

const strategies =
  stratArg === "BOTH" ? ["UNIFIED_ELITE", "SUPERTREND_ELITE"] : [stratArg];

for (const sk of strategies) {
  if (!DEFAULT_RUN_PREFIX[sk]) continue;
  try {
    await tuneStrategy(sk, runPrefix && strategies.length === 1 ? runPrefix : undefined);
  } catch (e) {
    console.error(`\n${sk} failed:`, e.message);
  }
}

await closePool();
