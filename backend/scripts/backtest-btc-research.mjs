#!/usr/bin/env node
/**
 * BTCUSDT comprehensive strategy research — per-strategy optimize + combos.
 *
 *   node scripts/backtest-btc-research.mjs
 *   node scripts/backtest-btc-research.mjs --phase deep --strategy HTF_RSI
 *   node scripts/backtest-btc-research.mjs --phase combo
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const symbol = "BTCUSDT";
const fromMs = new Date(arg("from", "2026-01-01")).getTime();
const toMs = new Date(arg("to", "2026-05-18")).getTime();
const startingUsdt = Number(arg("capital", "100"));
const phase = arg("phase", "all");
const onlyStrategy = arg("strategy", null);
const topN = Number(arg("top", "25"));

const ALL_STRATEGIES = [
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

const TURBO = process.argv.includes("--turbo");
const TIMEFRAMES = TURBO ? ["15m"] : ["15m", "1h"];
const TIMEFRAMES_DEEP = TURBO ? ["15m"] : ["15m", "1h", "4h"];

const SL_TP_COARSE = [
  { sl: 0.004, tp: 0.008 },
  { sl: 0.006, tp: 0.012 },
  { sl: 0.006, tp: 0.018 },
  { sl: 0.008, tp: 0.016 },
  { sl: 0.008, tp: 0.024 },
  { sl: 0.01, tp: 0.02 },
  { sl: 0.01, tp: 0.03 },
  { sl: 0.012, tp: 0.036 },
  { sl: 0.006, tp: 0, trail: true },
  { sl: 0.008, tp: 0, trail: true },
];

const SL_TP_FINE = [
  { sl: 0.005, tp: 0.01 },
  { sl: 0.005, tp: 0.015 },
  { sl: 0.006, tp: 0.012 },
  { sl: 0.006, tp: 0.015 },
  { sl: 0.006, tp: 0.018 },
  { sl: 0.006, tp: 0.021 },
  { sl: 0.007, tp: 0.014 },
  { sl: 0.007, tp: 0.021 },
  { sl: 0.008, tp: 0.016 },
  { sl: 0.008, tp: 0.024 },
  { sl: 0.008, tp: 0.032 },
  { sl: 0.009, tp: 0.027 },
  { sl: 0.01, tp: 0.02 },
  { sl: 0.01, tp: 0.03 },
  { sl: 0.01, tp: 0.04 },
  { sl: 0.012, tp: 0.024 },
  { sl: 0.012, tp: 0.036 },
  { sl: 0.015, tp: 0.045 },
];

const RISK_LEVELS = TURBO ? [5, 7] : [3, 5, 7, 10];
const LEV_LEVELS = TURBO ? [15, 25] : [10, 15, 25];
const ST_GRID = [
  { period: 7, mult: 2.5 },
  { period: 10, mult: 2.5 },
  { period: 10, mult: 3 },
  { period: 14, mult: 3 },
];

function baseCfg(overrides = {}) {
  return {
    marketMode: "FUTURES",
    futuresLeverage: 15,
    backtestPositionSizing: "RISK_AT_SL",
    riskPerTrade: 5,
    riskPerTradeUnit: "PCT_EQUITY",
    supertrendWilderAtr: true,
    supertrendFuturesAuto: false,
    strategyMode: "MANUAL",
    trailingStopLossAuto: false,
    supertrendMoveQualityGate: false,
    signalStrengthGatesTrades: false,
    slippagePct: 0.0005,
    tradeHistoryTakerOpenFeeRate: 0.0004,
    tradeHistoryTakerCloseFeeRate: 0.0004,
    surfPulseMlGateEnabled: false,
    ...overrides,
  };
}

function targetScore(m) {
  const ret = Number(m.totalReturnPct ?? 0);
  const wr = Number(m.winRate ?? 0) * 100;
  const n = m.totalTrades ?? 0;
  if (n < 5) return -1e9;
  const dd = Math.abs(Number(m.maxDrawdownPct ?? 0));
  const meetsTarget = ret >= 1000 && wr >= 80;
  const targetBonus = meetsTarget ? 5000 : 0;
  const retScore = ret >= 1000 ? ret * 2 : ret * 1.5;
  const wrScore = wr >= 80 ? wr * 3 : wr * 0.5;
  const ddPen = dd > 50 ? (dd - 50) * 3 : dd > 30 ? (dd - 30) : 0;
  return targetBonus + retScore + wrScore - ddPen + Math.min(n, 40) * 0.5;
}

async function runSim({ strategyKey, tf, cfg, candles, fromMs }) {
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

  return { metrics, sim };
}

const COMBO_DEFS = [
  { key: "COMBO_2of4", keys: ["EMA_CROSS", "RSI_MEAN", "MOMENTUM_SURGE", "BREAKOUT_VOL"], min: 2 },
  { key: "COMBO_3of4", keys: ["EMA_CROSS", "RSI_MEAN", "MOMENTUM_SURGE", "BREAKOUT_VOL"], min: 3 },
  { key: "COMBO_TREND_MR", keys: ["EMA_CROSS", "RSI_MEAN"], min: 2 },
  { key: "COMBO_HTF_CONF", keys: ["HTF_RSI", "CONFLUENCE"], min: 2 },
  { key: "COMBO_HTF_ENS", keys: ["HTF_RSI", "ENSEMBLE"], min: 2 },
  { key: "COMBO_PULL_HTF", keys: ["TREND_PULLBACK", "HTF_RSI"], min: 2 },
  { key: "COMBO_ST_HTF", keys: ["TREND_HTF_ST", "HTF_RSI"], min: 2 },
  { key: "COMBO_LEG_HTF", keys: ["HTF_LEG_RIDER", "HTF_RSI"], min: 2 },
  { key: "COMBO_SMART_HTF", keys: ["SMART_REVERSAL", "HTF_RSI"], min: 2 },
  { key: "COMBO_SURF_HTF", keys: ["SURF_PULSE_ML", "HTF_RSI"], min: 2 },
  { key: "COMBO_3HTF", keys: ["HTF_RSI", "TREND_HTF_ST", "HTF_LEG_RIDER"], min: 2 },
];

async function runCombo({ comboKey, keys, minAgree, tf, cfg, candles, fromMs }) {
  const { runSimulation } = await import("../src/backtest/engine/runner.js");
  const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
  const { buildBaselineAdapters, buildBacktestAdapters } = await import(
    "../src/backtest/engine/signals/baselines.js"
  );
  const { buildHtfRsiBacktestAdapter } = await import("../src/strategy/htfRsi.js");
  const { buildTrendHtfStBacktestAdapter } = await import("../src/strategy/trendHtfSt.js");
  const { buildHtfLegRiderBacktestAdapter } = await import("../src/strategy/htfLegRider.js");

  const base = buildBaselineAdapters();
  if (keys.includes("HTF_RSI")) base.HTF_RSI = buildHtfRsiBacktestAdapter(candles, tf);
  if (keys.includes("TREND_HTF_ST")) {
    base.TREND_HTF_ST = buildTrendHtfStBacktestAdapter(candles, {
      period: Number(cfg.supertrendPeriod ?? 10),
      multiplier: Number(cfg.supertrendMultiplier ?? 2.5),
    });
  }
  if (keys.includes("HTF_LEG_RIDER")) {
    base.HTF_LEG_RIDER = buildHtfLegRiderBacktestAdapter(candles, { lookback: 32 });
  }

  let lastDir = 0;
  const comboAdapter = (bar, idx, ctx) => {
    if (idx < 80) return null;
    let buys = 0;
    let sells = 0;
    for (const k of keys) {
      const sub = base[k];
      if (!sub) continue;
      const sig = sub(bar, idx, ctx);
      if (!sig) continue;
      if (sig.action === "BUY") buys++;
      else if (sig.action === "SELL") sells++;
    }
    if (buys >= minAgree && lastDir !== 1) {
      lastDir = 1;
      return { action: "BUY", reason: `${comboKey}_buy` };
    }
    if (sells >= minAgree && lastDir !== -1) {
      lastDir = -1;
      return { action: "SELL", reason: `${comboKey}_sell` };
    }
    return null;
  };

  const adapters = { [comboKey]: comboAdapter };
  const sim = await runSimulation({
    strategyKey: comboKey,
    candles,
    cfg,
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
  return { metrics };
}

function* coarseGrid(strategies) {
  for (const tf of TIMEFRAMES) {
    for (const strategyKey of strategies) {
      const isSt = strategyKey === "SUPERTREND";
      const stList = isSt ? ST_GRID : [{ period: 10, mult: 3 }];
      for (const st of stList) {
        for (const risk of SL_TP_COARSE) {
          yield { tf, strategyKey, st, risk, riskPct: 5, lev: 15 };
        }
      }
    }
  }
}

function* deepGrid(strategyKey, tfFilter) {
  const tfs = tfFilter ? [tfFilter] : TIMEFRAMES_DEEP;
  const isSt = strategyKey === "SUPERTREND";
  const stList = isSt ? ST_GRID : [{ period: 10, mult: 3 }];
  for (const tf of tfs) {
    for (const st of stList) {
      for (const risk of SL_TP_FINE) {
        for (const riskPct of RISK_LEVELS) {
          for (const lev of LEV_LEVELS) {
            yield { tf, strategyKey, st, risk, riskPct, lev };
          }
        }
      }
    }
  }
}

function rowFromResult(r) {
  return {
    strategy: r.strategyKey,
    tf: r.tf,
    sl: r.risk?.sl,
    tp: r.risk?.tp,
    trail: r.risk?.trail,
    riskPct: r.riskPct,
    lev: r.lev,
    ret: r.ret,
    wr: r.wr,
    n: r.n,
    pf: r.pf,
    dd: r.dd,
    score: r.score,
    meets: r.ret >= 1000 && r.wr >= 80,
  };
}

async function evaluateOne(c, candles, fromMs) {
  const cfg = baseCfg({
    manualStrategy: c.strategyKey,
    supertrendPeriod: c.st.period,
    supertrendMultiplier: c.st.mult,
    supertrendFuturesFixedSlPct: c.risk.sl,
    supertrendFuturesFixedTpPct: c.risk.tp ?? 0,
    trailingStopLossAuto: Boolean(c.risk.trail),
    riskPerTrade: c.riskPct,
    futuresLeverage: c.lev,
    ...(c.strategyKey === "AUTO" ? { strategyMode: "AUTO", manualStrategy: undefined } : {}),
  });

  const { metrics } = await runSim({
    strategyKey: c.strategyKey,
    tf: c.tf,
    cfg,
    candles,
    fromMs,
  });

  const ret = metrics.totalReturnPct ?? 0;
  const wr = (metrics.winRate ?? 0) * 100;
  const n = metrics.totalTrades ?? 0;
  const score = targetScore(metrics);

  return {
    ...c,
    ret,
    wr,
    n,
    pf: metrics.profitFactor ?? 0,
    dd: metrics.maxDrawdownPct ?? 0,
    score,
    metrics,
  };
}

function printTable(title, rows, limit = topN) {
  console.log(`\n═══ ${title} ═══`);
  console.log(
    `${"rank".padStart(4)} ${"strategy".padEnd(18)} ${"tf".padStart(4)} ${"n".padStart(4)} ${"ret%".padStart(9)} ${"WR%".padStart(6)} ${"PF".padStart(5)} ${"DD%".padStart(7)} ${"risk".padStart(4)} ${"lev".padStart(4)} SL/TP`
  );
  console.log("-".repeat(100));
  rows.slice(0, limit).forEach((r, i) => {
    const sltp = r.trail
      ? `${(r.sl * 100).toFixed(1)}% trail`
      : `${(r.sl * 100).toFixed(1)}/${(r.tp * 100).toFixed(1)}`;
    const tgt = r.meets ? " ★TARGET" : "";
    console.log(
      `${String(i + 1).padStart(4)} ${String(r.strategy).padEnd(18)} ${r.tf.padStart(4)} ${String(r.n).padStart(4)} ${r.ret.toFixed(1).padStart(9)} ${r.wr.toFixed(1).padStart(6)} ${(r.pf ?? 0).toFixed(2).padStart(5)} ${(r.dd ?? 0).toFixed(1).padStart(7)} ${String(r.riskPct).padStart(4)} ${String(r.lev).padStart(4)} ${sltp}${tgt}`
    );
  });
}

async function main() {
  const { initPool, closePool, getPool } = await import("../src/db/pool.js");
  if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

  const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");

  console.log(`\nBTC Strategy Research · ${symbol}`);
  console.log(`Window: ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}`);
  console.log(`Capital: $${startingUsdt} · Target: 1000%+ return AND 80%+ win rate\n`);

  const candleCache = new Map();
  const loadTfs = [...new Set([...TIMEFRAMES, ...TIMEFRAMES_DEEP])];
  for (const tf of loadTfs) {
    process.stdout.write(`Loading ${tf}... `);
    await ensureKlines(symbol, tf, { from: fromMs, to: toMs, market: "futures" });
    const candles = await readCandles(symbol, tf, fromMs, toMs);
    candleCache.set(tf, candles);
    console.log(`${candles.length} bars`);
  }

  const allResults = [];

  // ── Phase 1: coarse per-strategy ──
  if (phase === "all" || phase === "coarse") {
    const strategies = onlyStrategy ? [onlyStrategy] : ALL_STRATEGIES;
    const grid = [...coarseGrid(strategies)];
    console.log(`\nPhase 1: coarse grid — ${grid.length} configs × ${strategies.length} strategies`);

    const byStrategy = new Map();
    let done = 0;
    const t0 = Date.now();

    for (const c of grid) {
      const candles = candleCache.get(c.tf);
      if (!candles?.length) continue;
      try {
        const r = await evaluateOne(c, candles, fromMs);
        const row = rowFromResult(r);
        allResults.push(row);
        const list = byStrategy.get(c.strategyKey) ?? [];
        list.push(row);
        byStrategy.set(c.strategyKey, list);
      } catch (e) {
        /* skip */
      }
      done++;
      if (done % 10 === 0 || done === grid.length) {
        process.stdout.write(`\r  ${done}/${grid.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)   `);
      }
    }
    console.log(`\n  Done phase 1 in ${((Date.now() - t0) / 1000).toFixed(0)}s`);

    console.log("\n── Best per strategy (coarse) ──");
    for (const strat of strategies) {
      const list = (byStrategy.get(strat) ?? []).sort((a, b) => b.score - a.score);
      const best = list[0];
      if (!best) {
        console.log(`${strat.padEnd(18)} — no viable runs`);
        continue;
      }
      const sltp = best.trail ? "trail" : `${(best.sl * 100).toFixed(1)}/${(best.tp * 100).toFixed(1)}`;
      console.log(
        `${strat.padEnd(18)} ${best.tf.padStart(4)} n=${String(best.n).padStart(3)} ret=${best.ret.toFixed(1).padStart(8)}% WR=${best.wr.toFixed(1).padStart(5)}% ${sltp}`
      );
    }

    const topOverall = [...allResults].sort((a, b) => b.score - a.score);
    printTable("TOP OVERALL (coarse)", topOverall);

    const targets = allResults.filter((r) => r.meets);
    if (targets.length) {
      printTable("★ TARGET MET (1000%+ & 80%+ WR)", targets, 50);
    } else {
      console.log("\n⚠ No config met 1000%+ return AND 80%+ WR in coarse phase.");
    }
  }

  // ── Phase 2: deep optimize top strategies ──
  if (phase === "all" || phase === "deep") {
    const coarseTop = [...allResults].sort((a, b) => b.score - a.score);
    const topStrats =
      onlyStrategy != null
        ? [onlyStrategy]
        : [...new Set(coarseTop.slice(0, TURBO ? 5 : 8).map((r) => r.strategy))];

    if (!topStrats.length) {
      topStrats.push(
        "HTF_RSI",
        "TREND_HTF_ST",
        "HTF_LEG_RIDER",
        "RSI_MEAN",
        "CONFLUENCE",
        "SUPERTREND",
        "TREND_PULLBACK",
        "SMART_REVERSAL"
      );
    }

    console.log(`\nPhase 2: deep grid for: ${topStrats.join(", ")}`);
    const deepResults = [];

    for (const strategyKey of topStrats) {
      const grid = [...deepGrid(strategyKey, null)];
      let best = null;
      let done = 0;
      for (const c of grid) {
        const candles = candleCache.get(c.tf);
        if (!candles?.length) continue;
        try {
          const r = await evaluateOne(c, candles, fromMs);
          const row = rowFromResult(r);
          deepResults.push(row);
          if (!best || row.score > best.score) best = row;
        } catch {
          /* skip */
        }
        done++;
      }
      if (best) {
        const sltp = best.trail ? "trail" : `${(best.sl * 100).toFixed(1)}/${(best.tp * 100).toFixed(1)}`;
        console.log(
          `  ${strategyKey.padEnd(18)} BEST: ${best.tf} ret=${best.ret.toFixed(1)}% WR=${best.wr.toFixed(1)}% n=${best.n} risk=${best.riskPct}% lev=${best.lev}x ${sltp}`
        );
      }
    }

    const deepTop = deepResults.sort((a, b) => b.score - a.score);
    printTable("TOP AFTER DEEP OPTIMIZE", deepTop);

    const wrLeaders = [...deepResults].filter((r) => r.n >= 10).sort((a, b) => b.wr - a.wr || b.ret - a.ret);
    printTable("HIGHEST WIN RATE (≥10 trades)", wrLeaders);

    const retLeaders = [...deepResults].filter((r) => r.n >= 10).sort((a, b) => b.ret - a.ret);
    printTable("HIGHEST RETURN (≥10 trades)", retLeaders);

    allResults.push(...deepResults);
  }

  // ── Phase 3: combo strategies ──
  if (phase === "all" || phase === "combo") {
    console.log(`\nPhase 3: combo strategies (${COMBO_DEFS.length} combos × TFs × SL/TP)`);
    const comboResults = [];
    const comboSlTp = SL_TP_COARSE.filter((r) => !r.trail).slice(0, 6);

    for (const combo of COMBO_DEFS) {
      for (const tf of ["15m", "1h"]) {
        const candles = candleCache.get(tf);
        if (!candles?.length) continue;
        for (const risk of comboSlTp) {
          const cfg = baseCfg({
            supertrendFuturesFixedSlPct: risk.sl,
            supertrendFuturesFixedTpPct: risk.tp,
            riskPerTrade: 5,
            futuresLeverage: 15,
          });
          try {
            const { metrics } = await runCombo({
              comboKey: combo.key,
              keys: combo.keys,
              minAgree: combo.min,
              tf,
              cfg,
              candles,
              fromMs,
            });
            const ret = metrics.totalReturnPct ?? 0;
            const wr = (metrics.winRate ?? 0) * 100;
            const n = metrics.totalTrades ?? 0;
            comboResults.push({
              strategy: combo.key,
              tf,
              sl: risk.sl,
              tp: risk.tp,
              ret,
              wr,
              n,
              pf: metrics.profitFactor ?? 0,
              dd: metrics.maxDrawdownPct ?? 0,
              score: targetScore(metrics),
              meets: ret >= 1000 && wr >= 80,
              riskPct: 5,
              lev: 15,
            });
          } catch {
            /* skip */
          }
        }
      }
    }

    const comboTop = comboResults.sort((a, b) => b.score - a.score);
    printTable("TOP COMBOS", comboTop);
    allResults.push(...comboResults);
  }

  // ── Final summary ──
  const final = [...allResults].sort((a, b) => b.score - a.score);
  const targetHits = final.filter((r) => r.meets);

  console.log("\n═══════════════════════════════════════════════════════════");
  console.log("FINAL SUMMARY — BTCUSDT");
  console.log("═══════════════════════════════════════════════════════════");

  if (targetHits.length) {
    console.log(`\n★ ${targetHits.length} configuration(s) met 1000%+ return AND 80%+ WR:`);
    for (const r of targetHits.slice(0, 10)) {
      console.log(`  ${r.strategy} ${r.tf} ret=${r.ret.toFixed(1)}% WR=${r.wr.toFixed(1)}% n=${r.n}`);
    }
  } else {
    const best = final[0];
    const bestWr = [...final].filter((r) => r.n >= 8).sort((a, b) => b.wr - a.wr)[0];
    const bestRet = [...final].filter((r) => r.n >= 8).sort((a, b) => b.ret - a.ret)[0];
    console.log("\n⚠ TARGET NOT ACHIEVED on realistic simulation (RISK_AT_SL, fees, slippage).");
    if (best) {
      console.log(`  Best composite: ${best.strategy} ${best.tf} → ${best.ret.toFixed(1)}% return, ${best.wr.toFixed(1)}% WR (${best.n} trades)`);
    }
    if (bestWr) {
      console.log(`  Best win rate:  ${bestWr.strategy} ${bestWr.tf} → ${bestWr.wr.toFixed(1)}% WR, ${bestWr.ret.toFixed(1)}% return (${bestWr.n} trades)`);
    }
    if (bestRet) {
      console.log(`  Best return:    ${bestRet.strategy} ${bestRet.tf} → ${bestRet.ret.toFixed(1)}% return, ${bestRet.wr.toFixed(1)}% WR (${bestRet.n} trades)`);
    }
    console.log("\n  Note: 1000%+ with 80%+ WR typically requires either very few trades (lucky streak),");
    console.log("  unrealistic sizing (FULL_EQUITY), or curve-fitting — not reliable for live trading.");
  }

  await closePool?.();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
