#!/usr/bin/env node
/**
 * Focused LIQUIDITY_MAP OOS probe.
 *
 * Tests a small set of simple variants across random single-coin 1-month windows.
 * This is intentionally narrow: enough to expose whether higher trade count / larger
 * TP comes from real edge or just lower-quality entries.
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const DEFAULT_CASES = [
  ["BTCUSDT", "2026-01-01", "2026-02-01"],
  ["ETHUSDT", "2026-02-01", "2026-03-01"],
  ["BNBUSDT", "2026-03-01", "2026-04-01"],
  ["XRPUSDT", "2026-04-01", "2026-05-01"],
  ["DOGEUSDT", "2026-05-01", "2026-06-01"],
  ["SOLUSDT", "2026-05-01", "2026-06-01"],
];

const TF = process.env.TF || "5m";
const START = Number(process.env.START_USDT || 10_000);
const CASES = String(process.env.CASES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => s.split(":"))
  .filter((parts) => parts.length === 3);
const TEST_CASES = CASES.length ? CASES : DEFAULT_CASES;
const ONLY_VARIANTS = new Set(
  String(process.env.VARIANTS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const {
  LIQUIDITY_MAP_BTC_5M_PRESET,
} = await import("../src/strategy/liquidityMapStrategy.js");

const common = {
  strategyMode: "MANUAL",
  manualStrategy: "LIQUIDITY_MAP",
  timeframe: TF,
  marketMode: "FUTURES",
  riskPerTrade: 1,
  riskPerTradeUnit: "PCT",
  backtestPositionSizing: "RISK_AT_SL",
  liqMapEntryModel: "HTF_SWEEP",
  liqMapHtfPoolTfs: "1h,4h",
  liqMapUseDailyWeeklyPools: true,
  liqMapUseTrendlinePools: true,
  liqMapHtfMode: "against",
  liqMapUse4hConfirm: false,
  liqMapNormalizeThresholds: true,
  liqMapAutoCalibrate: true,
  liqMapAutoProfileBars: 200,
  liqMapQualityGate: true,
  liqMapQualityGateMode: "SOFT",
  liqMapQualityAuto: true,
  liqMapMinQualityScore: 6.2,
  liqMapRequireMss: true,
  liqMapRequireChoch: false,
  liqMapRequireReclaimHold: true,
  liqMapMssRequireDisplacement: true,
  liqMapEntryZoneMode: "FVG",
  liqMapFvgEntryMode: "ZONE",
  liqMapStrictPdZone: true,
  liqMapExitMode: "SCALED_FIXED",
  liqMapTrailMode: "SUPERTREND",
  liqMapOnePerDay: true,
  liqMapOnePerSidePerDay: false,
  trailingStopLossAuto: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: true,
  intradayLiqPartialTp: false,
  intradayLiqBreakevenAfterPartial: false,
};

const variants = [
  {
    name: "current_big_tp",
    cfg: {
      ...common,
      liqMapRequireRetrace: true,
      liqMapMssMaxBarsAfterSweep: 15,
      liqMapMaxOpposingRr: 3,
      liqMapMinTp2Rr: 2,
      liqMapFallbackTpRr: 3.5,
    },
  },
  {
    name: "balanced_tp_more_trades",
    cfg: {
      ...common,
      liqMapRequireRetrace: true,
      liqMapMssMaxBarsAfterSweep: 20,
      liqMapMaxOpposingRr: 2.5,
      liqMapMinTp2Rr: 1.5,
      liqMapFallbackTpRr: 2.5,
    },
  },
  {
    name: "next_open_fast",
    cfg: {
      ...common,
      liqMapEntryTiming: "NEXT_OPEN",
      liqMapRequireRetrace: false,
      liqMapMssMaxBarsAfterSweep: 12,
      liqMapEntryZoneMode: "EITHER",
      liqMapMaxOpposingRr: 2.5,
      liqMapMinTp2Rr: 1.5,
      liqMapFallbackTpRr: 2,
    },
  },
  {
    name: "partial_runner",
    cfg: {
      ...common,
      liqMapRequireRetrace: true,
      liqMapMssMaxBarsAfterSweep: 20,
      liqMapExitMode: "PARTIAL_RUNNER",
      liqMapTrailMode: "DYNAMIC_ATR",
      liqMapMaxOpposingRr: 0,
      liqMapMinTp2Rr: 1.5,
      liqMapDynamicRunnerMaxTpRr: 12,
      liqMapDynamicRunnerMinTpRr: 2,
      liqMapPartialFrac: 0.6,
      liqMapBreakevenAfterPartial: true,
    },
  },
  {
    name: "htf_trend_fvg_runner",
    cfg: {
      ...common,
      // Expansion model: only take sweeps whose confirmed reversal side is aligned
      // with the higher-timeframe trend, then use a runner instead of fixed TP.
      liqMapHtfMode: "with",
      liqMapEntryTiming: "FVG_OR_OB",
      liqMapRequireRetrace: true,
      liqMapRequireReclaimHold: true,
      liqMapEntryZoneMode: "FVG",
      liqMapMssMaxBarsAfterSweep: 20,
      liqMapExitMode: "PARTIAL_RUNNER",
      liqMapTrailMode: "DYNAMIC_ATR",
      liqMapMaxOpposingRr: 0,
      liqMapMinTp2Rr: 1.2,
      liqMapDynamicRunnerMaxTpRr: 15,
      liqMapDynamicRunnerMinTpRr: 2,
      liqMapPartialFrac: 0.5,
      liqMapBreakevenAfterPartial: false,
      liqMapDynamicExitPolicy: true,
    },
  },
  {
    name: "htf_trend_strong_runner",
    cfg: {
      ...common,
      liqMapHtfMode: "with",
      liqMapEntryTiming: "FVG_OR_OB",
      liqMapRequireRetrace: true,
      liqMapRequireReclaimHold: true,
      liqMapRequireDirectionalClose: true,
      liqMapEntryZoneMode: "FVG",
      liqMapMssMaxBarsAfterSweep: 16,
      liqMapMssRequireDisplacement: true,
      liqMapDisplacementBodyMult: 1.45,
      liqMapDisplacementAtrMult: 0.65,
      liqMapMinQualityScore: 7.0,
      liqMapQualityAuto: false,
      liqMapExitMode: "PARTIAL_RUNNER",
      liqMapTrailMode: "DYNAMIC_ATR",
      liqMapMaxOpposingRr: 0,
      liqMapMinTp2Rr: 1.2,
      liqMapDynamicRunnerMaxTpRr: 15,
      liqMapDynamicRunnerMinTpRr: 2.5,
      liqMapPartialFrac: 0.45,
      liqMapBreakevenAfterPartial: false,
      liqMapDynamicExitPolicy: true,
    },
  },
  {
    name: "htf_trend_fast_runner",
    cfg: {
      ...common,
      // Same expansion logic, but enters immediately after MSS to catch candles
      // that never retrace into an FVG before expanding.
      liqMapHtfMode: "with",
      liqMapEntryTiming: "NEXT_OPEN",
      liqMapRequireRetrace: false,
      liqMapRequireReclaimHold: true,
      liqMapEntryZoneMode: "EITHER",
      liqMapMssMaxBarsAfterSweep: 12,
      liqMapExitMode: "PARTIAL_RUNNER",
      liqMapTrailMode: "DYNAMIC_ATR",
      liqMapMaxOpposingRr: 0,
      liqMapMinTp2Rr: 1.2,
      liqMapDynamicRunnerMaxTpRr: 15,
      liqMapDynamicRunnerMinTpRr: 2,
      liqMapPartialFrac: 0.45,
      liqMapBreakevenAfterPartial: false,
      liqMapDynamicExitPolicy: true,
    },
  },
  {
    name: "internal_trend_runner",
    cfg: {
      ...common,
      liqMapEntryModel: "STRUCTURAL",
      liqMapHtfMode: "with",
      liqMapEntryTiming: "NEXT_OPEN",
      liqMapRequireRetrace: false,
      liqMapRequireReclaimHold: true,
      liqMapEntryZoneMode: "EITHER",
      liqMapMssMaxBarsAfterSweep: 12,
      liqMapLookbackBars: 144,
      liqMapMaxAgeBars: 144,
      liqMapMinTouches: 1,
      liqMapExitMode: "PARTIAL_RUNNER",
      liqMapTrailMode: "DYNAMIC_ATR",
      liqMapMaxOpposingRr: 0,
      liqMapMinTp2Rr: 1.2,
      liqMapDynamicRunnerMaxTpRr: 15,
      liqMapDynamicRunnerMinTpRr: 2,
      liqMapPartialFrac: 0.45,
      liqMapBreakevenAfterPartial: false,
      liqMapDynamicExitPolicy: true,
    },
  },
  {
    name: "internal_trend_strong_runner",
    cfg: {
      ...common,
      liqMapEntryModel: "STRUCTURAL",
      liqMapHtfMode: "with",
      liqMapEntryTiming: "NEXT_OPEN",
      liqMapRequireRetrace: false,
      liqMapRequireReclaimHold: true,
      liqMapRequireDirectionalClose: true,
      liqMapEntryZoneMode: "EITHER",
      liqMapMssMaxBarsAfterSweep: 10,
      liqMapLookbackBars: 144,
      liqMapMaxAgeBars: 144,
      liqMapMinTouches: 1,
      liqMapMssRequireDisplacement: true,
      liqMapDisplacementBodyMult: 1.45,
      liqMapDisplacementAtrMult: 0.65,
      liqMapMinQualityScore: 7.0,
      liqMapQualityAuto: false,
      liqMapExitMode: "PARTIAL_RUNNER",
      liqMapTrailMode: "DYNAMIC_ATR",
      liqMapMaxOpposingRr: 0,
      liqMapMinTp2Rr: 1.2,
      liqMapDynamicRunnerMaxTpRr: 15,
      liqMapDynamicRunnerMinTpRr: 2.5,
      liqMapPartialFrac: 0.45,
      liqMapBreakevenAfterPartial: false,
      liqMapDynamicExitPolicy: true,
    },
  },
  {
    name: "internal_structural_fast",
    cfg: {
      ...common,
      liqMapEntryModel: "STRUCTURAL",
      liqMapHtfMode: "none",
      liqMapEntryTiming: "NEXT_OPEN",
      liqMapRequireRetrace: false,
      liqMapRequireReclaimHold: true,
      liqMapEntryZoneMode: "EITHER",
      liqMapMssMaxBarsAfterSweep: 12,
      liqMapLookbackBars: 144,
      liqMapMaxAgeBars: 144,
      liqMapMinTouches: 1,
      liqMapQualityGate: true,
      liqMapQualityGateMode: "SOFT",
      liqMapMaxOpposingRr: 2,
      liqMapMinTp2Rr: 1.2,
      liqMapFallbackTpRr: 1.6,
    },
  },
  {
    name: "internal_structural_runner",
    cfg: {
      ...common,
      liqMapEntryModel: "STRUCTURAL",
      liqMapHtfMode: "none",
      liqMapEntryTiming: "NEXT_OPEN",
      liqMapRequireRetrace: false,
      liqMapRequireReclaimHold: true,
      liqMapEntryZoneMode: "EITHER",
      liqMapMssMaxBarsAfterSweep: 12,
      liqMapLookbackBars: 144,
      liqMapMaxAgeBars: 144,
      liqMapMinTouches: 1,
      liqMapQualityGate: true,
      liqMapQualityGateMode: "SOFT",
      liqMapExitMode: "PARTIAL_RUNNER",
      liqMapTrailMode: "DYNAMIC_ATR",
      liqMapMaxOpposingRr: 0,
      liqMapMinTp2Rr: 1.5,
      liqMapFallbackTpRr: 2.5,
      liqMapDynamicRunnerMaxTpRr: 15,
      liqMapDynamicRunnerMinTpRr: 2,
      liqMapPartialFrac: 0.45,
      liqMapBreakevenAfterPartial: false,
      liqMapDynamicExitPolicy: true,
      liqMapAutoTrailTune: true,
      liqMapHybridExit: true,
      liqMapTrailAtrHwmMult: 2.5,
      liqMapTrailMfeGiveback: 0.18,
      liqMapTrailMfeMinR: 1.2,
      liqMapTrailStepAtrMult: 0.6,
      liqMapTrailMergeSt: true,
      trailBufferMode: "ATR",
      trailBufferAtrMult: 0.28,
    },
  },
];

function uniqEntries(trades, fromMs, toMs) {
  const seen = new Set();
  const out = [];
  for (const t of trades) {
    const ts = Number(t.entryTs);
    if (!(ts >= fromMs && ts < toMs)) continue;
    const key = `${ts}:${t.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

async function runCase(symbol, from, to, variant) {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const warmupMs = 14 * 86_400_000;
  const candles = await readCandles(symbol, TF, fromMs - warmupMs, toMs, { market: "futures" });
  if (!candles.length) return { error: "no_candles" };
  const baseCfg = {
    ...LIQUIDITY_MAP_BTC_5M_PRESET,
    ...variant.cfg,
    symbol,
    timeframe: TF,
    backtestSignalStartMs: fromMs,
  };
  const { resolveLiquidityMapRunCfg } = await import("../src/strategy/liquidityMapStrategy.js");
  const cfg = resolveLiquidityMapRunCfg(baseCfg, candles);
  const adapters = await buildBacktestAdapters({
    strategyKey: "LIQUIDITY_MAP",
    cfg,
    symbol,
    tf: TF,
    candles,
    fromMs: Number(candles[0]?.ts) || fromMs,
  });
  const sim = await runSimulation({
    strategyKey: "LIQUIDITY_MAP",
    candles,
    cfg,
    costModelOverride: { slippagePct: 0.0005 },
    gateMode: "off",
    fundingRates: [],
    startingUsdt: START,
    timeframe: TF,
    symbol,
    adapters,
  });
  const inWinTrades = sim.trades.filter((t) => Number(t.entryTs) >= fromMs && Number(t.entryTs) < toMs);
  const logical = uniqEntries(sim.trades, fromMs, toMs);
  const metrics = computeAllMetrics({
    trades: inWinTrades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: START,
  });
  const days = Math.max(1, (toMs - fromMs) / 86_400_000);
  return {
    trades: logical.length,
    perDay: logical.length / days,
    ret: Number(metrics.totalReturnPct ?? 0),
    pf: Number(metrics.profitFactor ?? 0),
    wr: Number(metrics.winRate ?? 0) * 100,
    dd: Number(metrics.maxDrawdownPct ?? 0),
    avgR: Number(metrics.expectancyR ?? 0),
  };
}

const results = [];
for (const [symbol, from, to] of TEST_CASES) {
  for (const variant of variants) {
    if (ONLY_VARIANTS.size && !ONLY_VARIANTS.has(variant.name)) continue;
    const r = await runCase(symbol, from, to, variant);
    results.push({ symbol, from, to, variant: variant.name, ...r });
    console.log(JSON.stringify(results.at(-1)));
  }
}

const byVariant = new Map();
for (const r of results) {
  if (r.error) continue;
  const cur = byVariant.get(r.variant) ?? { n: 0, ret: 0, trades: 0, pf: 0, dd: 0, pos: 0, perDay: 0 };
  cur.n += 1;
  cur.ret += r.ret;
  cur.trades += r.trades;
  cur.pf += Number.isFinite(r.pf) ? r.pf : 0;
  cur.dd += r.dd;
  cur.pos += r.ret > 0 ? 1 : 0;
  cur.perDay += r.perDay;
  byVariant.set(r.variant, cur);
}

console.log("\n=== SUMMARY ===");
for (const [variant, v] of byVariant.entries()) {
  console.log(JSON.stringify({
    variant,
    cases: v.n,
    avgRet: Number((v.ret / v.n).toFixed(2)),
    avgTrades: Number((v.trades / v.n).toFixed(1)),
    avgPerDay: Number((v.perDay / v.n).toFixed(2)),
    avgPf: Number((v.pf / v.n).toFixed(2)),
    avgDd: Number((v.dd / v.n).toFixed(2)),
    positiveCases: `${v.pos}/${v.n}`,
  }));
}

await closePool?.();
