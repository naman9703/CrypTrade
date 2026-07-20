#!/usr/bin/env node
/**
 * Trail health check — verify trailing mechanics on the last BTC trail run config.
 * Usage: cd backend && node scripts/research-liq-trail-health.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const SYMBOL = "BTCUSDT";
const TF = "15m";
const FROM = Date.parse("2025-06-01");
const TO = Date.parse("2026-06-01");

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
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildTrailMicroContext, isTrailMicroEnabled, resolveTrailMicroTf } = await import(
  "../src/backtest/engine/trailMicroSim.js",
);
const { buildTrailingOptsFromCfg, isTrailingEnabledInCfg, resolveTrailOnlyAfterTp2Fill } = await import(
  "../src/lib/trailingOptsFromCfg.js",
);
const { computeEffectiveTrailBuffer } = await import("../src/lib/trailingStopLoss.js");
const { replayTradeTrailingMicro, isTrailReplaySkipped } = await import(
  "../src/backtest/engine/trailTickReplay.js",
);
const { resolveTrailingOpts } = await import("../src/backtest/engine/trailingSim.js");

/** Same config as research-liq-bnb-btc-quant BTC trail block */
const BTC_TRAIL_CFG = {
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
  trailOnlyAfterTp2Fill: false,
};

function countBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

