#!/usr/bin/env node
/**
 * Accurate LIQ_CASCADE signal replay — force_orders liq + full bar-close gates + data quality.
 *
 * Usage (backend/):
 *   HOURS=720 LIQ_SOURCE=force_orders node scripts/research-liq-cascade-last10h-signals.mjs
 *   SETUP=production_1m HOURS=72 node scripts/research-liq-cascade-last10h-signals.mjs
 *   SETUP=smoke_1m HOURS=72 node scripts/research-liq-cascade-last10h-signals.mjs
 */
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const DAYS = Number(process.env.DAYS || 0);
const HOURS = Number(process.env.HOURS || (DAYS > 0 ? DAYS * 24 : 10));
const TF = process.env.TF || "1m";
const LIQ_SOURCE = process.env.LIQ_SOURCE || "force_orders";
const SETUP = String(process.env.SETUP || "production_5m").toLowerCase();
const OUT = process.env.OUT || "";

const presetMod = await import("../src/strategy/presets/liqCascadeOptimized.js");

const PRESET_BY_SETUP = {
  production_5m: {
    BTCUSDT: presetMod.LIQ_CASCADE_BTC_1M,
    ETHUSDT: presetMod.LIQ_CASCADE_ETH_1M,
    BNBUSDT: presetMod.LIQ_CASCADE_BNB_1M,
  },
  smoke_5m: {
    BTCUSDT: presetMod.LIQ_CASCADE_BTC_1M_SMOKE_TEST,
    ETHUSDT: presetMod.LIQ_CASCADE_ETH_1M_SMOKE_TEST,
    BNBUSDT: { ...presetMod.LIQ_CASCADE_BNB_1M, ...presetMod.LIQ_CASCADE_SMOKE_TEST_PATCH },
  },
  production_1m: {
    BTCUSDT: presetMod.LIQ_CASCADE_BTC_1M_LIQ_1MIN,
    ETHUSDT: presetMod.LIQ_CASCADE_ETH_1M_LIQ_1MIN,
    BNBUSDT: presetMod.LIQ_CASCADE_BNB_1M_LIQ_1MIN,
  },
  smoke_1m: {
    BTCUSDT: presetMod.LIQ_CASCADE_BTC_1M_SMOKE_1MIN,
    ETHUSDT: presetMod.LIQ_CASCADE_ETH_1M_SMOKE_1MIN,
    BNBUSDT: { ...presetMod.LIQ_CASCADE_BNB_1M, ...presetMod.LIQ_CASCADE_SMOKE_1MIN_PATCH },
  },
};

const PRESETS = PRESET_BY_SETUP[SETUP] ?? PRESET_BY_SETUP.production_5m;
const LIQ_INTERVAL = process.env.LIQ_INTERVAL || PRESETS.BTCUSDT?.liqCascadeInterval || "5min";

const toMs = Date.now();
const fromMs = toMs - HOURS * 60 * 60 * 1000;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const {
  hydrateLiqCascadeCfg,
  liqCascadePadFromMs,
  buildLiqCascadeBacktestAdapter,
} = await import("../src/strategy/liqCascadeIntraday.js");
const {
  buildLiqCascadeSeries,
  prepareLiqBars,
  prepareOiBars,
  resolveOiGate,
  liqIntervalToMs,
  LIQ_CASCADE_WARMUP,
} = await import("../src/strategy/techniques/liqCascade.js");
const { optsFromLiqCascadeCfg } = await import("../src/strategy/liqCascadeIntraday.js");
const { computeLiqCascadeDataQuality } = await import("../src/strategy/liqCascadeDataQuality.js");

function candleIdxAtOrBefore(candles, ts) {
  let lo = 0;
  let hi = candles.length - 1;
  let best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Number(candles[mid].ts) <= ts) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}

