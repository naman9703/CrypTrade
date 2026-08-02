#!/usr/bin/env node
/**
 * ETH 7/29 cascade cluster autopsy + prod 5m rerun after fixes:
 * - eventCooldownLiqBars (one-shot per cascade)
 * - OI off, tp 5×, minRr 0
 *
 * Usage (backend/):
 *   node scripts/research-liq-cascade-eth-cluster-autopsy.mjs
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
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "BNBUSDT"];
const CLUSTER_FROM = Date.parse("2026-07-29T03:00:00.000Z");
const CLUSTER_TO = Date.parse("2026-07-29T05:00:00.000Z");

const presetMod = await import("../src/strategy/presets/liqCascadeOptimized.js");
const PROD_5M = {
  portfolio: presetMod.LIQ_CASCADE_PORTFOLIO_1M,
  bySym: {
    BTCUSDT: presetMod.LIQ_CASCADE_BTC_1M,
    ETHUSDT: presetMod.LIQ_CASCADE_ETH_1M,
    BNBUSDT: presetMod.LIQ_CASCADE_BNB_1M,
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
const {
  buildLiqCascadeSeries,
  prepareLiqBars,
  liqIntervalToMs,
  LIQ_CASCADE_WARMUP,
} = await import("../src/strategy/techniques/liqCascade.js");

const padFrom = liqCascadePadFromMs(fromMs, TF);
const cost = { leverage: 10, openFeeRate: FEE, closeFeeRate: FEE, slippagePct: SLIPPAGE };

async function autopsyEthCluster() {
  const sym = "ETHUSDT";
  await ensureKlines(sym, TF, { from: padFrom, to: toMs, market: "futures" }).catch(() => {});
  const candles = await readCandles(sym, TF, padFrom, toMs, { market: "futures" });
  const cfg = await hydrateLiqCascadeCfg(
    { ...PROD_5M.bySym[sym], liqCascadeLiqSource: "force_orders" },
    sym,
    CLUSTER_FROM,
    CLUSTER_TO,
  );
  const opts = optsFromLiqCascadeCfg(cfg);
  const intervalMs = liqIntervalToMs(opts.liqInterval);
  const liqBars = prepareLiqBars(cfg._liqCascadeLiqSeries ?? [], {
    intervalMs,
    lookbackBars: opts.liqLookbackBars,
  });
  const { series } = buildLiqCascadeSeries(candles, {
    liqSeries: cfg._liqCascadeLiqSeries ?? [],
    oiSeries: cfg._liqCascadeOiSeries ?? [],
    opts,
  });

  const clusterLiq = liqBars.filter((b) => b.ts >= CLUSTER_FROM && b.ts <= CLUSTER_TO && b.totalUsd > 0);
  const clusterSignals = [];
  for (let i = LIQ_CASCADE_WARMUP; i < series.length; i++) {
    const sig = series[i];
    if (!sig) continue;
    const ts = Number(candles[i].ts);
    if (ts < CLUSTER_FROM || ts > CLUSTER_TO) continue;
    clusterSignals.push({
      barClose: new Date(ts).toISOString(),
      action: sig.action,
      dom: sig.reason?.includes("longs") ? "longs" : sig.reason?.includes("shorts") ? "shorts" : "?",
      z: sig.liqZ,
      liqUsd: sig.liqUsd,
      dispAtr: sig.dispAtr,
      confirmTier: sig.confirmTier,
      slPct: sig.liqBrackets?.slPct != null ? +sig.liqBrackets.slPct.toFixed(5) : null,
      tpPct: sig.liqBrackets?.tpPct != null ? +sig.liqBrackets.tpPct.toFixed(5) : null,
      rr: sig.liqBrackets ? +(sig.liqBrackets.tpPct / sig.liqBrackets.slPct).toFixed(3) : null,
    });
  }

  const liqTimeline = clusterLiq.map((b) => ({
    barClose: new Date(b.ts).toISOString(),
    dom: b.dom,
    z: b.z != null ? +b.z.toFixed(2) : null,
    liqUsd: Math.round(b.totalUsd),
    longUsd: Math.round(b.liqLongUsd),
    shortUsd: Math.round(b.liqShortUsd),
  }));

  return {
    hypothesis:
      "7/29 03:21–04:06 ETH churn = multiple liq bars each firing fade signals; flip at 03:30 = opposite-dom cascade while still long from prior TP.",
    prodParams: {
      oiGateMode: opts.oiGateMode,
      eventCooldownLiqBars: opts.eventCooldownLiqBars,
      tpAtrMult: opts.tpAtrMult,
      tpRr: opts.tpRr,
      minRr: opts.minRr,
    },
    liqBarsInWindow: liqTimeline,
    signalsWithNewPreset: clusterSignals,
    signalCount: clusterSignals.length,
    priorBadRun: {
      trades: 8,
      netPnlUsdt: -4.98,
      note: "1 TP then flip + 3 SLs in 45min — same cascade unwind treated as independent events",
    },
  };
}

async function runPortfolioSim(setup) {
  const cfgBase = { ...setup.portfolio, liqCascadeLiqSource: "force_orders" };
  const mode = resolvePortfolioPositionSizing(cfgBase);
  const per = resolvePortfolioUnitStart({ startingUsdt: START, coinCount: SYMBOLS.length, mode });
  const unitMode = resolvePortfolioUnitSizingMode(mode);
  const events = [];
  const perCoin = [];

  for (const sym of SYMBOLS) {
    await ensureKlines(sym, TF, { from: padFrom, to: toMs, market: "futures" }).catch(() => {});
    const candles = await readCandles(sym, TF, padFrom, toMs, { market: "futures" });
    const symPreset = { ...setup.bySym[sym], liqCascadeLiqSource: "force_orders" };
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
    const net = tr.reduce((a, t) => a + Number(t.netPnl || 0), 0);
    perCoin.push({
      symbol: sym,
      trades: tr.length,
      netPnlUsdt: +net.toFixed(4),
      wins: tr.filter((t) => Number(t.netPnl) > 0).length,
      exits: tr.reduce((acc, t) => {
        const r = String(t.exitReason ?? "other");
        acc[r] = (acc[r] ?? 0) + 1;
        return acc;
      }, {}),
    });
  }

  const replay = portfolioSliceReplay({
    events: events.sort((a, b) => a.entryTs - b.entryTs),
    startingUsdt: START,
    coinCount: SYMBOLS.length,
    mode,
    startTs: fromMs,
  });
  const net = replay.trades.reduce((a, t) => a + Number(t.netPnl || 0), 0);
  const wins = replay.trades.filter((t) => Number(t.netPnl) > 0).length;
  const grossWin = replay.trades.filter((t) => Number(t.netPnl) > 0).reduce((a, t) => a + Number(t.netPnl), 0);
  const grossLoss = Math.abs(replay.trades.filter((t) => Number(t.netPnl) < 0).reduce((a, t) => a + Number(t.netPnl), 0));

  return {
    perCoin,
    portfolio: {
      netPnlUsdt: +net.toFixed(4),
      returnPct: +(((replay.finalEquity - START) / START) * 100).toFixed(4),
      trades: replay.trades.length,
      tradesPerDay: +((replay.trades.length / ((toMs - fromMs) / 86400000)).toFixed(2)),
      winRate: replay.trades.length ? +(wins / replay.trades.length).toFixed(4) : 0,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(4) : grossWin > 0 ? 999 : 0,
      tradesDetail: replay.trades.map((t) => ({
        symbol: t.symbol,
        entry: new Date(t.entryTs).toISOString(),
        exit: new Date(t.exitTs).toISOString(),
        side: t.side,
        netPnl: +Number(t.netPnl).toFixed(4),
        exitReason: t.exitReason,
      })),
    },
  };
}

const ethAutopsy = await autopsyEthCluster();
const prod5m = await runPortfolioSim(PROD_5M);
const opts = optsFromLiqCascadeCfg(
  await hydrateLiqCascadeCfg({ ...PROD_5M.portfolio, liqCascadeLiqSource: "force_orders" }, "BTCUSDT", fromMs, toMs),
);

const report = {
  generatedAt: new Date().toISOString(),
  window: {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    hours: +((toMs - fromMs) / 3600000).toFixed(2),
  },
  changes: [
    "liqCascadeEventCooldownLiqBars: 12 (one trade per cascade cluster, 1h on 5m liq)",
    "liqCascadeOiGateMode: off",
    "liqCascadeTpAtrMult: 5, tpRr: 0, minRr: 0",
  ],
  presetSummary: {
    oiGateMode: opts.oiGateMode,
    eventCooldownLiqBars: opts.eventCooldownLiqBars,
    tpAtrMult: opts.tpAtrMult,
    tpRr: opts.tpRr,
    minRr: opts.minRr,
  },
  ethClusterAutopsy: ethAutopsy,
  production_5m: prod5m,
  comparePrior: {
    prior1R: { trades: 8, netPnlUsdt: -4.98, winRate: 0.25, profitFactor: 0.15 },
    prior0Trade: { trades: 0, netPnlUsdt: 0 },
  },
};

const outJson = path.join(__dirname, ".liq-cascade-prod-fix-rerun.json");
fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
console.log(
  JSON.stringify(
    {
      ethClusterSignals: ethAutopsy.signalCount,
      prod5m: prod5m.portfolio,
      perCoin: prod5m.perCoin,
    },
    null,
    2,
  ),
);
await closePool?.();
