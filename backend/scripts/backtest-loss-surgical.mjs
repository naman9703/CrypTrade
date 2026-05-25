#!/usr/bin/env node
/**
 * Per-trade loss autopsy + surgical filter sweep.
 * Blocks only entry flags that correlate with losses, not half the book.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const {
  evaluateTrendHtfStRegime,
  classifyTrendHtfStTradeOutcome,
} = await import("../src/strategy/trendHtfStRegime.js");

/** Matches user high-return Jan runs (ffdeeebb): 10% risk, 30x, TP 3%, regime OFF. */
const {
  TREND_HTF_ST_BNB_MAX_PRESET,
  TREND_HTF_ST_BNB_SURGICAL_PRESET,
  TREND_HTF_ST_BNB_WHIPSAW_GUARD_PRESET,
  TREND_HTF_ST_BNB_CHOP_SAFE_PRESET,
  TREND_HTF_ST_BNB_AGGRESSIVE_PRESET,
} = await import("../src/strategy/presets/trendHtfStOptimized.js");

const USER_CFG = {
  marketMode: "FUTURES",
  futuresLeverage: 30,
  backtestPositionSizing: "RISK_AT_SL",
  strategyMode: "MANUAL",
  manualStrategy: "TREND_HTF_ST",
  trailingStopLossAuto: false,
  slippagePct: 0.0005,
  tradeHistoryTakerOpenFeeRate: 0.0005,
  tradeHistoryTakerCloseFeeRate: 0.0005,
  riskPerTrade: 10,
  riskPerTradeUnit: "PCT_EQUITY",
  supertrendPeriod: 10,
  supertrendMultiplier: 2.5,
  supertrendFuturesFixedSlPct: 0.012,
  supertrendFuturesFixedTpPct: 0.03,
  trendHtfStRegimeGate: false,
  trendHtfStMaxEntryRangeAtr: 2,
};

const WINDOWS = [
  ["Jan26", "2026-01-01", "2026-05-19"],
  ["H2", "2025-06-01", "2025-12-31"],
  ["1yr", "2025-06-01", "2026-05-19"],
];

function findBarIdx(candles, entryTime) {
  const t = new Date(entryTime).getTime();
  let i = candles.findIndex((c) => c.ts >= t);
  return Math.max(0, i - 1);
}

async function runWindow(from, to, surgicalFilter) {
  const fromMs = new Date(from).getTime();
  const candles = await readCandles("BNBUSDT", "15m", fromMs, new Date(to).getTime());
  const full = { ...USER_CFG };

  let adapters = await buildBacktestAdapters({
    strategyKey: "TREND_HTF_ST",
    cfg: full,
    symbol: "BNBUSDT",
    tf: "15m",
    candles,
    fromMs,
  });

  if (surgicalFilter) {
    const base = adapters.TREND_HTF_ST;
    adapters = {
      ...adapters,
      TREND_HTF_ST: async (bar, idx, ctx) => {
        const sig = await base(bar, idx, ctx);
        if (!sig) return null;
        const r = evaluateTrendHtfStRegime(candles, idx, sig.action, full);
        if (r && surgicalFilter(r)) return null;
        return sig;
      },
    };
  }

  const sim = await runSimulation({
    strategyKey: "TREND_HTF_ST",
    candles,
    cfg: full,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: "15m",
    adapters,
    symbol: "BNBUSDT",
  });

  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: "15m",
    startingEquity: 100,
  });

  const enriched = sim.trades.map((t) => {
    const i = findBarIdx(candles, t.entryTime);
    const dir = t.direction || t.side;
    const regime = evaluateTrendHtfStRegime(candles, i, dir, full);
    return {
      t,
      regime,
      pattern: classifyTrendHtfStTradeOutcome(t),
    };
  });

  return { m, enriched };
}

function printAutopsy(enriched, label) {
  const losses = enriched.filter((e) => e.t.netPnl <= 0);
  const wins = enriched.filter((e) => e.t.netPnl > 0);
  console.log(`\n── ${label}: ${wins.length}W / ${losses.length}L ──`);

  const flags = [
    "HTF_EMA_CROSS_RECENT",
    "HTF_SEP_SHRINKING",
    "REGIME_SIDEWAYS",
    "ST_WHIPSAW",
    "HTF_SEP_LOW",
    "STRONG_TREND_BYPASS",
  ];
  for (const f of flags) {
    const lHit = losses.filter((e) => e.regime?.flags?.includes(f)).length;
    const wHit = wins.filter((e) => e.regime?.flags?.includes(f)).length;
    if (lHit + wHit === 0) continue;
    const lPct = losses.length ? ((lHit / losses.length) * 100).toFixed(0) : "0";
    const wPct = wins.length ? ((wHit / wins.length) * 100).toFixed(0) : "0";
    console.log(
      `  ${f.padEnd(22)} L:${lHit}/${losses.length} (${lPct}%)  W:${wHit}/${wins.length} (${wPct}%)  precision=${lHit + wHit > 0 ? ((lHit / (lHit + wHit)) * 100).toFixed(0) : 0}%`,
    );
  }

  const patterns = {};
  for (const e of losses) patterns[e.pattern] = (patterns[e.pattern] || 0) + 1;
  console.log("  Loss patterns:", patterns);

  for (const e of losses.slice(0, 5)) {
    const t = e.t;
    console.log(
      `  #${t.tradeNumber} ${t.side} ${t.exitReason} bars=${t.barsHeld} mfe=${(t.mfePct * 100).toFixed(1)}% pnl=${t.netPnl.toFixed(1)} [${e.regime?.flags?.join(",")}] ${e.regime?.macroMode}`,
    );
  }
}

