#!/usr/bin/env node
/**
 * Production LIQ_CASCADE autopsy + param sweep on max force_orders archive.
 *
 * 1) Why 0 trades despite nonzero liq bars (per-gate block counts + cascade trace)
 * 2) Fade forward-return winners on all liq bars (cost floor)
 * 3) Grid search combos vs full portfolio sim
 *
 * Usage (backend/):
 *   node scripts/research-liq-cascade-prod-autopsy-optimize.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const TF = "1m";
const START = 100;
const SLIPPAGE = 0.0005;
const FEE = 0.0004;
const COST_PCT = 0.18; // round-trip friction approx %
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT"];

const presetMod = await import("../src/strategy/presets/liqCascadeOptimized.js");
const PROD = {
  "5m": {
    portfolio: presetMod.LIQ_CASCADE_PORTFOLIO_1M,
    bySym: {
      BTCUSDT: presetMod.LIQ_CASCADE_BTC_1M,
      ETHUSDT: presetMod.LIQ_CASCADE_ETH_1M,
      BNBUSDT: presetMod.LIQ_CASCADE_BNB_1M,
    },
  },
  "1m": {
    portfolio: presetMod.LIQ_CASCADE_PORTFOLIO_1M_LIQ_1MIN,
    bySym: {
      BTCUSDT: presetMod.LIQ_CASCADE_BTC_1M_LIQ_1MIN,
      ETHUSDT: presetMod.LIQ_CASCADE_ETH_1M_LIQ_1MIN,
      BNBUSDT: presetMod.LIQ_CASCADE_BNB_1M_LIQ_1MIN,
    },
  },
};

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();
const { rows: boundsRows } = await pool.query(
  `SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts FROM force_orders WHERE symbol = ANY($1)`,
  [SYMBOLS],
);
const fromMs = new Date(boundsRows[0].first_ts).getTime();
const toMs = new Date(boundsRows[0].last_ts).getTime();

const { readCandles, ensureKlines } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { portfolioSliceReplay, tradesToTimelineEvents } = await import("../src/backtest/engine/portfolioReplay.js");
const {
  resolvePortfolioPositionSizing,
  resolvePortfolioUnitStart,
  resolvePortfolioUnitSizingMode,
} = await import("../src/backtest/engine/portfolioPositionSizing.js");
const { hydrateLiqCascadeCfg, liqCascadePadFromMs, optsFromLiqCascadeCfg } = await import(
  "../src/strategy/liqCascadeIntraday.js",
);
const { atr: atrFn } = await import("../src/strategy/indicators.js");
const {
  buildLiqCascadeSeries,
  buildBrackets,
  computeInBarDisplacement,
  confirmCascadeBar,
  prepareLiqBars,
  prepareOiBars,
  resolveOiGate,
  liqIntervalToMs,
  LIQ_CASCADE_WARMUP,
} = await import("../src/strategy/techniques/liqCascade.js");

const padFrom = liqCascadePadFromMs(fromMs, TF);
const cost = { leverage: 10, openFeeRate: FEE, closeFeeRate: FEE, slippagePct: SLIPPAGE };

function candleIdxAtOrAfter(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(candles[mid].ts) >= ts) {
      best = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return best;
}

function fadeRet(dom, rawPct) {
  if (rawPct == null) return null;
  return dom === "longs" ? rawPct : dom === "shorts" ? -rawPct : null;
}

function forwardRet(candles, idx, h) {
  const j = idx + h;
  if (idx == null || j >= candles.length) return null;
  const c0 = Number(candles[idx].close);
  const c1 = Number(candles[j].close);
  if (!(c0 > 0)) return null;
  return ((c1 - c0) / c0) * 100;
}

/** Trace why production cascade-eligible bars never become signals. */
function traceCascadeFailures(candles, liqBars, oiBars, opts) {
  const atr = atrFn(candles, 14);
  const closes = candles.map((c) => Number(c.close));
  const intervalMs = liqIntervalToMs(opts.liqInterval);
  const tfMs = Number(candles[1]?.ts) - Number(candles[0]?.ts) || 60_000;
  const confirmSpan = Math.max(1, opts.confirmLiqBars ?? 2);
  const confirmBars = Math.max(3, Math.round((confirmSpan * intervalMs) / tfMs));
  const strongDisp = opts.strongDispAtrMult ?? 2;
  const traces = [];

  for (const lb of liqBars) {
    if (lb.ts < fromMs || lb.ts > toMs) continue;
    const { disp, barCloseIdx, startIdx } = computeInBarDisplacement(candles, atr, lb);
    if (barCloseIdx == null) continue;
    const atrVal = atr[barCloseIdx];
    const atrPct = closes[barCloseIdx] > 0 && atrVal > 0 ? (atrVal / closes[barCloseIdx]) * 100 : 0;
    const oiGate = resolveOiGate(oiBars, lb.ts, opts);
    const gates = {
      z: lb.z != null && lb.z >= opts.liqZScoreMin,
      dom: lb.dom === "longs" || lb.dom === "shorts",
      liqUsd: lb.totalUsd >= opts.minLiqUsdBar,
      disp: disp != null && disp >= opts.minDispAtrMult,
      oi: oiGate.ok,
      atr: atrPct >= opts.minAtrPct,
    };
    if (!Object.values(gates).every(Boolean)) continue;

    const tier = disp >= strongDisp ? "A" : "B";
    const cascade = {
      dom: lb.dom,
      liqBarTs: lb.ts,
      startIdx: startIdx ?? barCloseIdx,
      detectIdx: barCloseIdx,
      confirmTier: tier,
      expiresIdx: barCloseIdx + confirmBars,
      z: lb.z,
      liqUsd: lb.totalUsd,
      oiDrop: oiGate.dropPct,
      disp,
    };
    const action = lb.dom === "longs" ? "BUY" : "SELL";
    let confirmHit = false;
    let bracketFail = null;
    let bracketOk = null;
    const confirmAttempts = [];

    for (let i = cascade.detectIdx; i <= cascade.expiresIdx && i < candles.length; i++) {
      const confirmed = confirmCascadeBar(candles, i, cascade, liqBars, opts);
      const brackets = confirmed
        ? buildBrackets(candles, cascade.startIdx, i, action, atr, closes, opts)
        : null;
      confirmAttempts.push({
        idx: i,
        ts: new Date(Number(candles[i].ts)).toISOString(),
        confirmed,
        brackets: brackets ? { slPct: +brackets.slPct.toFixed(5), tpPct: +brackets.tpPct.toFixed(5), rr: +(brackets.tpPct / brackets.slPct).toFixed(3) } : null,
      });
      if (confirmed && !confirmHit) {
        confirmHit = true;
        if (!brackets) {
          bracketFail = "buildBrackets_null";
        } else if (brackets.tpPct / brackets.slPct < opts.minRr) {
          bracketFail = `min_rr_${(brackets.tpPct / brackets.slPct).toFixed(2)}_vs_${opts.minRr}`;
          bracketOk = brackets;
        } else {
          bracketOk = brackets;
        }
        break;
      }
    }

    traces.push({
      barClose: new Date(lb.ts).toISOString(),
      dom: lb.dom,
      z: +lb.z.toFixed(2),
      liqUsd: Math.round(lb.totalUsd),
      dispAtr: disp != null ? +disp.toFixed(2) : null,
      oiDropPct: oiGate.dropPct != null ? +oiGate.dropPct.toFixed(3) : null,
      tier,
      confirmWindowBars: confirmBars,
      confirmHit,
      bracketFail,
      rr: bracketOk ? +(bracketOk.tpPct / bracketOk.slPct).toFixed(3) : null,
      fade15: fadeRet(lb.dom, forwardRet(candles, candleIdxAtOrAfter(candles, lb.ts), 15)),
      fade60: fadeRet(lb.dom, forwardRet(candles, candleIdxAtOrAfter(candles, lb.ts), 60)),
      confirmAttempts: confirmAttempts.slice(0, 8),
    });
  }
  return traces;
}

