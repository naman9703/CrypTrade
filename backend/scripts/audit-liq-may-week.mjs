#!/usr/bin/env node
/** Compare May 19–27 strict liquidity picks vs backtest run trades. */
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const { initPool, closePool, getPool } = await import("../src/db/pool.js");
const { readCandles } = await import("../src/backtest/data/klineIngest.js");
const { selectIntradayPicks, precomputeIntraday } = await import("../src/strategy/intradayPro.js");
const { fillLiqSoloPresetDefaults, INTRADAY_PRO_LIQ_15M } = await import("../src/strategy/presets/srIntradayOptimized.js");
const { utcDayId } = await import("../src/strategy/techniques/liquidity.js");

const fromMs = Date.parse("2026-05-19T00:00:00Z");
const toMs = Date.parse("2026-05-27T00:00:00Z");

await initPool({ info: () => {}, warn: () => {}, error: console.error });
const pool = getPool();

const runIdArg = process.argv.find((x) => x.startsWith("--run-id="))?.split("=")[1];
let runId = runIdArg;
if (!runId) {
  runId = (
    await pool.query(
      `SELECT id FROM backtest_runs WHERE status='done' ORDER BY finished_at DESC NULLS LAST LIMIT 1`,
    )
  ).rows[0]?.id;
}

const candles = await readCandles("BNBUSDT", "15m", fromMs - 5 * 86400000, toMs);
const cfg = fillLiqSoloPresetDefaults({
  ...INTRADAY_PRO_LIQ_15M,
  symbol: "BNBUSDT",
  timeframe: "15m",
});

const { series, pickedCount } = selectIntradayPicks(candles, cfg);
const picks = [];
for (let i = 0; i < candles.length; i++) {
  const sig = series[i];
  if (!sig || candles[i].ts < fromMs || candles[i].ts >= toMs) continue;
  picks.push({
    ts: candles[i].ts,
    iso: new Date(candles[i].ts).toISOString().slice(0, 16),
    side: sig.action,
    type: sig.liqBrackets?.levelType,
    q: sig.liqBrackets?.liqQuality,
  });
}

let runTrades = [];
if (runId) {
  const { rows } = await pool.query(
    `SELECT trade_number, direction, entry_time, exit_reason, net_pnl, signal_context
     FROM backtest_trades WHERE backtest_run_id = $1 ORDER BY trade_number`,
    [runId],
  );
  const seen = new Set();
  for (const t of rows) {
    const key = `${new Date(t.entry_time).toISOString().slice(0, 16)}:${t.direction}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (new Date(t.entry_time).getTime() < fromMs || new Date(t.entry_time).getTime() >= toMs) continue;
    runTrades.push({
      iso: new Date(t.entry_time).toISOString().slice(0, 16),
      side: t.direction,
      exit: t.exit_reason,
      pnl: Number(t.net_pnl),
    });
  }
}

console.log("=== Strict picks (May 19–27) ===", picks.length, "pickedCount", pickedCount);
for (const p of picks) {
  console.log(`  ${p.iso} ${p.side} ${p.type} q=${p.q?.toFixed?.(0)}`);
}

console.log("\n=== Run trades (unique entries) ===", runTrades.length);
for (const t of runTrades) {
  console.log(`  ${t.iso} ${t.side} ${t.exit} pnl=${t.pnl.toFixed(2)}`);
}

const pickSet = new Set(picks.map((p) => `${p.iso}:${p.side}`));
const tradeSet = new Set(runTrades.map((t) => `${t.iso}:${t.side}`));
console.log("\n=== In picks but NOT in run ===");
for (const k of pickSet) if (!tradeSet.has(k)) console.log("  MISSING", k);
console.log("=== In run but NOT in strict picks ===");
for (const k of tradeSet) if (!pickSet.has(k)) console.log("  EXTRA", k);

await closePool();