const SURGICAL = {
  crossOnly: (r) => r.flags?.includes("HTF_EMA_CROSS_RECENT") && !r.strongTrendBypass,
  shrinkOnly: (r) => r.flags?.includes("HTF_SEP_SHRINKING"),
  crossOrShrink: (r) =>
    (r.flags?.includes("HTF_EMA_CROSS_RECENT") && !r.strongTrendBypass) ||
    r.flags?.includes("HTF_SEP_SHRINKING"),
  sidewaysTriple: (r) =>
    r.flags?.includes("REGIME_SIDEWAYS") &&
    r.flags?.includes("HTF_SEP_SHRINKING") &&
    r.adx15m < 22,
  chopCross: (r) =>
    r.macroMode === "CHOP_SEASON" &&
    r.flags?.includes("HTF_EMA_CROSS_RECENT") &&
    !r.strongTrendBypass,
  chopShrink: (r) => r.macroMode === "CHOP_SEASON" && r.flags?.includes("HTF_SEP_SHRINKING"),
  stWhipsawSideways: (r) =>
    r.flags?.includes("ST_WHIPSAW") && r.flags?.includes("REGIME_SIDEWAYS"),
};

console.log("══ Loss autopsy (10% risk, 30x, regime OFF — your Jan profile) ══\n");

const baselineByWindow = {};
for (const [wname, from, to] of WINDOWS) {
  const { m, enriched } = await runWindow(from, to, null);
  baselineByWindow[wname] = m.totalTrades ?? 0;
  printAutopsy(
    enriched,
    `${wname} baseline ret=${(m.totalReturnPct ?? 0).toFixed(0)}% WR=${((m.winRate ?? 0) * 100).toFixed(0)}% n=${m.totalTrades}`,
  );

  console.log(`\n  Surgical filters (${wname}):`);
  for (const [fname, fn] of Object.entries(SURGICAL)) {
    const { m: fm } = await runWindow(from, to, fn);
    const blocked = baselineByWindow[wname] - (fm.totalTrades ?? 0);
    console.log(
      `    ${fname.padEnd(20)} ret=${String((fm.totalReturnPct ?? 0).toFixed(0)).padStart(5)}% WR=${((fm.winRate ?? 0) * 100).toFixed(0).padStart(2)}% n=${fm.totalTrades} blocked=${blocked}`,
    );
  }
}

console.log("\n══ Preset comparison (your sizing) ══\n");
const presets = [
  ["MAX (regime OFF)", TREND_HTF_ST_BNB_MAX_PRESET],
  ["20% risk MAX", TREND_HTF_ST_BNB_AGGRESSIVE_PRESET],
  ["SURGICAL loss filter", TREND_HTF_ST_BNB_SURGICAL_PRESET],
  ["Whipsaw guard BE@1%", TREND_HTF_ST_BNB_WHIPSAW_GUARD_PRESET],
  ["SURGICAL + whipsaw", { ...TREND_HTF_ST_BNB_SURGICAL_PRESET, backtestBreakevenAtMfePct: 0.01 }],
  ["CHOP SAFE regime ON", TREND_HTF_ST_BNB_CHOP_SAFE_PRESET],
];
for (const [wname, from, to] of WINDOWS) {
  console.log(`--- ${wname} ---`);
  for (const [name, cfg] of presets) {
    const fromMs = new Date(from).getTime();
    const candles = await readCandles("BNBUSDT", "15m", fromMs, new Date(to).getTime());
    const full = { ...cfg };
    const adapters = await buildBacktestAdapters({
      strategyKey: "TREND_HTF_ST",
      cfg: full,
      symbol: "BNBUSDT",
      tf: "15m",
      candles,
      fromMs,
    });
    const sim = await runSimulation({
      strategyKey: "TREND_HTF_ST",
      candles,
      cfg: full,
      gateMode: "off",
      fundingRates: [],
      startingUsdt: 100,
      timeframe: "15m",
      adapters,
      symbol: "BNBUSDT",
    });
    const m = computeAllMetrics({
      trades: sim.trades,
      equityCurve: sim.equityCurve,
      tf: "15m",
      startingEquity: 100,
    });
    const losses = sim.trades.filter((t) => t.netPnl <= 0).length;
    console.log(
      `  ${name.padEnd(22)} ret=${String((m.totalReturnPct ?? 0).toFixed(0)).padStart(5)}% WR=${((m.winRate ?? 0) * 100).toFixed(0).padStart(2)}% n=${m.totalTrades} L=${losses}`,
    );
  }
}

await closePool?.();