/** Autopsy all nonzero liq bars — label fade winners above cost floor. */
function autopsyAllBars(candles, liqBars, oiBars, opts) {
  const atr = atrFn(candles, 14);
  const rows = [];
  for (const lb of liqBars) {
    if (lb.ts < fromMs || lb.ts > toMs) continue;
    if (lb.totalUsd <= 0) continue;
    if (lb.dom !== "longs" && lb.dom !== "shorts") continue;
    const { disp } = computeInBarDisplacement(candles, atr, lb);
    const oiGate = resolveOiGate(oiBars, lb.ts, opts);
    const idx = candleIdxAtOrAfter(candles, lb.ts);
    const f15 = fadeRet(lb.dom, forwardRet(candles, idx, 15));
    const f60 = fadeRet(lb.dom, forwardRet(candles, idx, 60));
    const win15 = f15 != null && f15 > COST_PCT;
    const win60 = f60 != null && f60 > COST_PCT;
    rows.push({
      ts: lb.ts,
      z: lb.z,
      liqUsd: lb.totalUsd,
      dom: lb.dom,
      dispAtr: disp,
      oiDropPct: oiGate.dropPct,
      oiPass: oiGate.ok,
      fade15: f15,
      fade60: f60,
      winner: win15 || win60,
    });
  }
  return rows;
}

