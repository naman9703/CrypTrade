#!/usr/bin/env node
/**
 * LIQ + VP proximity experiment — fast path + sweep level near VP structure.
 * Compares: LIQ solo baseline vs proximity filters at 15/25/35 bp.
 *
 * Usage (from backend/):
 *   node scripts/backtest-liq-vp-proximity.mjs
 *   FROM=2025-01-01 TO=2026-06-01 SYMBOLS=BNBUSDT,ETHUSDT node scripts/backtest-liq-vp-proximity.mjs
 */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const FROM = process.env.FROM || "2025-01-01";
const TO = process.env.TO || "2026-06-01";
const TF = process.env.TF || "15m";
const RISK = Number(process.env.RISK || 2.5);
const SYMBOLS = (process.env.SYMBOLS || "BNBUSDT,ETHUSDT")
  .split(",")
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);
const days = Math.max(1, (toMs - fromMs) / 86_400_000);
const weeks = days / 7;

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });

const { ensureKlines, readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter, selectIntradayPicks } = await import(
  "../src/strategy/intradayPro.js",
);
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const {
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_LIQ_ETH_15M,
  resolveLiqVpProximityPreset,
  fillLiqSoloPresetDefaults,
  fillFibSoloPresetDefaults,
  materializeIntradayEngineCfgSync,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");

const PROXIMITY_VARIANTS = [
  { id: "proximity_15bp", label: "LIQ + VP proximity 0.15%", pct: 0.0015 },
  { id: "proximity_25bp", label: "LIQ + VP proximity 0.25%", pct: 0.0025 },
  { id: "proximity_35bp", label: "LIQ + VP proximity 0.35%", pct: 0.0035 },
];

function logicalTrades(trades) {
  const m = new Map();
  for (const t of trades) {
    const k = `${t.entryTs}_${t.direction}`;
    if (!m.has(k)) m.set(k, { pnl: 0, win: false });
    const row = m.get(k);
    row.pnl += Number(t.netPnl ?? 0);
    if (row.pnl > 0) row.win = true;
  }
  return [...m.values()];
}

function variantsForSymbol(sym) {
  const liqBase = sym === "ETHUSDT" ? INTRADAY_PRO_LIQ_ETH_15M : INTRADAY_PRO_LIQ_15M;
  const solo = {
    id: "liq_solo",
    label: "LIQ solo baseline",
    preset: {
      ...liqBase,
      intradayGateLiquidity: true,
      intradayGateSession: false,
      intradayGateVp: false,
      intradayGateFib: false,
      intradayGateOrderFlow: false,
      intradayGateHtfRegime: false,
      intradayLiqVpProximityMaxPct: 0,
    },
  };
  const proximity = PROXIMITY_VARIANTS.map((v) => ({
    id: v.id,
    label: v.label,
    preset: resolveLiqVpProximityPreset(sym, v.pct),
  }));
  return [solo, ...proximity];
}

async function runVariant(symbol, variant) {
  await ensureKlines(symbol, TF, { from: fromMs, to: toMs, market: "futures" });
  const padMs = 21 * 86_400_000;
  const candles = await readCandles(symbol, TF, fromMs - padMs, toMs);
  if (candles.length < 500) return { symbol, variant: variant.id, error: `candles=${candles.length}` };

  clearIntradayAdapterCache();
  const base = {
    ...variant.preset,
    symbol,
    timeframe: TF,
    marketMode: "FUTURES",
    strategyMode: "MANUAL",
    manualStrategy: "SR_INTRADAY",
    riskPerTrade: RISK,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
  };

  let cfg = materializeIntradayEngineCfgSync(
    fillLiqSoloPresetDefaults(fillFibSoloPresetDefaults(base)),
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, candles);

  const picks = selectIntradayPicks(candles, cfg);
  const trailMicro =
    cfg.trailingStopLossAuto === true
      ? await buildTrailMicroContext({
          symbol,
          fromMs: fromMs - padMs,
          toMs,
          cfg,
          trailEnabled: true,
        })
      : null;

  const adapters = { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) };
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    symbol,
    adapters,
    trailMicro,
    costModelOverride: { leverage: 12, openFeeRate: 0.0004, closeFeeRate: 0.0004, slippagePct: 0.0005 },
  });

  const windowTrades = sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
  const logical = logicalTrades(windowTrades);
  const m = computeAllMetrics({
    trades: windowTrades,
    equityCurve: sim.equityCurve,
    tf: TF,
    startingEquity: 100,
  });

  const exitReasons = windowTrades.reduce((acc, t) => {
    const k = t.exitReason || "?";
    acc[k] = (acc[k] || 0) + 1;
    return acc;
  }, {});

  return {
    symbol,
    variant: variant.id,
    label: variant.label,
    picks: picks.pickedCount,
    candidates: picks.candidateCount,
    trades: logical.length,
    tradesPerWeek: +(logical.length / weeks).toFixed(2),
    tradesPerMonth: +((logical.length / days) * 30).toFixed(1),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    exitReasons,
  };
}

