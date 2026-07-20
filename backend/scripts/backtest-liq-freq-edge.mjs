#!/usr/bin/env node
/**
 * LIQ FREQ_EDGE stream — classical sweep+reclaim only (no trend continuation).
 * Compares legacy LIQ_15M vs per-coin FREQ_EDGE presets on honesty window.
 *
 * Usage (from backend/):
 *   node scripts/backtest-liq-freq-edge.mjs
 *   FROM=2025-01-01 TO=2026-06-01 SYMBOLS=BNBUSDT,ETHUSDT node scripts/backtest-liq-freq-edge.mjs
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
const SYMBOLS = (process.env.SYMBOLS || "BNBUSDT,ETHUSDT,BTCUSDT")
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
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { mergeAdaptiveCfg, buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { materializeIntradayEngineCfgSync } = await import("../src/strategy/presets/srIntradayOptimized.js");
const {
  INTRADAY_PRO_LIQ_15M,
  INTRADAY_PRO_LIQ_FREQ_EDGE_BNB_15M,
  INTRADAY_PRO_LIQ_FREQ_EDGE_ETH_15M,
  INTRADAY_PRO_LIQ_FREQ_EDGE_BTC_15M,
  fillLiqSoloPresetDefaults,
  fillFibSoloPresetDefaults,
  resolveLiqFreqEdgePreset,
} = await import("../src/strategy/presets/srIntradayOptimized.js");
const { buildTrailMicroContext } = await import("../src/backtest/engine/trailMicroSim.js");

const VARIANTS = [
  { id: "legacy", label: "LIQ_15M legacy (BNB base, no breakdown veto)", presetFor: () => INTRADAY_PRO_LIQ_15M },
  {
    id: "freq_edge",
    label: "FREQ_EDGE (classical only, breakdown veto, no trend cont.)",
    presetFor: (sym) => resolveLiqFreqEdgePreset(sym),
  },
];

function logicalTrades(trades) {
  const m = new Map();
  for (const t of trades) {
    const k = `${t.entryTs}_${t.direction}`;
    if (!m.has(k)) {
      m.set(k, { pnl: 0, r: 0, win: false, entryTs: t.entryTs, symbol: t.symbol });
    }
    const row = m.get(k);
    row.pnl += Number(t.netPnl ?? 0);
    if (Number.isFinite(Number(t.rMultiple))) row.r += Number(t.rMultiple);
    if (row.pnl > 0) row.win = true;
  }
  return [...m.values()];
}

async function runVariant(symbol, variant) {
  await ensureKlines(symbol, TF, { from: fromMs, to: toMs, market: "futures" });
  const padMs = 21 * 86_400_000;
  const candles = await readCandles(symbol, TF, fromMs - padMs, toMs);
  if (candles.length < 500) {
    return { symbol, variant: variant.id, error: `insufficient candles (${candles.length})` };
  }

  clearIntradayAdapterCache();
  const base = {
    ...variant.presetFor(symbol),
    symbol,
    timeframe: TF,
    manualStrategy: "SR_INTRADAY",
    strategyMode: "MANUAL",
    marketMode: "FUTURES",
    riskPerTrade: RISK,
    futuresLeverage: 12,
    backtestPositionSizing: "RISK_AT_SL",
    slippagePct: 0.0005,
    intradayGateLiquidity: true,
    intradayGateSession: false,
    intradayGateFib: false,
    intradayGateVp: false,
    intradayGateOrderFlow: false,
    intradayGateHtfRegime: false,
  };

  let cfg = materializeIntradayEngineCfgSync(
    fillLiqSoloPresetDefaults(fillFibSoloPresetDefaults(base)),
    materializeIntradayPanelOnCfg,
  );
  cfg = mergeAdaptiveCfg(cfg, candles);

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

  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: TF,
    symbol,
    adapters: { SR_INTRADAY: buildIntradayBacktestAdapter(candles, cfg, TF) },
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
  const rstats = rMultipleStats(windowTrades);

  return {
    symbol,
    variant: variant.id,
    label: variant.label,
    trades: logical.length,
    tradesPerWeek: +(logical.length / weeks).toFixed(2),
    tradesPerMonth: +((logical.length / days) * 30).toFixed(1),
    wr: +((m.winRate ?? 0) * 100).toFixed(1),
    ret: +(m.totalReturnPct ?? 0).toFixed(2),
    pf: +(m.profitFactor ?? 0).toFixed(2),
    dd: +Math.abs(m.maxDrawdownPct ?? 0).toFixed(2),
    calmar: +(m.calmarRatio ?? 0).toFixed(2),
    meanR: +(rstats.meanR ?? 0).toFixed(3),
    exitReasons: windowTrades.reduce((acc, t) => {
      const k = t.exitReason || "?";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {}),
    logical,
  };
}

console.log(`\n══ LIQ FREQ_EDGE honesty test ══`);
console.log(`${FROM} → ${TO}  (${days.toFixed(0)}d, ${weeks.toFixed(0)}w)  ${TF}  risk ${RISK}%\n`);

const rows = [];
for (const sym of SYMBOLS) {
  for (const variant of VARIANTS) {
    process.stderr.write(`Running ${sym} ${variant.id}…\n`);
    rows.push(await runVariant(sym, variant));
  }
}

console.log("Per-coin results:");
console.log("symbol     variant     tr   tr/wk  tr/mo   WR%    ret%    PF   DD%  meanR");
console.log("─".repeat(78));
for (const r of rows) {
  if (r.error) {
    console.log(`${r.symbol.padEnd(10)} ${r.variant.padEnd(11)} ERROR ${r.error}`);
    continue;
  }
  console.log(
    `${r.symbol.padEnd(10)} ${r.variant.padEnd(11)} ${String(r.trades).padStart(3)}  ${String(r.tradesPerWeek).padStart(5)}  ${String(r.tradesPerMonth).padStart(5)}  ${String(r.wr).padStart(5)}  ${String(r.ret).padStart(6)}  ${String(r.pf).padStart(4)}  ${String(r.dd).padStart(4)}  ${String(r.meanR).padStart(5)}`,
  );
}

const freqEdgeRows = rows.filter((r) => r.variant === "freq_edge" && !r.error);
const portfolioLogical = freqEdgeRows.flatMap((r) => r.logical ?? []);
const portfolioN = portfolioLogical.length;
const portfolioWins = portfolioLogical.filter((t) => t.win).length;
const portfolioR = portfolioLogical.reduce((a, t) => a + (t.r || 0), 0);

console.log(`\nPortfolio (FREQ_EDGE legs: ${SYMBOLS.filter((s) => freqEdgeRows.some((r) => r.symbol === s)).join("+")}):`);
console.log(`  trades: ${portfolioN}  (~${(portfolioN / weeks).toFixed(2)}/week, ~${((portfolioN / days) * 30).toFixed(1)}/month)`);
console.log(`  blended WR: ${portfolioN ? ((portfolioWins / portfolioN) * 100).toFixed(1) : 0}%`);
console.log(`  sum R (naive stack): ${portfolioR.toFixed(2)}`);

const targetMin = 2;
const targetMax = 5;
const meetsFreq = freqEdgeRows.filter((r) => r.tradesPerWeek >= targetMin && r.tradesPerWeek <= targetMax);
const meetsEdge = freqEdgeRows.filter((r) => r.ret > 0 && r.pf >= 1 && r.meanR > 0);

console.log(`\nTarget check (2–5 trades/week/coin, ret>0, PF≥1, meanR>0):`);
for (const r of freqEdgeRows) {
  const freqOk = r.tradesPerWeek >= targetMin && r.tradesPerWeek <= targetMax;
  const edgeOk = r.ret > 0 && r.pf >= 1 && r.meanR > 0;
  console.log(
    `  ${r.symbol}: freq ${freqOk ? "PASS" : "FAIL"} (${r.tradesPerWeek}/wk)  edge ${edgeOk ? "PASS" : "FAIL"} (ret ${r.ret}%, PF ${r.pf})`,
  );
}

const out = {
  window: `${FROM}→${TO}`,
  risk: RISK,
  symbols: SYMBOLS,
  rows,
  portfolio: {
    n: portfolioN,
    tradesPerWeek: +(portfolioN / weeks).toFixed(2),
    tradesPerMonth: +((portfolioN / days) * 30).toFixed(1),
    sumR: +portfolioR.toFixed(2),
  },
  target: { minTradesPerWeek: targetMin, maxTradesPerWeek: targetMax },
  meetsFreqCount: meetsFreq.length,
  meetsEdgeCount: meetsEdge.length,
};

const outPath = path.resolve(__dirname, ".liq-freq-edge-results.json");
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`\nWrote ${outPath}`);

await closePool?.();