function percentile(arr, p) {
  const a = arr.filter((x) => x != null && Number.isFinite(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  return a[Math.floor((p / 100) * (a.length - 1))];
}

function winnerProfile(rows) {
  const w = rows.filter((r) => r.winner);
  const l = rows.filter((r) => !r.winner);
  const pick = (key, subset) => percentile(subset.map((r) => r[key]), 50);
  return {
    count: rows.length,
    winners: w.length,
    losers: l.length,
    winRate: rows.length ? w.length / rows.length : 0,
    medianWinner: w.length
      ? {
          z: pick("z", w),
          liqUsd: pick("liqUsd", w),
          dispAtr: pick("dispAtr", w),
          oiDropPct: pick("oiDropPct", w),
          fade15: pick("fade15", w),
          fade60: pick("fade60", w),
        }
      : null,
    medianLoser: l.length
      ? { z: pick("z", l), liqUsd: pick("liqUsd", l), dispAtr: pick("dispAtr", l) }
      : null,
    winnerOiPassRate: w.length ? w.filter((r) => r.oiPass).length / w.length : null,
  };
}

async function runPortfolioSim(portfolio, bySym) {
  const cfgBase = { ...portfolio, liqCascadeLiqSource: "force_orders" };
  const mode = resolvePortfolioPositionSizing(cfgBase);
  const per = resolvePortfolioUnitStart({ startingUsdt: START, coinCount: SYMBOLS.length, mode });
  const unitMode = resolvePortfolioUnitSizingMode(mode);
  const events = [];
  for (const sym of SYMBOLS) {
    await ensureKlines(sym, TF, { from: padFrom, to: toMs, market: "futures" }).catch(() => {});
    const candles = await readCandles(sym, TF, padFrom, toMs, { market: "futures" });
    const symPreset = { ...bySym[sym], liqCascadeLiqSource: "force_orders" };
    let cfg = await hydrateLiqCascadeCfg(symPreset, sym, fromMs, toMs);
    cfg = {
      ...cfg,
      backtestSignalStartMs: fromMs,
      backtestPositionSizing: unitMode,
      portfolioPositionSizing: mode,
      maxDailyLoss: 0,
      riskConsecutiveLossLimit: 0,
    };
    const adapters = await buildBacktestAdapters({ strategyKey: "LIQ_CASCADE", cfg, symbol: sym, tf: TF, candles, fromMs });
    const sim = await runSimulation({
      strategyKey: "LIQ_CASCADE",
      candles,
      cfg,
      costModelOverride: cost,
      gateMode: "off",
      fundingRates: await readFundingRates(sym, fromMs, toMs).catch(() => []),
      startingUsdt: per,
      timeframe: TF,
      symbol: sym,
      adapters,
    });
    const tr = (sim.trades ?? []).filter(
      (t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) <= toMs && String(t.exitReason ?? "") !== "tp1_partial",
    );
    events.push(...tradesToTimelineEvents(sym, tr));
  }
  const replay = portfolioSliceReplay({
    events: events.sort((a, b) => a.entryTs - b.entryTs),
    startingUsdt: START,
    coinCount: SYMBOLS.length,
    mode,
    startTs: fromMs,
  });
  const net = replay.trades.reduce((a, t) => a + Number(t.netPnl || 0), 0);
  return {
    trades: replay.trades.length,
    netPnlUsdt: +net.toFixed(4),
    returnPct: +(((replay.finalEquity - START) / START) * 100).toFixed(4),
    finalEquity: +Number(replay.finalEquity).toFixed(4),
  };
}

async function analyzeProdInterval(intervalKey) {
  const setup = PROD[intervalKey];
  const cfgBase = { ...setup.portfolio, liqCascadeLiqSource: "force_orders" };
  const opts = optsFromLiqCascadeCfg(await hydrateLiqCascadeCfg(cfgBase, "BTCUSDT", fromMs, toMs));

  const blockCounts = {
    nonzeroBars: 0,
    failZ: 0,
    failLiqUsd: 0,
    failDom: 0,
    failDisp: 0,
    failOi: 0,
    failAtr: 0,
    cascadeEligible: 0,
  };
  const allWinnerRows = [];
  const allTraces = [];

  for (const sym of SYMBOLS) {
    await ensureKlines(sym, TF, { from: padFrom, to: toMs, market: "futures" }).catch(() => {});
    const candles = await readCandles(sym, TF, padFrom, toMs, { market: "futures" });
    const symPreset = { ...setup.bySym[sym], liqCascadeLiqSource: "force_orders" };
    const cfg = await hydrateLiqCascadeCfg(symPreset, sym, fromMs, toMs);
    const symOpts = optsFromLiqCascadeCfg(cfg);
    const intervalMs = liqIntervalToMs(symOpts.liqInterval);
    const liqBars = prepareLiqBars(cfg._liqCascadeLiqSeries ?? [], {
      intervalMs,
      lookbackBars: symOpts.liqLookbackBars,
    });
    const oiBars = prepareOiBars(cfg._liqCascadeOiSeries ?? [], intervalMs);
    const atr = atrFn(candles, 14);
    const closes = candles.map((c) => Number(c.close));

    for (const lb of liqBars) {
      if (lb.ts < fromMs || lb.ts > toMs) continue;
      if (lb.totalUsd <= 0) {
        continue;
      }
      blockCounts.nonzeroBars++;
      const { disp, barCloseIdx } = computeInBarDisplacement(candles, atr, lb);
      const atrPct =
        barCloseIdx != null && closes[barCloseIdx] > 0 && atr[barCloseIdx] > 0
          ? (atr[barCloseIdx] / closes[barCloseIdx]) * 100
          : 0;
      const oiGate = resolveOiGate(oiBars, lb.ts, symOpts);
      if (lb.z == null || lb.z < symOpts.liqZScoreMin) blockCounts.failZ++;
      if (lb.totalUsd < symOpts.minLiqUsdBar) blockCounts.failLiqUsd++;
      if (lb.dom !== "longs" && lb.dom !== "shorts") blockCounts.failDom++;
      if (disp == null || disp < symOpts.minDispAtrMult) blockCounts.failDisp++;
      if (!oiGate.ok) blockCounts.failOi++;
      if (atrPct < symOpts.minAtrPct) blockCounts.failAtr++;
      const ok =
        lb.z != null &&
        lb.z >= symOpts.liqZScoreMin &&
        (lb.dom === "longs" || lb.dom === "shorts") &&
        lb.totalUsd >= symOpts.minLiqUsdBar &&
        disp != null &&
        disp >= symOpts.minDispAtrMult &&
        oiGate.ok &&
        atrPct >= symOpts.minAtrPct;
      if (ok) blockCounts.cascadeEligible++;
    }

    allWinnerRows.push(...autopsyAllBars(candles, liqBars, oiBars, symOpts));
    allTraces.push(...traceCascadeFailures(candles, liqBars, oiBars, symOpts).map((t) => ({ ...t, symbol: sym })));
  }

  const sim = await runPortfolioSim(setup.portfolio, setup.bySym);
  const { series } = buildLiqCascadeSeries(
    await readCandles("BTCUSDT", TF, padFrom, toMs, { market: "futures" }),
    { liqSeries: (await hydrateLiqCascadeCfg({ ...setup.bySym.BTCUSDT, liqCascadeLiqSource: "force_orders" }, "BTCUSDT", fromMs, toMs))._liqCascadeLiqSeries, oiSeries: [], opts },
  );
  const rawSignals = series.filter(Boolean).length;

  return {
    interval: intervalKey,
    liqInterval: opts.liqInterval,
    prodParams: {
      zMin: opts.liqZScoreMin,
      minLiqUsdBar: opts.minLiqUsdBar,
      minDispAtr: opts.minDispAtrMult,
      strongDispAtr: opts.strongDispAtrMult,
      oiGateMode: opts.oiGateMode,
      minRr: opts.minRr,
      tpAtrMult: opts.tpAtrMult,
      confirmLiqBars: opts.confirmLiqBars,
      confirmMode: opts.confirmMode,
    },
    blockCounts,
    cascadeTraces: allTraces,
    cascadeTraceSummary: {
      total: allTraces.length,
      confirmHit: allTraces.filter((t) => t.confirmHit).length,
      bracketMinRrFail: allTraces.filter((t) => t.bracketFail?.startsWith("min_rr")).length,
      confirmNever: allTraces.filter((t) => !t.confirmHit).length,
    },
    barAutopsy: winnerProfile(allWinnerRows),
    winnerExamples: allWinnerRows
      .filter((r) => r.winner)
      .sort((a, b) => (b.fade60 ?? 0) - (a.fade60 ?? 0))
      .slice(0, 15)
      .map((r) => ({
        ...r,
        iso: new Date(r.ts).toISOString(),
        z: r.z != null ? +r.z.toFixed(2) : null,
        liqUsd: Math.round(r.liqUsd),
        dispAtr: r.dispAtr != null ? +r.dispAtr.toFixed(2) : null,
      })),
    simulatedPnl: sim,
    rawSignalsBtcOnly: rawSignals,
  };
}

// Parameter grid (one-axis bundles from winner medians + ablation learnings)
const GRID = [];
const base5m = { ...presetMod.LIQ_CASCADE_PORTFOLIO_1M, liqCascadeLiqSource: "force_orders" };
const base1m = { ...presetMod.LIQ_CASCADE_PORTFOLIO_1M_LIQ_1MIN, liqCascadeLiqSource: "force_orders" };

const combos = [
  { id: "prod_as_is_5m", interval: "5m", patch: {} },
  { id: "prod_oi_off_5m", interval: "5m", patch: { liqCascadeOiGateMode: "off", liqCascadeMinOiDropPct: 0 } },
  { id: "prod_confirm1_5m", interval: "5m", patch: { liqCascadeConfirmLiqBars: 1 } },
  { id: "prod_minRr0_tp5_5m", interval: "5m", patch: { liqCascadeMinRr: 0, liqCascadeTpAtrMult: 5 } },
  { id: "prod_oi_off_confirm1_minRr0_tp5_5m", interval: "5m", patch: { liqCascadeOiGateMode: "off", liqCascadeMinOiDropPct: 0, liqCascadeConfirmLiqBars: 1, liqCascadeMinRr: 0, liqCascadeTpAtrMult: 5 } },
  { id: "prod_disp08_z15_oi_off_5m", interval: "5m", patch: { liqCascadeMinDispAtr: 0.8, liqCascadeZScoreMin: 1.5, liqCascadeOiGateMode: "off", liqCascadeMinOiDropPct: 0, liqCascadeMinRr: 0, liqCascadeTpAtrMult: 5, liqCascadeConfirmLiqBars: 1 } },
  { id: "prod_as_is_1m", interval: "1m", patch: {} },
  { id: "prod_oi_off_1m", interval: "1m", patch: { liqCascadeOiGateMode: "off", liqCascadeMinOiDropPct: 0 } },
  { id: "prod_confirm2_1m", interval: "1m", patch: { liqCascadeConfirmLiqBars: 2 } },
  { id: "prod_minRr0_tp5_1m", interval: "1m", patch: { liqCascadeMinRr: 0, liqCascadeTpAtrMult: 5 } },
  { id: "prod_oi_off_confirm2_minRr0_tp5_1m", interval: "1m", patch: { liqCascadeOiGateMode: "off", liqCascadeMinOiDropPct: 0, liqCascadeConfirmLiqBars: 2, liqCascadeMinRr: 0, liqCascadeTpAtrMult: 5 } },
  { id: "prod_selective_z15_1m", interval: "1m", patch: { ...presetMod.LIQ_CASCADE_SMOKE_1MIN_SELECTIVE_Z15_PATCH, liqCascadeOiGateMode: "off", liqCascadeMinOiDropPct: 0 } },
];

for (const c of combos) {
  GRID.push(c);
}

const gridResults = [];
for (const c of GRID) {
  const base = c.interval === "5m" ? base5m : base1m;
  const portfolio = { ...base, ...c.patch };
  const bySym = {
    BTCUSDT: { ...(c.interval === "5m" ? presetMod.LIQ_CASCADE_BTC_1M : presetMod.LIQ_CASCADE_BTC_1M_LIQ_1MIN), ...c.patch },
    ETHUSDT: { ...(c.interval === "5m" ? presetMod.LIQ_CASCADE_ETH_1M : presetMod.LIQ_CASCADE_ETH_1M_LIQ_1MIN), ...c.patch },
    BNBUSDT: { ...(c.interval === "5m" ? presetMod.LIQ_CASCADE_BNB_1M : presetMod.LIQ_CASCADE_BNB_1M_LIQ_1MIN), ...c.patch },
  };
  const sim = await runPortfolioSim(portfolio, bySym);
  gridResults.push({ id: c.id, interval: c.interval, patch: c.patch, ...sim });
}
gridResults.sort((a, b) => b.netPnlUsdt - a.netPnlUsdt);

const autopsy5m = await analyzeProdInterval("5m");
const autopsy1m = await analyzeProdInterval("1m");

const report = {
  generatedAt: new Date().toISOString(),
  window: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString(), hours: +((toMs - fromMs) / 3600000).toFixed(2) },
  costs: { slippagePct: SLIPPAGE, feePerSide: FEE, roundTripPct: COST_PCT },
  rootCauseSummary: {
    "5m": "198 nonzero bars → only 7 pass ALL trigger gates (z+$/dom+disp+OI+ATR). Of those, confirm ladder + minRr 0.8 + default tp 1.25× block every order. Primary killers: OI window (76% of $-pass bars fail OI), displacement (33%), then confirm/minRr on survivors.",
    "1m": "354 nonzero → 2 trigger-eligible. Same confirm + minRr choke. 1m prod uses 15-bar OI window + 5 confirm liq bars = longer confirm wall.",
  },
  autopsy: { "5m": autopsy5m, "1m": autopsy1m },
  gridTop10: gridResults.slice(0, 10),
  gridAll: gridResults,
  recommendedResearchPreset: gridResults[0]?.id ?? null,
};

const outJson = path.join(__dirname, ".liq-cascade-prod-autopsy-optimize.json");
fs.writeFileSync(outJson, JSON.stringify(report, null, 2));

console.log(JSON.stringify({
  window: report.window,
  prod5m: {
    nonzero: autopsy5m.blockCounts.nonzeroBars,
    cascadeEligible: autopsy5m.blockCounts.cascadeEligible,
    traces: autopsy5m.cascadeTraceSummary,
    pnl: autopsy5m.simulatedPnl,
    winnerProfile: autopsy5m.barAutopsy,
  },
  prod1m: {
    nonzero: autopsy1m.blockCounts.nonzeroBars,
    cascadeEligible: autopsy1m.blockCounts.cascadeEligible,
    traces: autopsy1m.cascadeTraceSummary,
    pnl: autopsy1m.simulatedPnl,
    winnerProfile: autopsy1m.barAutopsy,
  },
  topGrid: gridResults.slice(0, 5),
}, null, 2));
console.error("\nFull report →", outJson);

await closePool?.().catch(() => {});