async function replaySymbol(symbol) {
  const preset = { ...PRESETS[symbol], liqCascadeLiqSource: LIQ_SOURCE, liqCascadeInterval: LIQ_INTERVAL };
  const padFrom = liqCascadePadFromMs(fromMs, TF);
  if (process.env.SKIP_ENSURE !== "1") {
    await ensureKlines(symbol, TF, { from: padFrom, to: toMs, market: "futures" });
  }
  const candles = await readCandles(symbol, TF, padFrom, toMs, { market: "futures" });
  const cfg = await hydrateLiqCascadeCfg(preset, symbol, padFrom, toMs);
  const liqSeries = cfg._liqCascadeLiqSeries ?? [];
  const oiSeries = cfg._liqCascadeOiSeries ?? [];
  const tickCount = cfg._liqCascadeTickCount ?? null;
  const liqSource = cfg._liqCascadeLiqSource ?? LIQ_SOURCE;

  const { readRecentForceOrders } = await import("../src/intelligence/collectors/forceOrderPersist.js");
  const ticks = await readRecentForceOrders(symbol, fromMs, toMs);
  const intervalMs = liqIntervalToMs(cfg.liqCascadeInterval ?? LIQ_INTERVAL);
  const dataQuality = computeLiqCascadeDataQuality({
    ticks,
    liqSeries,
    fromMs,
    toMs,
    intervalMs,
  });

  const liqBars = prepareLiqBars(liqSeries, {
    intervalMs,
    lookbackBars: Number(cfg.liqCascadeLookbackBars ?? 48),
  });
  const oiBars = prepareOiBars(oiSeries, intervalMs);
  const liqInWindow = liqBars.filter((b) => b.ts >= fromMs && b.ts <= toMs);

  const opts = optsFromLiqCascadeCfg(cfg);
  const { series, feat } = buildLiqCascadeSeries(candles, { liqSeries, oiSeries, opts });

  const rawSignals = [];
  for (let i = 0; i < candles.length; i++) {
    const ts = Number(candles[i].ts);
    if (ts < fromMs || ts > toMs) continue;
    const sig = series[i];
    if (!sig) continue;
    rawSignals.push({
      ts,
      iso: new Date(ts).toISOString(),
      action: sig.action,
      reason: sig.reason,
      trigger: sig.trigger,
      liqZ: sig.liqZ != null ? +Number(sig.liqZ).toFixed(2) : null,
      liqUsd: sig.liqUsd != null ? Math.round(sig.liqUsd) : null,
      oiDropPct: sig.oiDropPct != null ? +Number(sig.oiDropPct).toFixed(3) : null,
      dispAtr: sig.dispAtr != null ? +Number(sig.dispAtr).toFixed(2) : null,
      slPct: sig.liqBrackets?.slPct != null ? +Number(sig.liqBrackets.slPct * 100).toFixed(3) : null,
      tpPct: sig.liqBrackets?.tpPct != null ? +Number(sig.liqBrackets.tpPct * 100).toFixed(3) : null,
    });
  }

  const adapter = buildLiqCascadeBacktestAdapter(candles, cfg, TF, { liqSeries, oiSeries });
  const adapterSignals = [];
  const ctx = { persisted: {} };
  for (let i = 0; i < candles.length; i++) {
    const ts = Number(candles[i].ts);
    if (ts < fromMs || ts > toMs) continue;
    if (i < LIQ_CASCADE_WARMUP) continue;
    const sig = adapter(candles[i], i, ctx);
    if (!sig) continue;
    adapterSignals.push({
      ts,
      iso: new Date(ts).toISOString(),
      action: sig.action,
      reason: sig.reason,
      trigger: sig.trigger,
    });
  }

  const barsMinLiq = liqInWindow.filter((b) => b.totalUsd >= opts.minLiqUsdBar);
  const nearMisses = [];
  for (const lb of barsMinLiq) {
    const idx = candleIdxAtOrBefore(candles, lb.ts);
    const ts = idx != null ? Number(candles[idx].ts) : null;
    const oiGate = ts != null ? resolveOiGate(oiBars, ts, opts) : { dropPct: null, ok: false, mode: opts.oiGateMode };
    const startIdx = ts != null ? candleIdxAtOrBefore(candles, lb.tsOpen) : null;
    const atrVal = feat?.atr?.[idx ?? 0];
    const close = feat?.closes?.[idx ?? 0];
    const disp =
      atrVal > 0 && startIdx != null ? Math.abs(close - Number(candles[startIdx].close)) / atrVal : null;
    const atrPct = close > 0 && atrVal > 0 ? (atrVal / close) * 100 : 0;
    nearMisses.push({
      barClose: new Date(lb.ts).toISOString(),
      totalUsd: Math.round(lb.totalUsd),
      z: lb.z != null ? +Number(lb.z).toFixed(2) : null,
      dom: lb.dom,
      zPass: lb.z != null && lb.z >= opts.liqZScoreMin,
      oiDropPct: oiGate.dropPct != null ? +Number(oiGate.dropPct).toFixed(2) : null,
      oiGateMode: oiGate.mode,
      oiPass: oiGate.ok,
      dispAtr: disp != null ? +Number(disp).toFixed(2) : null,
      dispPass: disp != null && disp >= opts.minDispAtrMult,
      atrPct: atrPct ? +Number(atrPct).toFixed(3) : null,
      atrPass: atrPct >= opts.minAtrPct,
      cascadeEligible: !!(
        lb.z != null &&
        lb.z >= opts.liqZScoreMin &&
        (lb.dom === "longs" || lb.dom === "shorts") &&
        lb.totalUsd >= opts.minLiqUsdBar &&
        disp != null &&
        disp >= opts.minDispAtrMult &&
        oiGate.ok &&
        atrPct >= opts.minAtrPct
      ),
    });
  }

  return {
    symbol,
    preset: {
      zMin: cfg.liqCascadeZScoreMin,
      minLiqUsdBar: cfg.liqCascadeMinLiqUsdBar ?? opts.minLiqUsdBar,
      oiGateMode: opts.oiGateMode,
      oiWindowBars: opts.oiWindowBars,
      minOiDropPct: cfg.liqCascadeMinOiDropPct,
      confirmMode: opts.confirmMode,
      confirmLiqBars: opts.confirmLiqBars,
      minDispAtr: cfg.liqCascadeMinDispAtr,
    },
    dataQuality,
    data: {
      liqSource,
      tickCount,
      liqBarsInWindow: liqInWindow.length,
      liqBarsNonZero: liqInWindow.filter((b) => b.totalUsd > 0).length,
      barsMinLiqPlus: barsMinLiq.length,
      candleCount: candles.filter((c) => Number(c.ts) >= fromMs).length,
      oiBars: oiSeries.length,
    },
    rawSignals,
    adapterSignals,
    nearMisses,
    funnel: {
      liqBarsInWindow: liqInWindow.length,
      liqBarsNonZero: liqInWindow.filter((b) => b.totalUsd > 0).length,
      barsMinLiqPlus: barsMinLiq.length,
      zPass: nearMisses.filter((x) => x.zPass).length,
      domPass: nearMisses.filter((x) => x.dom === "longs" || x.dom === "shorts").length,
      dispPass: nearMisses.filter((x) => x.dispPass).length,
      oiPass: nearMisses.filter((x) => x.oiPass).length,
      atrPass: nearMisses.filter((x) => x.atrPass).length,
      cascadeEligible: nearMisses.filter((x) => x.cascadeEligible).length,
      rawSignals: rawSignals.length,
      adapterSignals: adapterSignals.length,
    },
  };
}

