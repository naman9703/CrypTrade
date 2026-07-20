#!/usr/bin/env node
/** Detailed R analysis + expanded 3R sweep */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env"), override: false });

const FROM = process.env.FROM || "2026-01-01";
const TO = process.env.TO || "2026-06-01";
const fromMs = Date.parse(FROM);
const toMs = Date.parse(TO);

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { INTRADAY_PRO_LIQ_ETH_15M, fillLiqSoloPresetDefaults, materializeIntradayEngineCfg } =
  await import("../src/strategy/presets/srIntradayOptimized.js");

const candles = await readCandles("ETHUSDT", "15m", fromMs - 21 * 86400000, toMs);

const VARIANTS = [
  { label: "A current", patch: {} },
  {
    label: "B 3R no-partial BE@1R min2.5",
    patch: {
      intradayLiqMinRr: 2.5,
      intradayLiqMaxTpRr: 3,
      intradayLiqTp1Enabled: false,
      intradayLiqPartialTp: false,
      intradayLiqBreakevenAfterPartial: true,
      trailingStopLossAuto: false,
    },
  },
  {
    label: "C 3R partial25 no-BE min2",
    patch: {
      intradayLiqMinRr: 2,
      intradayLiqMaxTpRr: 3,
      intradayLiqPartialFrac: 0.25,
      intradayLiqBreakevenAfterPartial: false,
      trailingStopLossAuto: false,
    },
  },
  {
    label: "D 3R partial25 no-BE min2 hold96",
    patch: {
      intradayLiqMinRr: 2,
      intradayLiqMaxTpRr: 3,
      intradayLiqPartialFrac: 0.25,
      intradayLiqBreakevenAfterPartial: false,
      intradayLiqMaxHoldBars: 96,
      trailingStopLossAuto: false,
    },
  },
  {
    label: "E 3R full no-BE min2 hold96",
    patch: {
      intradayLiqMinRr: 2,
      intradayLiqMaxTpRr: 3,
      intradayLiqTp1Enabled: false,
      intradayLiqPartialTp: false,
      intradayLiqBreakevenAfterPartial: false,
      intradayLiqMaxHoldBars: 96,
      trailingStopLossAuto: false,
    },
  },
  {
    label: "F 3R min2 partial33 no-BE trail",
    patch: {
      intradayLiqMinRr: 2,
      intradayLiqMaxTpRr: 3,
      intradayLiqPartialFrac: 0.33,
      intradayLiqBreakevenAfterPartial: false,
      trailingStopLossAuto: true,
      trailOnlyAfterPartialFill: true,
      futuresTrailingStopMode: "SUPERTREND",
      trailBufferRate: 0.008,
    },
  },
  {
    label: "G 3R min2 no-partial BE@1R hold96",
    patch: {
      intradayLiqMinRr: 2,
      intradayLiqMaxTpRr: 3,
      intradayLiqTp1Enabled: false,
      intradayLiqPartialTp: false,
      intradayLiqBreakevenAfterPartial: true,
      intradayLiqMaxHoldBars: 96,
      trailingStopLossAuto: false,
    },
  },
];

function analyzeLogical(trades) {
  const m = new Map();
  for (const t of trades) {
    if (t.entryTs < fromMs || t.entryTs >= toMs) continue;
    const k = `${t.entryTs}:${t.direction}`;
    if (!m.has(k)) {
      m.set(k, {
        dir: t.direction,
        entry: t.entryPrice,
        sl: t.slPrice ?? t.stopPrice,
        net: 0,
        riskUsd: t.initialRiskUsd ?? t.riskUsd ?? 0,
        exits: [],
      });
    }
    const o = m.get(k);
    o.net += t.netPnl ?? 0;
    o.exits.push(t.exitReason);
    if (!o.riskUsd && t.initialRiskUsd) o.riskUsd = t.initialRiskUsd;
  }
  const rows = [...m.values()].map((o) => {
    const r = o.riskUsd > 0 ? o.net / o.riskUsd : null;
    return { ...o, r, win: o.net > 0 };
  });
  const wins = rows.filter((r) => r.win);
  const losses = rows.filter((r) => !r.win);
  const avgR = rows.reduce((s, r) => s + (r.r ?? 0), 0) / (rows.length || 1);
  const avgWinR = wins.reduce((s, r) => s + (r.r ?? 0), 0) / (wins.length || 1);
  const avgLossR = losses.reduce((s, r) => s + (r.r ?? 0), 0) / (losses.length || 1);
  return { rows, avgR, avgWinR, avgLossR, n: rows.length, wins: wins.length };
}

for (const v of VARIANTS) {
  const cfg = await materializeIntradayEngineCfg(
    fillLiqSoloPresetDefaults({
      ...INTRADAY_PRO_LIQ_ETH_15M,
      ...v.patch,
      supertrendFuturesUseFixedTp: true,
      backtestSignalStartMs: fromMs,
    }),
  );
  const adapters = await buildBacktestAdapters({
    strategyKey: "SR_INTRADAY",
    cfg,
    symbol: "ETHUSDT",
    tf: "15m",
    candles,
    fromMs: candles[0]?.ts,
  });
  const sim = await runSimulation({
    strategyKey: "SR_INTRADAY",
    candles,
    cfg,
    gateMode: "off",
    fundingRates: [],
    startingUsdt: 100,
    timeframe: "15m",
    symbol: "ETHUSDT",
    adapters,
  });
  const inWin = sim.trades.filter((t) => t.entryTs >= fromMs && t.entryTs < toMs);
  const m = computeAllMetrics({ trades: inWin, equityCurve: sim.equityCurve, tf: "15m", startingEquity: 100 });
  const a = analyzeLogical(sim.trades);
  const exits = {};
  for (const t of inWin) exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;
  const tp2 = a.rows.filter((r) => r.exits.includes("tp2") || r.exits.includes("tp")).length;
  console.log(
    `${v.label.padEnd(34)} n=${String(a.n).padStart(3)} ret=${m.totalReturnPct?.toFixed(1).padStart(6)}% ` +
      `avgR=${a.avgR.toFixed(2).padStart(6)} winR=${a.avgWinR.toFixed(2).padStart(5)} lossR=${a.avgLossR.toFixed(2).padStart(5)} ` +
      `tp2=${tp2} exits=${JSON.stringify(exits)}`,
  );
}

await closePool?.();