async function runSim(candles, cfg, trailMicro) {
  return runSimulation({
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
}

function sampleAtrPct(candles, pre) {
  const i = Math.floor(candles.length * 0.5);
  const px = candles[i]?.close ?? 1;
  const atr = Number(pre.atrSeries?.[i] ?? 0);
  return px > 0 ? atr / px : 0.01;
}

function auditTrade(t, cfg, atrPct) {
  const exit = String(t.exitReason ?? "").toLowerCase();
  const mfe = Number(t.mfePct ?? 0) * 100;
  const step = Number(t.trailStep ?? 0);
  const tier = t.trailTierLabel ?? null;
  const bars = Number(t.barsHeld ?? 0);
  const trailOpts = buildTrailingOptsFromCfg(cfg, {}, { atrPct });
  const effBuf = trailOpts ? computeEffectiveTrailBuffer(trailOpts) * 100 : null;

  let anomaly = null;
  if (exit === "trail" && step === 0) anomaly = "trail_exit_zero_step";
  if (exit === "trail" && mfe < 0.1) anomaly = "trail_scratch_tiny_mfe";
  if (exit === "trail" && bars <= 2) anomaly = "trail_ultra_fast";
  if (exit === "sl" && step > 0) anomaly = "sl_after_trail_advanced";
  if (exit === "be" && step === 0 && mfe > 1) anomaly = "be_without_trail_tier";

  return {
    id: t.tradeNumber ?? t.entryTs,
    dir: t.direction,
    exit,
    step,
    tier,
    bars,
    mfe,
    pnl: Number(t.netPnl ?? 0),
    effBufPct: effBuf,
    anomaly,
  };
}

console.log("\n=== Trail health check (BTC trail run from quant research) ===\n");

const candles = await readCandles(SYMBOL, TF, FROM, TO, { market: "futures" });
clearIntradayAdapterCache();
let cfg = materializeIntradayEngineCfgSync(BTC_TRAIL_CFG, materializeIntradayPanelOnCfg);
cfg = mergeAdaptiveCfg(cfg, candles);
const pre = precomputeIntraday(candles);

const atrPct = sampleAtrPct(candles, pre);
const trailOn = isTrailingEnabledInCfg(cfg);
const microOn = isTrailMicroEnabled(cfg, { trailEnabled: trailOn });
const trailOpts = buildTrailingOptsFromCfg(cfg, {}, { atrPct });
const effBuf = trailOpts ? computeEffectiveTrailBuffer(trailOpts) : null;

console.log("--- Config ---");
console.log(`trailing enabled: ${trailOn}`);
console.log(`trailOnlyAfterTp2Fill: ${resolveTrailOnlyAfterTp2Fill(cfg)} (expect false for trail-only LIQ)`);
console.log(`intradayLiqAllowTrailOnlyExit: ${cfg.intradayLiqAllowTrailOnlyExit}`);
console.log(`backtestTrailMicroTf: ${resolveTrailMicroTf(cfg)} (micro enabled: ${microOn})`);
console.log(`trailBufferMode: ${cfg.trailBufferMode ?? "PERCENT (default)"}`);
console.log(`trailBufferRate: ${cfg.trailBufferRate ?? 0.0005} (${((cfg.trailBufferRate ?? 0.0005) * 100).toFixed(3)}%)`);
console.log(`trailBufferAtrMult: ${cfg.trailBufferAtrMult ?? 0}`);
console.log(`sample ATR%: ${(atrPct * 100).toFixed(3)}% → effective buffer: ${effBuf != null ? (effBuf * 100).toFixed(3) + "%" : "?"}`);
if (String(cfg.trailBufferMode ?? "PERCENT").toUpperCase() !== "ATR") {
  console.log(
    `⚠ Buffer is FIXED PERCENT (${((cfg.trailBufferRate ?? 0.0005) * 100).toFixed(3)}%), NOT ATR-scaled — on BTC ~$${((cfg.trailBufferRate ?? 0.0005) * (candles.at(-1)?.close ?? 100000)).toFixed(0)} at current price`,
  );
}

const trailMicro = trailOn
  ? await buildTrailMicroContext({ symbol: SYMBOL, fromMs: FROM, toMs: TO, cfg, trailEnabled: true })
  : null;

const withMicro = await runSim(candles, cfg, trailMicro);
clearIntradayAdapterCache();
const noMicro = await runSim(candles, cfg, null);

console.log("\n--- Run comparison (micro 5m vs parent-bar only) ---");
console.log(`with 5m micro: n=${withMicro.trades.length} exits=${JSON.stringify(Object.fromEntries(countBy(withMicro.trades, (t) => t.exitReason)))}`);
console.log(`no micro:      n=${noMicro.trades.length} exits=${JSON.stringify(Object.fromEntries(countBy(noMicro.trades, (t) => t.exitReason)))}`);

const trades = withMicro.trades;
const audits = trades.map((t) => auditTrade(t, cfg, atrPct));
const anomalies = audits.filter((a) => a.anomaly);

console.log("\n--- Exit distribution ---");
for (const [k, v] of countBy(trades, (t) => t.exitReason)) {
  console.log(`  ${String(k).padEnd(16)} ${v}`);
}

const trailExits = audits.filter((a) => a.exit === "trail");
console.log(`\n--- Trail exits (${trailExits.length}) ---`);
console.log(
  `avg trailStep: ${trailExits.length ? (trailExits.reduce((s, a) => s + a.step, 0) / trailExits.length).toFixed(2) : "—"}`,
);
console.log(
  `avg MFE: ${trailExits.length ? (trailExits.reduce((s, a) => s + a.mfe, 0) / trailExits.length).toFixed(2) : "—"}%`,
);
console.log(
  `avg bars held: ${trailExits.length ? (trailExits.reduce((s, a) => s + a.bars, 0) / trailExits.length).toFixed(1) : "—"}`,
);
const tierDist = countBy(trailExits.filter((a) => a.tier), (a) => a.tier);
if (tierDist.size) {
  console.log("tier labels:", Object.fromEntries(tierDist));
}

console.log(`\n--- Anomalies (${anomalies.length}) ---`);
for (const a of anomalies.slice(0, 15)) {
  console.log(
    `  #${a.id} ${a.dir} ${a.exit} step=${a.step} mfe=${a.mfe.toFixed(2)}% bars=${a.bars} → ${a.anomaly}`,
  );
}
if (!anomalies.length) console.log("  none — trail exits have step>0 and reasonable MFE/bars");

console.log("\n--- Micro replay parity (trail/be/sl exits) ---");
let replayOk = 0;
let replayMismatch = 0;
let replaySkip = 0;
let replayFail = 0;
const mismatches = [];

const stSeries = null;
let markBars = [];
if (trailMicro?.loader) {
  await trailMicro.loader.ensureLoaded();
  markBars = trailMicro.loader._bars ?? [];
}

for (const t of trades) {
  if (isTrailReplaySkipped(t.exitReason)) {
    replaySkip++;
    continue;
  }
  const rp = replayTradeTrailingMicro({
    trade: t,
    cfg,
    markBars,
    parentCandles: candles,
    stSeries,
    tfMs: 15 * 60_000,
    tickSize: trailMicro?.tickSize ?? null,
  });
  if (!rp.ok || rp.replaySkipped) {
    replayFail++;
    continue;
  }
  const btReason = String(t.exitReason ?? "").toLowerCase();
  const rpReason = String(rp.exitReason ?? "").toLowerCase();
  const reasonMatch =
    btReason === rpReason ||
    (btReason === "trail" && rpReason === "trail") ||
    (btReason === "be" && rpReason === "be") ||
    (btReason === "sl" && rpReason === "sl");
  const pnlDelta = Math.abs(Number(rp.netPnl ?? 0) - Number(t.netPnl ?? 0));
  if (reasonMatch && pnlDelta < 0.5) replayOk++;
  else {
    replayMismatch++;
    mismatches.push({
      id: t.tradeNumber,
      bt: btReason,
      rp: rpReason,
      btPnl: Number(t.netPnl).toFixed(2),
      rpPnl: Number(rp.netPnl).toFixed(2),
      btStep: t.trailStep,
      rpStep: rp.trailStep,
    });
  }
}

console.log(`  replay match: ${replayOk} | mismatch: ${replayMismatch} | skipped (tp/time/etc): ${replaySkip} | failed: ${replayFail}`);
for (const m of mismatches.slice(0, 8)) {
  console.log(`  #${m.id} bt=${m.bt}/$${m.btPnl} step=${m.btStep} → rp=${m.rp}/$${m.rpPnl} step=${m.rpStep}`);
}

console.log("\n--- Verdict ---");
const trailMechanicsOk = anomalies.filter((a) => a.anomaly === "trail_exit_zero_step").length === 0;
const parityOk = replayMismatch <= Math.max(2, Math.floor(trades.length * 0.1));
const gateOk = !resolveTrailOnlyAfterTp2Fill(cfg);

if (trailMechanicsOk && gateOk && microOn) {
  console.log("✓ Trail engine is functioning (tiers advance, gate allows trail-only, 5m micro active).");
} else {
  console.log("✗ Trail config/engine issues detected — see above.");
}

if (trailExits.length > 0 && trailExits.every((a) => a.mfe < 0.5)) {
  console.log(
    "⚠ Trail is WORKING but exits are scratches: avg MFE <0.5% — fixed 0.05% buffer on BTC is likely too tight vs ATR (~" +
      (atrPct * 100).toFixed(2) +
      "%). Recommend trailBufferMode: ATR with per-coin mult.",
  );
} else if (trailExits.length > 0) {
  console.log("Trail captures some movement; poor returns are mostly entry/follow-through, not broken trail logic.");
}

console.log(
  `\nNote: entry-perfection run had trail OFF. This audit covers the BTC trail block from research-liq-bnb-btc-quant.mjs.`,
);

await closePool();
