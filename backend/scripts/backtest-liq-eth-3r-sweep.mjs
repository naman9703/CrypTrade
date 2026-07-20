#!/usr/bin/env node
/** ETH liq 3R target sweep */
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
const { computeAllMetrics, rMultipleStats } = await import("../src/backtest/engine/metrics.js");
const { buildBacktestAdapters } = await import("../src/backtest/engine/signals/baselines.js");
const { INTRADAY_PRO_LIQ_ETH_15M, fillLiqSoloPresetDefaults, materializeIntradayEngineCfg } =
  await import("../src/strategy/presets/srIntradayOptimized.js");

const candles = await readCandles("ETHUSDT", "15m", fromMs - 21 * 86400000, toMs);

const VARIANTS = [
  { label: "current (rr1.25 partial+be)", patch: {} },
  {
    label: "3R full (no partial, BE@1R)",
    patch: {
      intradayLiqMinRr: 3,
      intradayLiqMaxTpRr: 3,
      intradayLiqTp1Enabled: false,
      intradayLiqPartialTp: false,
      intradayLiqBreakevenAfterPartial: true,
      trailingStopLossAuto: false,
    },
  },
  {
    label: "3R full no BE",
    patch: {
      intradayLiqMinRr: 3,
      intradayLiqMaxTpRr: 3,
      intradayLiqTp1Enabled: false,
      intradayLiqPartialTp: false,
      intradayLiqBreakevenAfterPartial: false,
      trailingStopLossAuto: false,
    },
  },
  {
    label: "3R partial25 @1R",
    patch: {
      intradayLiqMinRr: 3,
      intradayLiqMaxTpRr: 3,
      intradayLiqPartialFrac: 0.25,
      intradayLiqBreakevenAfterPartial: false,
      trailingStopLossAuto: false,
    },
  },
  {
    label: "3R partial33 trail runner",
    patch: {
      intradayLiqMinRr: 3,
      intradayLiqMaxTpRr: 3,
      intradayLiqPartialFrac: 0.33,
      intradayLiqBreakevenAfterPartial: false,
      trailingStopLossAuto: true,
      trailOnlyAfterPartialFill: true,
      futuresTrailingStopMode: "SUPERTREND",
      trailBufferRate: 0.005,
    },
  },
  {
    label: "2.5R min 3R cap full",
    patch: {
      intradayLiqMinRr: 2.5,
      intradayLiqMaxTpRr: 3,
      intradayLiqTp1Enabled: false,
      intradayLiqPartialTp: false,
      intradayLiqBreakevenAfterPartial: true,
    },
  },
  {
    label: "3R min 5R cap partial50 BE",
    patch: {
      intradayLiqMinRr: 3,
      intradayLiqMaxTpRr: 5,
      intradayLiqPartialFrac: 0.5,
      intradayLiqBreakevenAfterPartial: true,
    },
  },
];

function logicalTrades(trades) {
  const m = new Map();
  for (const t of trades) {
    if (t.entryTs < fromMs || t.entryTs >= toMs) continue;
    const k = `${t.entryTs}:${t.direction}`;
    if (!m.has(k)) m.set(k, { net: 0, exits: new Set() });
    const o = m.get(k);
    o.net += t.netPnl ?? 0;
    o.exits.add(t.exitReason);
  }
  return [...m.values()];
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
  const rs = rMultipleStats(inWin);
  const logical = logicalTrades(sim.trades);
  const exits = {};
  for (const t of inWin) exits[t.exitReason] = (exits[t.exitReason] || 0) + 1;
  console.log(
    `${v.label.padEnd(32)} n=${String(logical.length).padStart(3)} ret=${m.totalReturnPct?.toFixed(1).padStart(6)}% ` +
      `WR=${((m.winRate || 0) * 100).toFixed(0).padStart(3)}% expR=${(m.expectancyR ?? 0).toFixed(2).padStart(5)} ` +
      `avgR=${(rs.avgR ?? 0).toFixed(2).padStart(5)} PF=${(m.profitFactor ?? 0).toFixed(2)} exits=${JSON.stringify(exits)}`,
  );
}

await closePool?.();
