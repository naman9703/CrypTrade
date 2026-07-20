#!/usr/bin/env node
/**
 * BTCUSDT LIQ parameter audit — funnel counts + full backtest per knob.
 * Usage: cd backend && node scripts/research-liq-btc-parameter-audit.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = "BTCUSDT";
const TF = "15m";
const WINDOWS = {
  full: { from: Date.parse("2025-06-01"), to: Date.parse("2026-06-01"), label: "full" },
  h1: { from: Date.parse("2025-06-01"), to: Date.parse("2025-12-01"), label: "h1" },
  h2: { from: Date.parse("2025-12-01"), to: Date.parse("2026-06-01"), label: "h2" },
};

const { initPool, closePool } = await import("../src/db/pool.js");
await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { INTRADAY_PRO_LIQ_15M, materializeIntradayEngineCfgSync } = await import(
  "../src/strategy/presets/srIntradayOptimized.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter, precomputeIntraday } = await import(
  "../src/strategy/intradayPro.js",
);
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");
const {
  listSessionLiquiditySetups,
  scanSessionLiquidityCycles,
  isLiqTrailOnlyExit,
  resolveLiqEntryScoreMode,
  resolveLiqDisplacementGateOpts,
} = await import("../src/strategy/techniques/liquidity.js");

/** BTC 15m trail-only — classical PDH/PDL + trail exit (no ETH fork). */
const BTC_TRAIL_15M = {
  ...INTRADAY_PRO_LIQ_15M,
  symbol: SYMBOL,
  timeframe: TF,
  intradayLiqBreakdownDayBias: false,
  riskPerTrade: 3.5,
  srIntradaySweepPct: 0.001,
  intradayLiqMinSweepExtensionPct: 0.004,
  intradayLiqMinRr: 0,
  intradayLiqMinQuality: 0,
  intradayLiqRequireHtfAlign: true,
  intradayLiqMinHtfSep: 0.0008,
  intradayLiqVetoCounterTrend: true,
  intradayLiqEntryMode: "fade",
  intradayLiqPdhPdlOnly: false,
  intradayLiqSessionExtreme: true,
  intradayLiqSessionExtremeMinTouches: 2,
  intradayLiqSessionExtremeMinExtensionPct: 0.001,
  intradayLiqOnePickPerDay: true,
  srIntradayMaxTradesPerDay: 2,
  intradayLiqAllowTrailOnlyExit: true,
  trailingStopLossAuto: true,
  intradayLiqPartialTp: false,
  intradayLiqTp1Enabled: false,
  intradayLiqTp2Enabled: false,
  intradayLiqMaxHoldBars: 48,
  intradayLiqRequireSweepDisplacement: true,
  intradayLiqSweepDisplacementMinAtrMult: 1.2,
  intradayLiqMinEntryScore: 45,
  intradayLiqReclaimHoldBars: 1,
  backtestTrailMicroTf: "5m",
  intradayLiqUseEntryScore: false,
};

const VARIANTS = [
  { name: "preset_partial_tp", base: INTRADAY_PRO_LIQ_15M, patch: {}, trail: false },
  {
    name: "preset_no_entry_score",
    base: INTRADAY_PRO_LIQ_15M,
    patch: { intradayLiqUseEntryScore: false, intradayLiqReclaimHoldBars: 0, intradayLiqMinQuality: 15 },
    trail: false,
  },
  {
    name: "preset_loose_classic",
    base: INTRADAY_PRO_LIQ_15M,
    patch: {
      intradayLiqUseEntryScore: false,
      intradayLiqReclaimHoldBars: 0,
      intradayLiqMinQuality: 0,
      intradayLiqMinSweepExtensionPct: 0.004,
      intradayLiqRequireHtfAlign: false,
      intradayLiqMinReclaimBodyRatio: 0,
      intradayLiqMinRr: 1.2,
    },
    trail: false,
  },
  { name: "btc_trail_default", base: BTC_TRAIL_15M, patch: {}, trail: true },
  {
    name: "btc_trail_trend_pb",
    base: BTC_TRAIL_15M,
    patch: { intradayLiqEntryMode: "trend_pullback", intradayLiqPdhPdlOnly: true },
    trail: true,
  },
  {
    name: "btc_trail_fade_loose",
    base: BTC_TRAIL_15M,
    patch: {
      intradayLiqMinEntryScore: 40,
      intradayLiqSweepDisplacementMinAtrMult: 1.0,
      intradayLiqReclaimHoldBars: 0,
      intradayLiqMinReclaimBodyRatio: 0.35,
    },
    trail: true,
  },
  {
    name: "btc_partial_no_score",
    base: INTRADAY_PRO_LIQ_15M,
    patch: {
      intradayLiqUseEntryScore: false,
      intradayLiqReclaimHoldBars: 0,
      intradayLiqMinQuality: 10,
      intradayLiqMinSweepExtensionPct: 0.004,
    },
    trail: false,
  },
];

