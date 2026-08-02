#!/usr/bin/env node
/**
 * Rerun production 5m + 1m liq portfolio sim on max force_orders archive.
 * Expects production presets: minRr=0, tpRr=1 (1R TP).
 *
 * Usage (backend/):
 *   node scripts/research-liq-cascade-prod-1rr-rerun.mjs
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

const presetMod = await import("../src/strategy/presets/liqCascadeOptimized.js");
const SETUPS = {
  production_5m: {
    portfolio: presetMod.LIQ_CASCADE_PORTFOLIO_1M,
    bySym: {
      BTCUSDT: presetMod.LIQ_CASCADE_BTC_1M,
      ETHUSDT: presetMod.LIQ_CASCADE_ETH_1M,
      BNBUSDT: presetMod.LIQ_CASCADE_BNB_1M,
    },
  },
  production_1m: {
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

const padFrom = liqCascadePadFromMs(fromMs, TF);
const cost = { leverage: 10, openFeeRate: FEE, closeFeeRate: FEE, slippagePct: SLIPPAGE };

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
  const pnlByExit = { tp: 0, sl: 0, flip: 0, other: 0 };
  for (const t of replay.trades) {
    const r = String(t.exitReason ?? "other").toLowerCase();
    if (r.includes("tp")) pnlByExit.tp++;
    else if (r.includes("sl")) pnlByExit.sl++;
    else if (r.includes("flip")) pnlByExit.flip++;
    else pnlByExit.other++;
  }

  return {
    perCoin,
    portfolio: {
      startingUsdt: START,
      finalEquityUsdt: +Number(replay.finalEquity).toFixed(4),
      netPnlUsdt: +net.toFixed(4),
      returnPct: +(((replay.finalEquity - START) / START) * 100).toFixed(4),
      trades: replay.trades.length,
      tradesPerDay: +((replay.trades.length / ((toMs - fromMs) / 86400000)).toFixed(2)),
      winRate: replay.trades.length ? +(wins / replay.trades.length).toFixed(4) : 0,
      profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(4) : grossWin > 0 ? 999 : 0,
      pnlByExit,
      tradesDetail: replay.trades.slice(0, 20).map((t) => ({
        symbol: t.symbol,
        side: t.side,
        entry: new Date(t.entryTs).toISOString(),
        exit: new Date(t.exitTs).toISOString(),
        netPnl: +Number(t.netPnl).toFixed(4),
        exitReason: t.exitReason,
      })),
    },
  };
}

const results = {};
for (const [key, setup] of Object.entries(SETUPS)) {
  const opts = optsFromLiqCascadeCfg(
    await hydrateLiqCascadeCfg({ ...setup.portfolio, liqCascadeLiqSource: "force_orders" }, "BTCUSDT", fromMs, toMs),
  );
  const sim = await runPortfolioSim(setup);
  results[key] = {
    label: `${key}_liq`,
    presetSummary: {
      liqInterval: opts.liqInterval,
      zMin: opts.liqZScoreMin,
      minLiqUsdBar: opts.minLiqUsdBar,
      minDispAtr: opts.minDispAtrMult,
      oiGateMode: opts.oiGateMode,
      minRr: opts.minRr,
      tpRr: opts.tpRr,
      tpAtrMult: opts.tpAtrMult,
      confirmLiqBars: opts.confirmLiqBars,
    },
    ...sim,
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  window: {
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    hours: +((toMs - fromMs) / 3600000).toFixed(2),
    days: +((toMs - fromMs) / 86400000).toFixed(2),
  },
  costs: { slippagePct: SLIPPAGE, feePerSide: FEE, leverage: 10 },
  bracketChange: "minRr=0, tpRr=1 (TP distance = SL distance)",
  results,
};

const outJson = path.join(__dirname, ".liq-cascade-prod-1rr-rerun.json");
fs.writeFileSync(outJson, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ window: report.window, production_5m: results.production_5m.portfolio, production_1m: results.production_1m.portfolio }, null, 2));
await closePool?.();