function aggregateFunnel(results) {
  const keys = [
    "liqBarsInWindow",
    "liqBarsNonZero",
    "barsMinLiqPlus",
    "zPass",
    "domPass",
    "dispPass",
    "oiPass",
    "atrPass",
    "cascadeEligible",
    "rawSignals",
    "adapterSignals",
  ];
  const totals = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const r of results) {
    if (!r.funnel) continue;
    for (const k of keys) totals[k] += r.funnel[k] ?? 0;
  }
  return totals;
}

const results = [];
for (const sym of Object.keys(PRESETS)) {
  try {
    results.push(await replaySymbol(sym));
  } catch (err) {
    results.push({ symbol: sym, error: String(err?.message || err) });
  }
}

const anySufficient = results.some((r) => r.dataQuality?.accurateReplayReady);
const funnelTotals = aggregateFunnel(results);
const samplePreset = results.find((r) => r.preset)?.preset ?? null;
const summary = {
  setup: SETUP,
  window: {
    hours: HOURS,
    days: +(HOURS / 24).toFixed(2),
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
  },
  mode: "bar_close_1m",
  liqSource: LIQ_SOURCE,
  liqInterval: LIQ_INTERVAL,
  presetSnapshot: samplePreset,
  gateConfig: samplePreset
    ? {
        zMin: samplePreset.zMin,
        minLiqUsdBar: samplePreset.minLiqUsdBar,
        oiGateMode: samplePreset.oiGateMode,
        oiWindowBars: samplePreset.oiWindowBars,
        confirmMode: samplePreset.confirmMode,
        confirmLiqBars: samplePreset.confirmLiqBars,
        minDispAtr: samplePreset.minDispAtr,
      }
    : null,
  dataQualityVerdict: anySufficient
    ? "sufficient"
    : results[0]?.dataQuality?.verdict ?? "partial",
  dataQualityNote: anySufficient
    ? "Full-window replay claims allowed."
    : "Results reflect effective tick coverage only — keep force_orders WS running to reach ≥8 weeks.",
  note:
    "rawSignals = full gates; adapterSignals = after maxTradesPerDay + minBarGap. Edge confirmation requires sufficient tick coverage + phase0/sim.",
  funnel: funnelTotals,
  coins: results.map((r) => ({
    symbol: r.symbol,
    error: r.error,
    preset: r.preset,
    dataQuality: r.dataQuality,
    data: r.data,
    funnel: r.funnel,
    rawSignalCount: r.rawSignals?.length ?? 0,
    adapterSignalCount: r.adapterSignals?.length ?? 0,
    rawSignals: r.rawSignals,
    adapterSignals: r.adapterSignals,
    nearMisses: r.nearMisses,
  })),
  totals: {
    rawSignals: funnelTotals.rawSignals,
    adapterSignals: funnelTotals.adapterSignals,
    cascadeEligible: funnelTotals.cascadeEligible,
  },
};

const outPath = OUT || path.join(__dirname, `.liq-cascade-replay-${SETUP}.json`);
try {
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
  summary.reportPath = outPath;
} catch (err) {
  summary.reportWriteError = String(err?.message || err);
}

console.log(JSON.stringify(summary, null, 2));

await closePool?.().catch(() => {});
