#!/usr/bin/env node
/**
 * Replay a saved strategy version through the backtest engine exactly as the UI
 * would, so a UI result can be reconciled against research numbers.
 *
 * Usage (backend/): node scripts/verify-saved-version-backtest.mjs <versionId> [from] [to]
 */
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env"), override: false });

const VERSION_ID = process.argv[2];
const FROM = Date.parse(process.argv[3] || "2026-01-01");
const TO = Date.parse(process.argv[4] || "2026-07-24");
if (!VERSION_ID) {
  console.error("usage: verify-saved-version-backtest.mjs <versionId> [from] [to]");
  process.exit(1);
}

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
if (!getPool?.()) await initPool({ info: () => {}, warn: () => {}, error: console.error });
const { query } = await import("../src/db/query.js");
const { sanitizeSignalBrainCfgRaw } = await import("../src/lib/strategySignalBrain.js");
const { mergeInstanceIntoCfgRaw } = await import("../src/lib/strategyInstanceSplit.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { readFundingRates } = await import("../src/backtest/data/fundingIngest.js");
const { runSimulation } = await import("../src/backtest/engine/runner.js");
const { computeAllMetrics } = await import("../src/backtest/engine/metrics.js");
const { clearIntradayAdapterCache } = await import("../src/backtest/engine/intradayAdapterCache.js");
const { buildIntradayBacktestAdapter } = await import("../src/strategy/intradayPro.js");
const { materializeIntradayPanelOnCfg } = await import("../src/strategy/intradayPanelKeys.js");
const { materializeIntradayEngineCfgSync } = await import("../src/strategy/presets/srIntradayOptimized.js");

const row = (await query(`SELECT cfg_raw FROM strategy_versions WHERE id=$1`, [VERSION_ID])).rows[0];
if (!row) throw new Error(`version ${VERSION_ID} not found`);

// The saved version deliberately omits instance-owned fields (market, risk,
// capital); the backtest route merges them from the bound instance, so do the same.
const inst = (
  await query(`SELECT * FROM bot_instances WHERE strategy_version_id=$1 AND is_deleted=false LIMIT 1`, [VERSION_ID])
).rows[0];
const hydrated = mergeInstanceIntoCfgRaw(sanitizeSignalBrainCfgRaw(row.cfg_raw, { hydrate: true }), inst);
const symbol = String(inst?.inst_symbol ?? "BNBUSDT");
const tf = String(inst?.inst_timeframe ?? "15m");
let cfg = {
  ...hydrated.bot,
  symbol,
  timeframe: tf,
  backtestPositionSizing: hydrated.bot.backtestPositionSizing ?? "RISK_AT_SL",
  backtestSignalStartMs: FROM,
};
cfg = materializeIntradayEngineCfgSync(cfg, materializeIntradayPanelOnCfg);

console.log("engine cfg (LIQ view):", JSON.stringify({
  manual: cfg.manualStrategy,
  liq: cfg.intradayGateLiquidity,
  smc: cfg.intradayGateSmcIct,
  playbook: cfg.intradayLiqPlaybook,
  daybias: cfg.intradayLiqDaySituationBias,
  mit: cfg.intradayLiqMitigationEntry,
  mitFrac: cfg.intradayLiqMitigationFrac,
  dispV2: cfg.intradayLiqRequireDisplacementV2,
  dispMult: cfg.intradayLiqSweepDisplacementMinAtrMult,
  minSl: cfg.intradayLiqMinSlPct,
}));

// Long warm-up: session/HTF/pivot state needs history well before the signal
// start or early-window signals are silently suppressed.
const pad = 550 * 864e5;
const candles = await readCandles(symbol, tf, FROM - pad, TO, { market: "futures" });
const funding = await readFundingRates(symbol, FROM - pad, TO).catch(() => []);
clearIntradayAdapterCache?.();
const adapter = buildIntradayBacktestAdapter(candles, cfg, tf);
const sim = await runSimulation({
  strategyKey: "SR_INTRADAY",
  candles,
  cfg,
  gateMode: "off",
  fundingRates: funding,
  startingUsdt: 100,
  timeframe: tf,
  adapters: { SR_INTRADAY: adapter, INTRADAY_PRO: adapter },
  symbol,
});

const trades = (sim.trades ?? [])
  .filter((t) => String(t.exitReason ?? "") !== "tp1_partial")
  .filter((t) => Number(t.entryTs) >= FROM && Number(t.entryTs) < TO);
let eq = 100;
const curve = [{ ts: FROM, equity: eq }];
for (const t of trades) {
  eq += Number(t.netPnl ?? 0);
  curve.push({ ts: Number(t.exitTs ?? t.entryTs), equity: eq });
}
const m = computeAllMetrics({ trades, equityCurve: curve, tf, startingEquity: 100 });
const weeks = Math.max(0.01, (TO - FROM) / (7 * 864e5));
console.log(
  `\nwindow ${new Date(FROM).toISOString().slice(0, 10)} → ${new Date(TO).toISOString().slice(0, 10)}`,
);
console.log(
  `n=${trades.length} tw=${(trades.length / weeks).toFixed(2)} ret=${Number(m.totalReturnPct ?? 0).toFixed(2)}% ` +
    `pf=${Number(m.profitFactor ?? 0).toFixed(3)} wr=${((m.winRate ?? 0) * 100).toFixed(1)}% ` +
    `dd=${Math.abs(m.maxDrawdownPct ?? 0).toFixed(2)}%`,
);
await closePool?.();