const PARAM_SWEEPS = [
  { key: "intradayLiqMinEntryScore", values: [0, 40, 45, 48, 52], base: BTC_TRAIL_15M, trail: true },
  { key: "intradayLiqSweepDisplacementMinAtrMult", values: [0, 1.0, 1.2, 1.5, 2.0], base: BTC_TRAIL_15M, trail: true },
  { key: "intradayLiqReclaimHoldBars", values: [0, 1, 2], base: BTC_TRAIL_15M, trail: true },
  { key: "intradayLiqMinSweepExtensionPct", values: [0.003, 0.004, 0.006, 0.008], base: INTRADAY_PRO_LIQ_15M, trail: false },
  { key: "intradayLiqMinEntryScore", values: [42, 45, 48, 52, 55], base: INTRADAY_PRO_LIQ_15M, trail: false, extra: { intradayLiqUseEntryScore: true } },
];

const candlesByWin = {};
for (const w of Object.values(WINDOWS)) {
  candlesByWin[w.label] = await readCandles(SYMBOL, TF, w.from, w.to, { market: "futures" });
}

function dayStartIndex(candles, idx) {
  const day = Math.floor(candles[idx].ts / 86_400_000);
  for (let j = idx; j >= 0; j--) {
    if (Math.floor(candles[j].ts / 86_400_000) < day) return j + 1;
  }
  return 0;
}

function countFunnel(candles, cfg, pre) {
  const opts = { ...cfg, _liqPre: pre, sweepPct: cfg.srIntradaySweepPct ?? 0.001 };
  let rawCycles = 0;
  let afterExtension = 0;
  let setupsListed = 0;
  const WARMUP = 120;
  for (let i = WARMUP; i < candles.length; i++) {
    const pdh = pre.prevDayHigh?.[i];
    const pdl = pre.prevDayLow?.[i];
    const dayStart = dayStartIndex(candles, i);
    for (const side of ["BUY", "SELL"]) {
      const level = side === "BUY" ? pdl : pdh;
      const opp = side === "BUY" ? pdh : pdl;
      const lt = side === "BUY" ? "pdl" : "pdh";
      if (!(level > 0) || !(opp > 0)) continue;
      const cycles = scanSessionLiquidityCycles(
        candles,
        i,
        side,
        level,
        opp,
        lt,
        Number(opts.sweepPct ?? 0.001),
        dayStart,
        opts,
      );
      rawCycles += cycles.length;
      for (const c of cycles) {
        const minExt = Number(opts.intradayLiqMinSweepExtensionPct ?? 0.008);
        if (c.extension + 1e-6 >= minExt) afterExtension++;
      }
      const listed = listSessionLiquiditySetups(candles, i, side, pre, opts);
      setupsListed += listed.length;
    }
  }
  return { rawCycles, afterExtension, setupsListed };
}

async function runBt(base, patch, winKey, trail) {
  const win = WINDOWS[winKey];
  const candles = candlesByWin[winKey];
  if (candles.length < 500) return null;
  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    { ...base, ...patch, symbol: SYMBOL, timeframe: TF },
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, candles);
  const trailOn = trail || isLiqTrailOnlyExit(cfg);
  const trailMicro = trailOn
    ? await buildTrailMicroContext({ symbol: SYMBOL, fromMs: win.from, toMs: win.to, cfg, trailEnabled: true })
    : null;
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
    trailMicro,
  });
  const m = computeAllMetrics({
    trades: sim.trades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 100,
  });
  const months = Math.max(1, (win.to - win.from) / (30 * 86_400_000));
  return {
    n: sim.trades.length,
    tpm: sim.trades.length / months,
    ret: Number(m.totalReturnPct ?? 0),
    pf: Number(m.profitFactor ?? 0),
    wr: Number(m.winRate ?? 0) * 100,
    dd: Number(m.maxDrawdownPct ?? 0),
    cfg,
  };
}

console.log("\n=== BTCUSDT LIQ parameter audit ===\n");

