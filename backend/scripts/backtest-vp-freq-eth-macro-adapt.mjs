#!/usr/bin/env node
/**
 * ETH VP FREQ — baseline vs macro-adaptive SELL HTF.
 *
 * Hypothesis: 2023–24 shorts lost because shallow 1h HTF-down flips fired inside a
 * bullish macro (pullback traps). Require stronger HTF sep for SELL when macro is
 * bullish; keep soft sep in genuine downtrends so 2025–26 shorts survive.
 *
 * Usage (from backend/):
 *   node scripts/backtest-vp-freq-eth-macro-adapt.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2023-06-01";
const TO = process.env.TO || "2026-05-31";
const TF = "15m";
const SYMBOL = "ETHUSDT";
const RISK = 2.5;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildVolumeProfileBacktestAdapter } = await import("../src/strategy/volumeProfileStrategy.js");
const {
  VOLUME_PROFILE_FREQ_ETH_15M,
  volumeProfilePadFromMs,
} = await import("../src/strategy/presets/volumeProfileOptimized.js");

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

function yearBucket(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  return m >= 5 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}

function summarizeByYear(trades) {
  const years = {};
  let eq = 100;
  for (const t of trades) {
    if (String(t.exitReason ?? "") === "tp1_partial") continue;
    const y = yearBucket(Number(t.entryTs ?? t.entry_time));
    if (!years[y]) years[y] = { n: 0, wins: 0, net: 0, start: eq, sells: 0 };
    const pnl = Number(t.netPnl ?? 0);
    years[y].n += 1;
    years[y].net += pnl;
    if (pnl > 0) years[y].wins += 1;
    if (String(t.direction ?? t.side).toUpperCase() === "SELL") years[y].sells += 1;
    eq += pnl;
    years[y].end = eq;
  }
  for (const y of Object.keys(years)) {
    const r = years[y];
    r.wr = r.n ? (r.wins / r.n) * 100 : 0;
    r.retPct = r.start ? ((r.end - r.start) / r.start) * 100 : 0;
  }
  return years;
}

async function runCfg(label, patch) {
  // Skip fillVolumeProfileFreqDefaults — it would re-apply ETH preset and erase the experiment patch.
  const cfg = {
    ...VOLUME_PROFILE_FREQ_ETH_15M,
    ...patch,
    symbol: SYMBOL,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "VOLUME_PROFILE",
    riskPerTrade: RISK,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    backtestSignalStartMs: fromMs,
  };
  const padFrom = volumeProfilePadFromMs(fromMs, TF, cfg);
  if (process.env.ENSURE_KLINES === "1") {
    try {
      await ensureKlines(SYMBOL, TF, { from: padFrom, to: toMs, market: "futures" });
    } catch (err) {
      console.warn(`[macro-adapt] ensureKlines skipped: ${err?.message || err}`);
    }
  }
  const candles = await readCandles(SYMBOL, TF, padFrom, toMs, { market: "futures" });
  if (!candles.length) throw new Error(`no_candles ${SYMBOL} ${TF}`);
  const adapters = {
    VOLUME_PROFILE: buildVolumeProfileBacktestAdapter(candles, cfg, TF),
  };
  const sim = await runSimulation({
    strategyKey: "VOLUME_PROFILE",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    symbol: SYMBOL,
    adapters,
  });
  const metrics = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 100,
  });
  const years = summarizeByYear(sim.trades);
  return {
    label,
    n: metrics.totalTrades,
    ret: metrics.totalReturnPct,
    dd: metrics.maxDrawdownPct,
    wr: metrics.winRate,
    pf: metrics.profitFactor,
    adapt: cfg.vpSellMacroAdapt === true,
    sellMin: cfg.vpSellMinHtfSepPct,
    sellBullMin: cfg.vpSellMacroBullMinHtfSepPct,
    years,
  };
}

// Pre-adapt ETH FREQ: same soft HTF for BUY and SELL (0.15%).
const baseline = await runCfg("baseline_symmetric_htf", {
  vpSellMacroAdapt: false,
  vpSellMinHtfSepPct: 0.0015,
  vpSellMacroBullMinHtfSepPct: 0,
  vpSellBreakdownMinHtfSep: 0,
});
const adapted = await runCfg("macro_adapt_sell", {
  vpSellMacroAdapt: true,
  vpSellMinHtfSepPct: 0.0025,
  vpSellMacroBullMinHtfSepPct: 0.005,
  vpSellMacroPrior20dBullPct: 0.02,
});

const out = { from: FROM, to: TO, baseline, adapted };
const outPath = path.resolve(__dirname, ".vp-freq-eth-macro-adapt.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log("wrote", outPath);

await closePool?.();