console.log(`\n══ LIQ + VP PROXIMITY experiment ══`);
console.log(`${FROM} → ${TO}  (${Math.round(days)}d)  ${TF}  risk ${RISK}%\n`);

const rows = [];
for (const sym of SYMBOLS) {
  for (const v of variantsForSymbol(sym)) {
    process.stderr.write(`Running ${sym} ${v.id}…\n`);
    rows.push(await runVariant(sym, v));
  }
}

function pad(s, w) {
  return String(s).padEnd(w);
}

console.log("Results:");
console.log(
  `${pad("symbol", 10)} ${pad("variant", 22)} ${pad("tr", 4)} ${pad("tr/wk", 6)} ${pad("WR%", 6)} ${pad("ret%", 8)} ${pad("PF", 6)} ${pad("DD%", 6)} picks`,
);
console.log("─".repeat(90));
for (const r of rows) {
  if (r.error) {
    console.log(`${pad(r.symbol, 10)} ${pad(r.variant, 22)} ERROR ${r.error}`);
    continue;
  }
  console.log(
    `${pad(r.symbol, 10)} ${pad(r.variant, 22)} ${pad(r.trades, 4)} ${pad(r.tradesPerWeek.toFixed(2), 6)} ${pad(r.wr.toFixed(1), 6)} ${pad(r.ret.toFixed(2), 8)} ${pad(r.pf.toFixed(2), 6)} ${pad(r.dd.toFixed(2), 6)} ${r.picks}`,
  );
}

const baselineBySym = Object.fromEntries(
  SYMBOLS.map((s) => [s, rows.find((r) => r.symbol === s && r.variant === "liq_solo")]),
);
console.log("\nProximity vs LIQ solo:");
for (const sym of SYMBOLS) {
  const base = baselineBySym[sym];
  const best = [...rows]
    .filter((r) => r.symbol === sym && r.variant !== "liq_solo")
    .sort((a, b) => b.ret - a.ret || b.pf - a.pf)[0];
  if (!base || !best) continue;
  const freqPct = base.trades ? ((best.trades / base.trades) * 100).toFixed(0) : "—";
  console.log(
    `  ${sym}: LIQ ${base.trades}t/${base.tradesPerWeek.toFixed(2)}wk ret=${base.ret.toFixed(2)}% PF=${base.pf.toFixed(2)} → ${best.variant} ${best.trades}t (${freqPct}% freq) ret=${best.ret.toFixed(2)}% PF=${best.pf.toFixed(2)}`,
  );
}

const outPath = path.join(__dirname, ".liq-vp-proximity-results.json");
fs.writeFileSync(
  outPath,
  JSON.stringify(
    {
      window: `${FROM}→${TO}`,
      risk: RISK,
      symbols: SYMBOLS,
      rows,
      target: { minTradesPerWeek: 2, minReturnPct: 0, minPf: 1, minFreqRetainPct: 50 },
    },
    null,
    2,
  ),
);
console.log(`\nWrote ${outPath}`);

await closePool?.();