// Funnel on full year for key configs
console.log("--- Setup funnel (full year, raw cycles vs listed setups) ---");
const funnelBases = [
  ["preset_partial_tp", INTRADAY_PRO_LIQ_15M, {}],
  ["preset_no_entry_score", INTRADAY_PRO_LIQ_15M, { intradayLiqUseEntryScore: false, intradayLiqMinQuality: 15 }],
  ["btc_trail_default", BTC_TRAIL_15M, {}],
];
const fullCandles = candlesByWin.full;
const pre = precomputeIntraday(fullCandles);
for (const [name, base, patch] of funnelBases) {
  const cfg = materializeIntradayEngineCfgSync(
    { ...base, ...patch, symbol: SYMBOL, timeframe: TF },
    materializeIntradayPanelOnCfg,
  );
  const f = countFunnel(fullCandles, mergeAdaptiveCfg(cfg, fullCandles), pre);
  const trail = isLiqTrailOnlyExit(cfg);
  const esc = resolveLiqEntryScoreMode(cfg);
  const disp = resolveLiqDisplacementGateOpts(cfg);
  console.log(
    `${name.padEnd(24)} cycles=${String(f.rawCycles).padStart(4)} ext_ok=${String(f.afterExtension).padStart(4)} listed=${String(f.setupsListed).padStart(4)} trail=${trail} ctxScore=${esc} disp=${disp.required}`,
  );
}

// Variant backtests
console.log("\n--- Variant backtests (full / h1 / h2) ---");
console.log(
  `${"variant".padEnd(26)} ${"full_n".padStart(6)} ${"full%".padStart(7)} ${"h1%".padStart(7)} ${"h2%".padStart(7)} ${"tpm".padStart(5)} exit`,
);
for (const v of VARIANTS) {
  const full = await runBt(v.base, v.patch, "full", v.trail);
  const h1 = await runBt(v.base, v.patch, "h1", v.trail);
  const h2 = await runBt(v.base, v.patch, "h2", v.trail);
  const exit = v.trail || isLiqTrailOnlyExit(full?.cfg ?? {}) ? "trail" : "partial";
  console.log(
    `${v.name.padEnd(26)} ${String(full?.n ?? 0).padStart(6)} ${(full?.ret ?? 0).toFixed(2).padStart(7)} ${(h1?.ret ?? 0).toFixed(2).padStart(7)} ${(h2?.ret ?? 0).toFixed(2).padStart(7)} ${(full?.tpm ?? 0).toFixed(2).padStart(5)} ${exit}`,
  );
}

// Per-parameter sweeps on full year
console.log("\n--- Single-parameter sweeps (full year) ---");
for (const sweep of PARAM_SWEEPS) {
  console.log(`\n${sweep.key} (base=${sweep.base === BTC_TRAIL_15M ? "btc_trail" : "preset_partial"})`);
  console.log(`${"value".padStart(8)} ${"n".padStart(5)} ${"ret%".padStart(8)} ${"PF".padStart(6)} ${"WR%".padStart(5)}`);
  for (const val of sweep.values) {
    const patch = { ...(sweep.extra ?? {}), [sweep.key]: val };
    if (sweep.key === "intradayLiqSweepDisplacementMinAtrMult" && val === 0) {
      patch.intradayLiqRequireSweepDisplacement = false;
    }
    const r = await runBt(sweep.base, patch, "full", sweep.trail);
    console.log(
      `${String(val).padStart(8)} ${String(r?.n ?? 0).padStart(5)} ${(r?.ret ?? 0).toFixed(2).padStart(8)} ${(r?.pf ?? 0).toFixed(2).padStart(6)} ${(r?.wr ?? 0).toFixed(0).padStart(5)}`,
    );
  }
}

// Trade audit for best-return variant with n>=5
console.log("\n--- Trade list: preset_partial_tp (full year) ---");
clearIntradayAdapterCache();
const audit = await runBt(INTRADAY_PRO_LIQ_15M, {}, "full", false);
if (audit) {
  clearIntradayAdapterCache();
  let cfg = materializeIntradayEngineCfgSync(
    { ...INTRADAY_PRO_LIQ_15M, symbol: SYMBOL, timeframe: TF },
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, fullCandles);
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles: fullCandles,
    cfg,
    costModelOverride: {},
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    symbol: SYMBOL,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(fullCandles, cfg, TF) },
  });
  for (const t of sim.trades) {
    const l = t.liqContext ?? {};
    console.log(
      `${new Date(t.entryTs).toISOString().slice(0, 16)} ${t.direction.padEnd(4)} ${String(l.levelType ?? "?").padEnd(12)} pnl=${Number(t.netPnl ?? 0).toFixed(3)} exit=${t.exitReason} q=${l.liqQuality ?? "?"}`,
    );
  }
}

await closePool();
